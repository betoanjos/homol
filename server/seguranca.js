// Segurança extra do login — EV Core
//
// Camada 1: Bloqueio progressivo por tentativas erradas (anti força-bruta)
//   - 5 erros do mesmo IP+usuário em 15 min → bloqueio de 15 min
//   - 10 erros → bloqueio de 1 hora
//   - 25 erros do mesmo IP (qualquer usuário) → bloqueio do IP por 1 hora
//
// Camada 2: Verificação em duas etapas por e-mail (opcional)
//   - Ative definindo LOGIN_2FA_EMAIL nas Variables (e-mail que recebe o código)
//   - Após usuário+senha corretos, um código de 6 dígitos é enviado; a sessão
//     só é criada quando o código é confirmado (validade 10 min, 5 tentativas)
//
// Camada 3: Alerta de acesso por e-mail a cada login bem-sucedido
//   (enviado para LOGIN_2FA_EMAIL, com data/hora, IP e navegador)

import crypto from 'crypto';
import pool from './db.js';

const JANELA_MIN = 15;            // janela de contagem de erros
const LIMITE_SUAVE = 5;           // erros → bloqueio curto
const LIMITE_DURO = 10;           // erros → bloqueio longo
const LIMITE_IP = 25;             // erros por IP (qualquer usuário)
const BLOQUEIO_CURTO_MIN = 15;
const BLOQUEIO_LONGO_MIN = 60;

const OTP_VALIDADE_MIN = 10;
const OTP_MAX_TENTATIVAS = 5;

// ── Rate limit em memória ────────────────────────────────────────────────────
const falhas = new Map();   // chave → [timestamps]
const bloqueios = new Map(); // chave → timestamp de liberação

function agora() { return Date.now(); }

function registrar(chave) {
  const lista = (falhas.get(chave) || []).filter(t => agora() - t < JANELA_MIN * 60000);
  lista.push(agora());
  falhas.set(chave, lista);
  return lista.length;
}

function bloquear(chave, minutos) {
  bloqueios.set(chave, agora() + minutos * 60000);
}

export function getClientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'desconhecido';
}

// Retorna null se liberado, ou minutos restantes de bloqueio.
export function checarBloqueio(req, username) {
  const ip = getClientIp(req);
  for (const chave of [`ip:${ip}`, `iu:${ip}|${String(username || '').toLowerCase()}`]) {
    const ate = bloqueios.get(chave);
    if (ate && ate > agora()) return Math.ceil((ate - agora()) / 60000);
    if (ate) bloqueios.delete(chave);
  }
  return null;
}

export function registrarFalhaLogin(req, username) {
  const ip = getClientIp(req);
  const chaveIU = `iu:${ip}|${String(username || '').toLowerCase()}`;
  const nIU = registrar(chaveIU);
  const nIP = registrar(`ip:${ip}`);
  if (nIP >= LIMITE_IP) bloquear(`ip:${ip}`, BLOQUEIO_LONGO_MIN);
  else if (nIU >= LIMITE_DURO) bloquear(chaveIU, BLOQUEIO_LONGO_MIN);
  else if (nIU >= LIMITE_SUAVE) bloquear(chaveIU, BLOQUEIO_CURTO_MIN);
  console.warn(`Login falhou: usuário "${username}" · IP ${ip} · ${nIU} erro(s) na janela`);
}

export function limparFalhasLogin(req, username) {
  const ip = getClientIp(req);
  falhas.delete(`iu:${ip}|${String(username || '').toLowerCase()}`);
}

// ── Verificação em duas etapas (código por e-mail) ──────────────────────────
export function twofaAtivo() {
  return Boolean(String(process.env.LOGIN_2FA_EMAIL || '').trim());
}

export function twofaEmailDestino() {
  return String(process.env.LOGIN_2FA_EMAIL || '').trim();
}

export async function initSegurancaDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_otp (
      ticket TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      tentativas INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query('DELETE FROM login_otp WHERE expires_at < NOW()');
}

const hashCodigo = c => crypto.createHash('sha256').update(String(c)).digest('hex');

