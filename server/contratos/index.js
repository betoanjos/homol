import express from 'express';
import crypto from 'crypto';
import pool from '../db.js';
import { assinaturaConfig, criarDocumentoZapSign, detalharDocumentoZapSign, baixarArquivoZapSign } from './zapsign.js';
import { calcularPremissas, normalizarDadosContrato, validarDadosContrato } from './validacao.js';

const MODELO_CODIGO = 'parceria-estacao-recarga';
const MODELO_VERSAO = 1;
const STATUS_EDITAVEIS = new Set(['rascunho', 'em_revisao']);

const admin = (req, res) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Apenas administradores podem executar esta ação.' });
    return false;
  }
  return true;
};

const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const nomeSeguro = valor => String(valor || 'contrato').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 100);

async function evento(contratoId, tipo, req, payload = {}) {
  await pool.query(
    `INSERT INTO contrato_eventos (contrato_id, tipo, usuario_id, usuario_nome, ip, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [contratoId, tipo, req.user?.id || null, req.user?.username || 'webhook', req.ip || null, payload]
  );
}

export async function initContratosDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contratos (
      id UUID PRIMARY KEY,
      parceiro_id TEXT NOT NULL,
      estacao_id TEXT,
      numero TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'rascunho',
      modelo_codigo TEXT NOT NULL,
      modelo_versao INTEGER NOT NULL,
      dados JSONB NOT NULL,
      calculos JSONB NOT NULL,
      pdf_original BYTEA,
      pdf_original_hash TEXT,
      pdf_assinado BYTEA,
      pdf_assinado_hash TEXT,
      certificado BYTEA,
      provider TEXT NOT NULL DEFAULT 'zapsign',
      provider_document_token TEXT,
      provider_payload JSONB,
      criado_por INTEGER REFERENCES app_users(id),
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      aprovado_em TIMESTAMPTZ,
      enviado_em TIMESTAMPTZ,
      concluido_em TIMESTAMPTZ,
      cancelado_em TIMESTAMPTZ
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contratos_parceiro ON contratos (parceiro_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contratos_status ON contratos (status);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contrato_numeracao (
      ano INTEGER PRIMARY KEY,
      ultimo INTEGER NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contrato_signatarios (
      id SERIAL PRIMARY KEY,
      contrato_id UUID NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
      papel TEXT NOT NULL,
      nome TEXT NOT NULL,
      cpf TEXT,
      email TEXT NOT NULL,
      telefone TEXT,
      provider_signer_token TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      assinado_em TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contrato_eventos (
      id BIGSERIAL PRIMARY KEY,
      contrato_id UUID REFERENCES contratos(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,
      usuario_id INTEGER REFERENCES app_users(id),
      usuario_nome TEXT,
      ip TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contrato_webhooks (
      id BIGSERIAL PRIMARY KEY,
      payload_hash TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL,
      payload JSONB NOT NULL,
      recebido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processado_em TIMESTAMPTZ,
      erro TEXT
    );
  `);
}

// Incluído no backup JSON já existente do EVCore. Os PDFs são codificados em
// base64 para que o backup continue completo mesmo quando pg_dump não estiver
// disponível no ambiente de hospedagem.
export async function exportarContratosBackup() {
  const [contratos, signatarios, eventos] = await Promise.all([
    pool.query(`SELECT id, parceiro_id, estacao_id, numero, status, modelo_codigo, modelo_versao,
      dados, calculos, pdf_original_hash, pdf_assinado_hash, provider, provider_document_token,
      provider_payload, criado_por, criado_em, atualizado_em, aprovado_em, enviado_em, concluido_em,
      cancelado_em, encode(pdf_original,'base64') AS pdf_original_base64,
      encode(pdf_assinado,'base64') AS pdf_assinado_base64,
      encode(certificado,'base64') AS certificado_base64 FROM contratos ORDER BY criado_em`),
    pool.query(`SELECT contrato_id, papel, nome, cpf, email, telefone, provider_signer_token,
      status, assinado_em FROM contrato_signatarios ORDER BY id`),
    pool.query(`SELECT contrato_id, tipo, usuario_id, usuario_nome, ip, payload, criado_em
      FROM contrato_eventos ORDER BY id`),
  ]);
  return { exportadoEm: new Date().toISOString(), contratos: contratos.rows, signatarios: signatarios.rows, eventos: eventos.rows };
}

