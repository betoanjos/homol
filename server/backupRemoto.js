// ═══════════════════════════════════════════════════════════════════════════
//  ENVIO DO BACKUP PARA FORA DO CONTAINER
//
//  O backup automatico grava em BACKUP_DIR, que por padrao fica dentro do
//  container. No Railway esse sistema de arquivos e efemero: cada deploy ou
//  restart apaga tudo. Na pratica o job rodava, gravava e o resultado sumia —
//  pior do que nao ter backup, porque aparentava ter.
//
//  Este modulo envia cada arquivo gerado para um bucket S3-compativel (S3,
//  Cloudflare R2, Backblaze B2, MinIO, Wasabi). A assinatura AWS SigV4 e
//  implementada aqui com crypto para nao adicionar dependencia ao projeto —
//  o SDK da AWS pesa mais que o app inteiro.
//
//  Configuracao (Variables do Railway):
//    BACKUP_S3_ENDPOINT           https://s3.us-east-1.amazonaws.com
//                                 https://<conta>.r2.cloudflarestorage.com
//    BACKUP_S3_BUCKET             nome do bucket
//    BACKUP_S3_REGION             padrao us-east-1 (R2 usa "auto")
//    BACKUP_S3_ACCESS_KEY_ID
//    BACKUP_S3_SECRET_ACCESS_KEY
//    BACKUP_S3_PREFIX             opcional, ex. "evparking/"
//
//  Sem essas variaveis o envio fica desligado e o backup segue apenas local —
//  mas o status passa a dizer isso em voz alta, em vez de silenciar.
// ═══════════════════════════════════════════════════════════════════════════
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const ALGORITMO = 'AWS4-HMAC-SHA256';

const sha256hex = buf => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (chave, dado) => crypto.createHmac('sha256', chave).update(dado).digest();

export function s3Config() {
  return {
    endpoint: (process.env.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''),
    bucket: process.env.BACKUP_S3_BUCKET || '',
    region: process.env.BACKUP_S3_REGION || 'us-east-1',
    accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY || '',
    prefix: process.env.BACKUP_S3_PREFIX || ''
  };
}

export function backupRemotoConfigurado(cfg = s3Config()) {
  return Boolean(cfg.endpoint && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
}

// Codificacao exigida pelo SigV4: RFC 3986, preservando as barras do caminho.
export function encodeCaminho(caminho) {
  return String(caminho)
    .split('/')
    .map(seg => encodeURIComponent(seg).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

// Assina uma requisicao no formato AWS Signature Version 4.
// Exportada separadamente porque e a parte com regras exatas — e a parte que
// os testes conseguem verificar sem rede, contra os vetores oficiais da AWS.
export function assinarSigV4({
  method,
  host,
  caminho,
  query = '',
  payloadHash,
  region,
  service = 's3',
  accessKeyId,
  secretAccessKey,
  data = new Date(),
  headersExtras = {}
}) {
  const amzDate = data.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20150830T123600Z
  const dataCurta = amzDate.slice(0, 8);                            // 20150830
  const escopo = `${dataCurta}/${region}/${service}/aws4_request`;

  // Cabecalhos assinados: sempre host e x-amz-date, mais os extras informados.
  const headers = { host, 'x-amz-date': amzDate, ...headersExtras };
  const nomes = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonicalHeaders = nomes
    .map(n => {
      const chave = Object.keys(headers).find(h => h.toLowerCase() === n);
      return `${n}:${String(headers[chave]).trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');
  const signedHeaders = nomes.join(';');

  const canonicalRequest = [
    method,
    encodeCaminho(caminho),
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const stringToSign = [ALGORITMO, amzDate, escopo, sha256hex(canonicalRequest)].join('\n');

  const kData = hmac(`AWS4${secretAccessKey}`, dataCurta);
  const kRegion = hmac(kData, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = `${ALGORITMO} Credential=${accessKeyId}/${escopo}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, amzDate, signature, canonicalRequest, stringToSign, signedHeaders, escopo };
}

// Envia um arquivo local para o bucket. Devolve a chave gravada.
export async function enviarArquivo(caminhoLocal, { cfg = s3Config(), nomeRemoto = null } = {}) {
  if (!backupRemotoConfigurado(cfg)) throw new Error('Armazenamento remoto de backup nao configurado.');

  const corpo = await fs.readFile(caminhoLocal);
  const nome = nomeRemoto || path.basename(caminhoLocal);
  const chave = `${cfg.prefix}${nome}`.replace(/^\/+/, '');
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${encodeCaminho(chave)}`);
  const payloadHash = sha256hex(corpo);

  const { authorization, amzDate } = assinarSigV4({
    method: 'PUT',
    host: url.host,
    caminho: `/${cfg.bucket}/${chave}`,
    payloadHash,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    headersExtras: { 'x-amz-content-sha256': payloadHash }
  });

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Content-Length': String(corpo.length)
    },
    body: corpo
  });

  if (!res.ok) {
    const detalhe = await res.text().catch(() => '');
    throw new Error(`Falha ao enviar backup (HTTP ${res.status}): ${detalhe.slice(0, 300)}`);
  }
  return chave;
}

// Envia a lista de arquivos do backup recem-criado. Nunca lanca: o resultado
// vira parte do status, para que uma falha de envio fique visivel sem derrubar
// o backup local que ja foi gravado com sucesso.
export async function enviarBackup(arquivos = []) {
  const cfg = s3Config();
  if (!backupRemotoConfigurado(cfg)) {
    return {
      configurado: false,
      ok: false,
      enviados: [],
      erro: 'Armazenamento remoto nao configurado: o backup existe apenas dentro do container e sera perdido no proximo deploy.'
    };
  }

  const enviados = [];
  const falhas = [];
  for (const arquivo of arquivos.filter(Boolean)) {
    try {
      enviados.push(await enviarArquivo(arquivo, { cfg }));
    } catch (err) {
      falhas.push({ arquivo: path.basename(arquivo), erro: err.message });
    }
  }

  return {
    configurado: true,
    ok: falhas.length === 0,
    destino: `${cfg.endpoint}/${cfg.bucket}`,
    enviados,
    falhas,
    erro: falhas.length ? falhas.map(f => `${f.arquivo}: ${f.erro}`).join(' | ') : null
  };
}