export async function criarOtp(userId) {
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const ticket = crypto.randomBytes(24).toString('hex');
  await pool.query('DELETE FROM login_otp WHERE user_id = $1', [userId]); // 1 código ativo por usuário
  await pool.query(
    `INSERT INTO login_otp (ticket, user_id, code_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)`,
    [ticket, userId, hashCodigo(codigo), String(OTP_VALIDADE_MIN)]
  );
  return { ticket, codigo, validadeMin: OTP_VALIDADE_MIN };
}

// Retorna { ok, userId } ou { ok:false, erro }
export async function validarOtp(ticket, codigo) {
  const r = await pool.query('SELECT * FROM login_otp WHERE ticket = $1', [String(ticket || '')]);
  const otp = r.rows[0];
  if (!otp) return { ok: false, erro: 'Código expirado ou inválido. Faça login novamente.' };
  if (new Date(otp.expires_at) < new Date()) {
    await pool.query('DELETE FROM login_otp WHERE ticket = $1', [otp.ticket]);
    return { ok: false, erro: 'Código expirado. Faça login novamente.' };
  }
  if (otp.tentativas >= OTP_MAX_TENTATIVAS) {
    await pool.query('DELETE FROM login_otp WHERE ticket = $1', [otp.ticket]);
    return { ok: false, erro: 'Muitas tentativas de código. Faça login novamente.' };
  }
  if (hashCodigo(codigo) !== otp.code_hash) {
    await pool.query('UPDATE login_otp SET tentativas = tentativas + 1 WHERE ticket = $1', [otp.ticket]);
    return { ok: false, erro: 'Código incorreto.' };
  }
  await pool.query('DELETE FROM login_otp WHERE ticket = $1', [otp.ticket]); // uso único
  return { ok: true, userId: otp.user_id };
}

// ── Templates de e-mail ─────────────────────────────────────────────────────
function baseEmail(conteudo) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f2f5f9;font-family:Arial,sans-serif;padding:24px 0">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
    <table role="presentation" width="480" cellspacing="0" cellpadding="0" style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(20,40,60,.08)">
      <tr><td style="background:#0a0e14;padding:18px 28px;border-bottom:3px solid #00e5a0" align="center">
        <span style="color:#00e5a0;font-size:18px;font-weight:800">EV Core · Segurança</span>
      </td></tr>
      <tr><td style="padding:28px 32px">${conteudo}</td></tr>
      <tr><td style="background:#f7fafc;padding:14px 28px;border-top:1px solid #e7ecf2" align="center">
        <span style="font-size:11px;color:#8a94a6">Se não foi você, troque a senha imediatamente nas Variables do Railway.</span>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

export function emailCodigoHTML(codigo, validadeMin) {
  return baseEmail(`
    <h2 style="margin:0 0 8px;font-size:18px;color:#101820">Seu código de acesso</h2>
    <p style="margin:0 0 18px;font-size:14px;color:#4a5568">Use o código abaixo para concluir o login no EV Core. Ele vale por ${validadeMin} minutos e só pode ser usado uma vez.</p>
    <div style="text-align:center;margin:10px 0 6px">
      <span style="display:inline-block;background:#f0fbf6;border:1px dashed #00b880;border-radius:10px;padding:14px 26px;font-size:30px;letter-spacing:8px;font-weight:800;color:#04794f">${codigo}</span>
    </div>`);
}

export function emailAlertaLoginHTML({ usuario, ip, agente, quando }) {
  return baseEmail(`
    <h2 style="margin:0 0 8px;font-size:18px;color:#101820">Novo acesso ao EV Core</h2>
    <p style="margin:0 0 14px;font-size:14px;color:#4a5568">Um login foi realizado com sucesso:</p>
    <table style="font-size:13px;color:#334;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#8a94a6">Usuário</td><td>${usuario}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#8a94a6">Quando</td><td>${quando}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#8a94a6">IP</td><td>${ip}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#8a94a6">Navegador</td><td style="font-size:11px">${agente}</td></tr>
    </table>`);
}