async function proximoNumero() {
  const ano = new Date().getFullYear();
  const r = await pool.query(`INSERT INTO contrato_numeracao (ano, ultimo) VALUES ($1, 1)
    ON CONFLICT (ano) DO UPDATE SET ultimo = contrato_numeracao.ultimo + 1 RETURNING ultimo`, [ano]);
  return `EVP-${ano}-${String(r.rows[0].ultimo).padStart(4, '0')}`;
}

async function buscarContrato(id, comPdf = false) {
  const colunasPdf = comPdf ? ', pdf_original, pdf_assinado, certificado' : '';
  const r = await pool.query(`SELECT id, parceiro_id, estacao_id, numero, status, modelo_codigo, modelo_versao,
    dados, calculos, pdf_original_hash, pdf_assinado_hash, provider, provider_document_token,
    criado_em, atualizado_em, aprovado_em, enviado_em, concluido_em, cancelado_em ${colunasPdf}
    FROM contratos WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function sincronizarSignatarios(contratoId, dados) {
  await pool.query('DELETE FROM contrato_signatarios WHERE contrato_id = $1', [contratoId]);
  const integradorNome = String(process.env.EVPARKING_SIGNER_NAME || 'Roberto Nascimento Anjos').trim();
  const integradorEmail = String(process.env.EVPARKING_SIGNER_EMAIL || '').trim().toLowerCase();
  const signatarios = [
    { papel: 'parceiro', nome: dados.representanteNome, cpf: dados.representanteCpf, email: dados.representanteEmail, telefone: dados.representanteTelefone },
  ];
  if (integradorEmail) signatarios.push({ papel: 'integrador', nome: integradorNome, cpf: String(process.env.EVPARKING_SIGNER_CPF || ''), email: integradorEmail, telefone: String(process.env.EVPARKING_SIGNER_PHONE || '') });
  for (const s of signatarios) {
    await pool.query(`INSERT INTO contrato_signatarios (contrato_id, papel, nome, cpf, email, telefone)
      VALUES ($1, $2, $3, $4, $5, $6)`, [contratoId, s.papel, s.nome, s.cpf, s.email, s.telefone]);
  }
}

export function criarContratosRouter() {
  const router = express.Router();

  router.get('/meta', async (_req, res) => {
    try {
      const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
      const state = r.rows[0]?.data || {};
      res.json({
        parceiros: Array.isArray(state.parceiros) ? state.parceiros : [],
        estacoes: Array.isArray(state.estacoes) ? state.estacoes : [],
        assinatura: assinaturaConfig(),
        modelo: { codigo: MODELO_CODIGO, versao: MODELO_VERSAO },
        integrador: {
          razaoSocial: 'EV PARKING LTDA', cnpj: '67.097.035/0001-61',
          representante: process.env.EVPARKING_SIGNER_NAME || 'Roberto Nascimento Anjos',
          cpf: process.env.EVPARKING_SIGNER_CPF || '046.463.569-10',
          emailConfigurado: Boolean(process.env.EVPARKING_SIGNER_EMAIL),
        },
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/', async (req, res) => {
    try {
      const status = String(req.query.status || '').trim();
      const params = [];
      const where = status ? 'WHERE c.status = $1' : '';
      if (status) params.push(status);
      const r = await pool.query(`SELECT c.id, c.numero, c.status, c.parceiro_id, c.estacao_id,
        c.dados->>'razaoSocial' AS parceiro_nome, c.dados->>'representanteNome' AS representante_nome,
        c.pdf_original_hash, c.pdf_assinado_hash, c.provider_document_token,
        c.criado_em, c.atualizado_em, c.enviado_em, c.concluido_em
        FROM contratos c ${where} ORDER BY c.criado_em DESC LIMIT 500`, params);
      res.json({ contratos: r.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const contrato = await buscarContrato(req.params.id);
      if (!contrato) return res.status(404).json({ error: 'Contrato não encontrado.' });
      const [signatarios, eventos] = await Promise.all([
        pool.query(`SELECT id, papel, nome, cpf, email, telefone, status, assinado_em FROM contrato_signatarios WHERE contrato_id = $1 ORDER BY id`, [contrato.id]),
        pool.query(`SELECT tipo, usuario_nome, criado_em, payload FROM contrato_eventos WHERE contrato_id = $1 ORDER BY id DESC LIMIT 100`, [contrato.id]),
      ]);
      res.json({ contrato, signatarios: signatarios.rows, eventos: eventos.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/', async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const validacao = validarDadosContrato(req.body?.dados);
      if (!validacao.ok) return res.status(400).json({ error: validacao.erros.join(' '), errors: validacao.erros });
      const id = crypto.randomUUID();
      const numero = await proximoNumero();
      const calculos = calcularPremissas(validacao.dados);
      await pool.query(`INSERT INTO contratos
        (id, parceiro_id, estacao_id, numero, modelo_codigo, modelo_versao, dados, calculos, criado_por)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, validacao.dados.parceiroId, validacao.dados.estacaoId || null, numero, MODELO_CODIGO, MODELO_VERSAO, validacao.dados, calculos, req.user.id]);
      await sincronizarSignatarios(id, validacao.dados);
      await evento(id, 'contrato_criado', req, { numero });
      res.status(201).json({ id, numero, status: 'rascunho', dados: validacao.dados, calculos });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.put('/:id', async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const atual = await buscarContrato(req.params.id);
      if (!atual) return res.status(404).json({ error: 'Contrato não encontrado.' });
      if (!STATUS_EDITAVEIS.has(atual.status)) return res.status(409).json({ error: 'Este contrato está bloqueado e não pode mais ser editado.' });
      const validacao = validarDadosContrato(req.body?.dados);
      if (!validacao.ok) return res.status(400).json({ error: validacao.erros.join(' '), errors: validacao.erros });
      const calculos = calcularPremissas(validacao.dados);
      await pool.query(`UPDATE contratos SET parceiro_id=$2, estacao_id=$3, dados=$4, calculos=$5,
        pdf_original=NULL, pdf_original_hash=NULL, status='rascunho', atualizado_em=NOW() WHERE id=$1`,
        [atual.id, validacao.dados.parceiroId, validacao.dados.estacaoId || null, validacao.dados, calculos]);
      await sincronizarSignatarios(atual.id, validacao.dados);
      await evento(atual.id, 'contrato_atualizado', req);
      res.json({ ok: true, dados: validacao.dados, calculos });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/:id/pdf', express.json({ limit: '20mb' }), async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const atual = await buscarContrato(req.params.id);
      if (!atual) return res.status(404).json({ error: 'Contrato não encontrado.' });
      if (!STATUS_EDITAVEIS.has(atual.status)) return res.status(409).json({ error: 'Contrato bloqueado.' });
      const bruto = String(req.body?.base64 || '').replace(/^data:application\/pdf;base64,/, '');
      const pdf = Buffer.from(bruto, 'base64');
      if (pdf.length < 1000 || pdf.subarray(0, 4).toString() !== '%PDF') return res.status(400).json({ error: 'PDF inválido.' });
      if (pdf.length > 15 * 1024 * 1024) return res.status(413).json({ error: 'PDF excede 15 MB.' });
      const pdfHash = hash(pdf);
      const dadosHash = hash(Buffer.from(JSON.stringify(atual.dados)));
      await pool.query(`UPDATE contratos SET pdf_original=$2, pdf_original_hash=$3, status='em_revisao', atualizado_em=NOW() WHERE id=$1`, [atual.id, pdf, pdfHash]);
      await evento(atual.id, 'pdf_gerado', req, { sha256: pdfHash, dadosSha256: dadosHash, bytes: pdf.length });
      res.json({ ok: true, sha256: pdfHash, dadosSha256: dadosHash, tamanho: pdf.length, status: 'em_revisao' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/:id/approve', async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const atual = await buscarContrato(req.params.id, true);
      if (!atual) return res.status(404).json({ error: 'Contrato não encontrado.' });
      if (atual.status !== 'em_revisao' || !atual.pdf_original) return res.status(409).json({ error: 'Gere e revise o PDF antes da aprovação.' });
      if (hash(atual.pdf_original) !== atual.pdf_original_hash) return res.status(409).json({ error: 'Falha de integridade no PDF. Gere uma nova versão.' });
      await pool.query(`UPDATE contratos SET status='aprovado', aprovado_em=NOW(), atualizado_em=NOW() WHERE id=$1`, [atual.id]);
      await evento(atual.id, 'contrato_aprovado', req, { sha256: atual.pdf_original_hash });
      res.json({ ok: true, status: 'aprovado' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/:id/send', async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const atual = await buscarContrato(req.params.id, true);
      if (!atual) return res.status(404).json({ error: 'Contrato não encontrado.' });
      if (atual.status !== 'aprovado' || !atual.pdf_original) return res.status(409).json({ error: 'O contrato precisa estar aprovado.' });
      if (hash(atual.pdf_original) !== atual.pdf_original_hash) return res.status(409).json({ error: 'Falha de integridade no PDF aprovado.' });
      const sr = await pool.query(`SELECT papel, nome, cpf, email, telefone FROM contrato_signatarios WHERE contrato_id=$1 ORDER BY id`, [atual.id]);
      if (sr.rows.length < 2) return res.status(400).json({ error: 'Configure EVPARKING_SIGNER_EMAIL para incluir o signatário do INTEGRADOR.' });
      const retorno = await criarDocumentoZapSign({
        contratoId: atual.id,
        nomeArquivo: `${atual.numero}_${nomeSeguro(atual.dados.razaoSocial)}.pdf`,
        pdfBase64: atual.pdf_original.toString('base64'),
        signatarios: sr.rows,
      });
      const tokenDocumento = retorno.token || retorno.doc_token;
      const signers = Array.isArray(retorno.signers) ? retorno.signers : [];
      await pool.query(`UPDATE contratos SET status='aguardando_assinaturas', provider_document_token=$2,
        provider_payload=$3, enviado_em=NOW(), atualizado_em=NOW() WHERE id=$1`, [atual.id, tokenDocumento, retorno]);
      for (let i = 0; i < sr.rows.length; i++) {
        const ps = signers[i] || {};
        await pool.query(`UPDATE contrato_signatarios SET provider_signer_token=$2 WHERE contrato_id=$1 AND email=$3`,
          [atual.id, ps.token || ps.signer_token || null, sr.rows[i].email]);
      }
      await evento(atual.id, 'enviado_zapsign', req, { providerToken: tokenDocumento, simulated: Boolean(retorno.simulated) });
      res.json({ ok: true, status: 'aguardando_assinaturas', simulated: Boolean(retorno.simulated) });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  router.post('/:id/simulate-complete', async (req, res) => {
    if (!admin(req, res)) return;
    if (assinaturaConfig().mode !== 'simulator') return res.status(404).json({ error: 'Disponível apenas no modo simulador.' });
    try {
      const atual = await buscarContrato(req.params.id, true);
      if (!atual || atual.status !== 'aguardando_assinaturas') return res.status(409).json({ error: 'Contrato não está aguardando assinaturas.' });
      await pool.query(`UPDATE contrato_signatarios SET status='assinado', assinado_em=NOW() WHERE contrato_id=$1`, [atual.id]);
      await pool.query(`UPDATE contratos SET status='concluido', pdf_assinado=pdf_original,
        pdf_assinado_hash=pdf_original_hash, concluido_em=NOW(), atualizado_em=NOW() WHERE id=$1`, [atual.id]);
      await evento(atual.id, 'simulacao_concluida', req);
      res.json({ ok: true, status: 'concluido', simulated: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/:id/download/:tipo', async (req, res) => {
    try {
      const tipo = req.params.tipo;
      if (!['original', 'signed'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido.' });
      const atual = await buscarContrato(req.params.id, true);
      if (!atual) return res.status(404).json({ error: 'Contrato não encontrado.' });
      const arquivo = tipo === 'signed' ? atual.pdf_assinado : atual.pdf_original;
      if (!arquivo) return res.status(404).json({ error: 'Arquivo ainda não disponível.' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${atual.numero}_${tipo}.pdf"`);
      res.send(arquivo);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}

export async function receberWebhookZapSign(req, res) {
  const esperado = String(process.env.ZAPSIGN_WEBHOOK_SECRET || '');
  const recebido = String(req.headers.authorization || req.headers['x-webhook-secret'] || '');
  const esperadoBuffer = Buffer.from(esperado);
  const recebidoBuffer = Buffer.from(recebido);
  if (!esperado || !recebido || esperadoBuffer.length !== recebidoBuffer.length || !crypto.timingSafeEqual(recebidoBuffer, esperadoBuffer)) {
    return res.status(401).json({ error: 'Webhook não autorizado.' });
  }
  const payload = req.body || {};
  const payloadHash = hash(Buffer.from(JSON.stringify(payload)));
  try {
    const ins = await pool.query(`INSERT INTO contrato_webhooks (payload_hash, provider, payload)
      VALUES ($1,'zapsign',$2) ON CONFLICT (payload_hash) DO NOTHING RETURNING id`, [payloadHash, payload]);
    if (!ins.rows.length) return res.json({ ok: true, duplicate: true });
    const token = payload.token || payload.doc_token || payload.document_token || payload?.document?.token;
    if (!token) throw new Error('Webhook sem token de documento.');
    const c = await pool.query('SELECT id FROM contratos WHERE provider_document_token=$1', [token]);
    if (!c.rows.length) throw new Error('Contrato não localizado para o token recebido.');
    const contratoId = c.rows[0].id;
    const detalhe = await detalharDocumentoZapSign(token);
    const status = String(detalhe.status || payload.status || '').toLowerCase();
    const providerSigners = Array.isArray(detalhe.signers) ? detalhe.signers : [];
    let assinados = 0;
    for (const signer of providerSigners) {
      const signerStatus = String(signer.status || '').toLowerCase();
      const assinado = ['signed', 'assinado'].includes(signerStatus) || Boolean(signer.signed_at || signer.sign_time);
      if (!assinado) continue;
      assinados += 1;
      const signerToken = signer.token || signer.signer_token || null;
      const signerEmail = String(signer.email || '').toLowerCase();
      await pool.query(`UPDATE contrato_signatarios SET status='assinado', assinado_em=COALESCE(assinado_em,NOW())
        WHERE contrato_id=$1 AND (($2::text IS NOT NULL AND provider_signer_token=$2) OR ($3::text <> '' AND lower(email)=$3))`,
        [contratoId, signerToken, signerEmail]);
    }
    const concluido = ['signed', 'completed', 'concluido'].includes(status) || detalhe.signed_file;
    if (concluido) {
      const pdf = detalhe.signed_file ? await baixarArquivoZapSign(detalhe.signed_file) : null;
      await pool.query(`UPDATE contratos SET status='concluido', pdf_assinado=COALESCE($2,pdf_assinado),
        pdf_assinado_hash=COALESCE($3,pdf_assinado_hash), provider_payload=$4, concluido_em=NOW(), atualizado_em=NOW() WHERE id=$1`,
        [contratoId, pdf, pdf ? hash(pdf) : null, detalhe]);
      await pool.query(`UPDATE contrato_signatarios SET status='assinado', assinado_em=COALESCE(assinado_em,NOW()) WHERE contrato_id=$1`, [contratoId]);
    } else if (['refused', 'rejected', 'recusado'].includes(status)) {
      await pool.query(`UPDATE contratos SET status='recusado', provider_payload=$2, atualizado_em=NOW() WHERE id=$1`, [contratoId, detalhe]);
    } else if (['deleted', 'canceled', 'cancelled'].includes(status)) {
      await pool.query(`UPDATE contratos SET status='cancelado', provider_payload=$2, cancelado_em=NOW(), atualizado_em=NOW() WHERE id=$1`, [contratoId, detalhe]);
    } else if (assinados > 0) {
      await pool.query(`UPDATE contratos SET status='parcialmente_assinado', provider_payload=$2, atualizado_em=NOW() WHERE id=$1`, [contratoId, detalhe]);
    }
    await pool.query(`UPDATE contrato_webhooks SET processado_em=NOW() WHERE payload_hash=$1`, [payloadHash]);
    await pool.query(`INSERT INTO contrato_eventos (contrato_id,tipo,usuario_nome,payload) VALUES ($1,$2,'webhook',$3)`, [contratoId, 'webhook_zapsign', { status, payloadHash }]);
    return res.json({ ok: true });
  } catch (err) {
    await pool.query(`UPDATE contrato_webhooks SET erro=$2 WHERE payload_hash=$1`, [payloadHash, err.message]).catch(() => null);
    return res.status(500).json({ error: err.message });
  }
}
