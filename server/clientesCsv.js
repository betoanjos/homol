// Exportação da base de clientes em CSV — lógica pura, sem banco, para ser
// testável isoladamente (mesmo padrão de contratos/validacao.js).
//
// Serve para importar a base em ferramenta de campanha (Brevo), onde o envio
// promocional deve acontecer — e não pelo caminho transacional do sistema, que
// é o mesmo do código 2FA e do alerta de login. Disparar centenas de e-mails
// promocionais por ali estraga a reputação do remetente e depois o código de
// acesso deixa de chegar na caixa de entrada.

// Validação deliberadamente frouxa: o objetivo é descartar lixo evidente
// (vazio, sem @, sem domínio), não julgar endereço exótico. Um endereço válido
// recusado aqui vira cliente que não recebe a campanha.
export function emailUtilizavel(valor) {
  const e = String(valor || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Escapa um campo para CSV: aspas duplicadas e o valor entre aspas quando
// contiver separador, aspas ou quebra de linha.
export function campoCsv(valor) {
  const s = String(valor ?? '').replace(/\r?\n/g, ' ').trim();
  return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const TIPOS = { pos: 'Pós-pago', pre: 'Pré-pago', avulso: 'Avulso' };

const chaveEmail = v => String(v || '').trim().toLowerCase();
const chaveRfid  = v => String(v || '').trim().toLowerCase();
const chaveDoc   = v => String(v || '').replace(/\D/g, '');

// Quantas recargas cada cliente fez.
//
// O vínculo segue a mesma ordem usada no painel: clienteId primeiro, depois
// RFID, depois e-mail. Recarga que veio da API da Tupi nasce só com e-mail e
// só ganha clienteId depois da classificação, então contar apenas por id
// deixaria de fora justamente o cliente recorrente que se quer alcançar.
export function contarRecargasPorCliente(clientes = [], vinculos = []) {
  const porId = new Set();
  const porRfid = new Map();
  const porEmail = new Map();

  (clientes || []).forEach(c => {
    if (!c || !c.id) return;
    porId.add(c.id);
    if (c.rfid)  porRfid.set(chaveRfid(c.rfid), c.id);
    if (c.email) porEmail.set(chaveEmail(c.email), c.id);
  });

  const contagem = new Map();
  (vinculos || []).forEach(v => {
    if (!v) return;
    let cid = v.clienteId && porId.has(v.clienteId) ? v.clienteId : null;
    if (!cid && v.rfid)  cid = porRfid.get(chaveRfid(v.rfid)) || null;
    if (!cid && v.email) cid = porEmail.get(chaveEmail(v.email)) || null;
    if (!cid) return;
    contagem.set(cid, (contagem.get(cid) || 0) + 1);
  });
  return contagem;
}

// UF de cada cliente. O cadastro daqui só tem endereço em texto livre, então
// o estado vem dos dados de usuário da Tupi, casados por e-mail ou documento.
export function ufPorCliente(clientes = [], ufs = {}) {
  const porEmail = ufs.porEmail || {};
  const porDocumento = ufs.porDocumento || {};
  const mapa = new Map();
  (clientes || []).forEach(c => {
    if (!c || !c.id) return;
    const uf = porEmail[chaveEmail(c.email)] || porDocumento[chaveDoc(c.doc)] || '';
    if (uf) mapa.set(c.id, String(uf).trim().toUpperCase());
  });
  return mapa;
}

// Monta o CSV. Deduplica por e-mail: um mesmo endereço em dois cadastros
// viraria duas mensagens para a mesma pessoa, que é como se perde descadastro
// e reputação de remetente.
export function montarCsvClientes(clientes = [], grupos = [], opcoes = {}) {
  const nomeGrupo = id => (grupos || []).find(g => g && g.id === id)?.nome || '';
  const contagens = opcoes.contagens instanceof Map ? opcoes.contagens : new Map();
  const ufs = opcoes.ufs instanceof Map ? opcoes.ufs : new Map();
  const minRecargas = Math.max(0, Number(opcoes.minRecargas || 0));
  const ufFiltro = String(opcoes.uf || '').trim().toUpperCase();

  const vistos = new Set();
  const linhas = [];
  let semEmail = 0;
  let duplicados = 0;
  let foraDoFiltro = 0;
  let semUfConhecida = 0;

  (clientes || []).forEach(c => {
    if (!c) return;
    const email = String(c.email || '').trim().toLowerCase();
    if (!emailUtilizavel(email)) { semEmail++; return; }
    if (vistos.has(email)) { duplicados++; return; }

    const recargas = contagens.get(c.id) || 0;
    const uf = ufs.get(c.id) || '';
    if (!uf) semUfConhecida++;

    // Filtro por UF descarta quem não tem estado conhecido: incluir "talvez
    // seja do Paraná" num recorte regional é o mesmo que não ter recorte.
    if (minRecargas && recargas < minRecargas) { foraDoFiltro++; return; }
    if (ufFiltro && uf !== ufFiltro) { foraDoFiltro++; return; }

    vistos.add(email);
    linhas.push([
      campoCsv(email),
      campoCsv(c.nome || ''),
      campoCsv(c.telefone || ''),
      campoCsv(TIPOS[c.tipo] || ''),
      campoCsv(nomeGrupo(c.grupoId)),
      campoCsv(recargas),
      campoCsv(uf)
    ].join(','));
  });

  // EMAIL como primeira coluna e nesse nome é o que o Brevo reconhece sozinho
  // na importação.
  const cabecalho = 'EMAIL,NOME,TELEFONE,TIPO,GRUPO,RECARGAS,UF';
  return {
    csv: [cabecalho, ...linhas].join('\r\n') + '\r\n',
    total: linhas.length,
    semEmail,
    duplicados,
    foraDoFiltro,
    semUfConhecida
  };
}
