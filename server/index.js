import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pool from './db.js';
import { initTupiDB, syncTupi, getSyncStatus, listRecargas, iniciarSyncAgendado } from './tupiSync.js';
import { fetchSessionUserData, tupiConfig } from './tupi.js';
import { initAniversariosDB, processarAniversarios, enviarTesteAniversario, statusAniversarios, iniciarAgendadorAniversarios, enviarEmailGenerico, aniversariosConfigurado } from './aniversarios.js';
import { initSegurancaDB, checarBloqueio, registrarFalhaLogin, limparFalhasLogin, twofaAtivo, twofaEmailDestino, criarOtp, validarOtp, emailCodigoHTML, emailAlertaLoginHTML, getClientIp, initDispositivosDB, confiarDispositivo, dispositivoConfiavel, revogarDispositivos, diasLembrarDispositivo } from './seguranca.js';
import { initContratosDB, criarContratosRouter, receberWebhookZapSign, exportarContratosBackup } from './contratos/index.js';

const app = express();
app.use(cors());
// Parser JSON global (2mb). A rota de upload de arquivos usa parser próprio com
// limite maior, então é excluída aqui para não ser barrada pelo limite de 2mb.
const jsonPadrao = express.json({ limit: '2mb' });
app.use((req, res, next) => {
  if (req.path === '/api/parceiros/arquivos') return next();
  if (req.path.startsWith('/api/contracts/') && req.path.endsWith('/pdf')) return next();
  return jsonPadrao(req, res, next);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const PORT = process.env.PORT || 3001;
const PROVIDER = (process.env.PIX_PROVIDER || 'mercadopago').toLowerCase().trim();

const memoria = new Map();
const execFileAsync = promisify(execFile);
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS || 6);
const BACKUP_KEEP_LAST = Number(process.env.BACKUP_KEEP_LAST || 30);
let ultimoBackup = null;

const SESSION_COOKIE = 'evcore_session';
const SESSION_MAX_AGE_HOURS = 8;
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/login/2fa', '/api/logout', '/api/me', '/api/health', '/logo-evparking.png']);

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').filter(Boolean).map(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return [part.trim(), ''];
    return [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
  }));
}

function getSessionToken(req) {
  const cookies = parseCookies(req);
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  return cookies[SESSION_COOKIE] || bearer || '';
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored = '') {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function sessionCookie(token) {
  const secure = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID;
  const maxAge = SESSION_MAX_AGE_HOURS * 60 * 60;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}


async function ensureBackupDir() {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function limparBackupsAntigos() {
  try {
    const files = (await fs.readdir(BACKUP_DIR))
      .filter(f => f.startsWith('evparking-backup-'))
      .sort()
      .reverse();
    const apagar = files.slice(BACKUP_KEEP_LAST);
    await Promise.all(apagar.map(f => fs.unlink(path.join(BACKUP_DIR, f)).catch(() => null)));
  } catch (err) {
    console.warn('Não foi possível limpar backups antigos:', err.message);
  }
}

async function criarBackupAutomatico(motivo = 'automatico') {
  await ensureBackupDir();
  const stamp = backupStamp();
  const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
  const state = result.rows[0]?.data || {};
  const contratos = await exportarContratosBackup();
  const jsonFile = path.join(BACKUP_DIR, `evparking-backup-${stamp}.json`);
  await fs.writeFile(jsonFile, JSON.stringify({ criadoEm: new Date().toISOString(), motivo, state, contratos }, null, 2));

  let dumpFile = null;
  let dumpOk = false;
  let dumpErro = null;
  if (process.env.DATABASE_URL) {
    try {
      dumpFile = path.join(BACKUP_DIR, `evparking-backup-${stamp}.dump`);
      await execFileAsync('pg_dump', ['--format=custom', '--no-owner', '--no-acl', process.env.DATABASE_URL, '--file', dumpFile], { timeout: 120000 });
      dumpOk = true;
    } catch (err) {
      dumpErro = err.message;
      dumpFile = null;
      console.warn('pg_dump não executado. Backup JSON do app_state foi criado normalmente:', err.message);
    }
  }

  ultimoBackup = { ok: true, criadoEm: new Date().toISOString(), motivo, jsonFile, dumpFile, dumpOk, dumpErro };
  await limparBackupsAntigos();
  return ultimoBackup;
}

function iniciarBackupAutomatico() {
  const intervaloMs = Math.max(1, BACKUP_INTERVAL_HOURS) * 60 * 60 * 1000;
  setTimeout(() => criarBackupAutomatico('startup').catch(err => console.error('Erro no backup inicial:', err)), 15000);
  setInterval(() => criarBackupAutomatico('automatico').catch(err => console.error('Erro no backup automático:', err)), intervaloMs);
}

async function initAuthDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query('DELETE FROM app_sessions WHERE expires_at < NOW()');
  await pool.query('ALTER TABLE app_users ADD COLUMN IF NOT EXISTS twofa_email TEXT');

  // ── Usuários admin via Variables ──────────────────────────────────────────
  // Suporta múltiplos admins com sufixos _2, _3, ... (sem sufixo = usuário 1):
  //   EVCORE_ADMIN_USER / EVCORE_ADMIN_PASSWORD            → admin principal
  //   EVCORE_ADMIN_USER_2 / EVCORE_ADMIN_PASSWORD_2        → segundo admin
  //   EVCORE_ADMIN_2FA_EMAIL(_2, _3...) → e-mail que recebe o código 2FA e os
  //   alertas DESSE usuário (se ausente, usa o LOGIN_2FA_EMAIL global).
  const sufixos = ['', '_2', '_3', '_4', '_5'];
  let algumSeed = false;
  for (const suf of sufixos) {
    const u = process.env['EVCORE_ADMIN_USER' + suf] || (suf === '' ? (process.env.ADMIN_USER || 'admin') : '');
    const p = process.env['EVCORE_ADMIN_PASSWORD' + suf] || (suf === '' ? process.env.ADMIN_PASSWORD : '');
    const mail2fa = (process.env['EVCORE_ADMIN_2FA_EMAIL' + suf] || '').trim() || null;
    if (!u || !p) continue;
    algumSeed = true;
    await pool.query(`
      INSERT INTO app_users (username, password_hash, role, twofa_email)
      VALUES ($1, $2, 'admin', $3)
      ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, twofa_email = EXCLUDED.twofa_email
    `, [String(u).trim(), hashPassword(p), mail2fa]);
    console.log(`Usuário admin garantido: ${String(u).trim()}${mail2fa ? ' (2FA → ' + mail2fa + ')' : ''}`);
  }

  // Usuários SOMENTE LEITURA (role 'leitura'): veem tudo, não alteram nada.
  //   EVCORE_VIEWER_USER / EVCORE_VIEWER_PASSWORD (e _2..._5)
  //   EVCORE_VIEWER_2FA_EMAIL(_2...) → e-mail 2FA/alertas desse usuário
  for (const suf of sufixos) {
    const u = process.env['EVCORE_VIEWER_USER' + suf];
    const p = process.env['EVCORE_VIEWER_PASSWORD' + suf];
    const mail2fa = (process.env['EVCORE_VIEWER_2FA_EMAIL' + suf] || '').trim() || null;
    if (!u || !p) continue;
    await pool.query(`
      INSERT INTO app_users (username, password_hash, role, twofa_email)
      VALUES ($1, $2, 'leitura', $3)
      ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'leitura', twofa_email = EXCLUDED.twofa_email
    `, [String(u).trim(), hashPassword(p), mail2fa]);
    console.log(`Usuário somente leitura garantido: ${String(u).trim()}${mail2fa ? ' (2FA → ' + mail2fa + ')' : ''}`);
  }

  if (!algumSeed) {
    const existing = await pool.query('SELECT id FROM app_users LIMIT 1');
    if (!existing.rows.length) {
      const tempPassword = crypto.randomBytes(9).toString('base64url');
      await pool.query(
        'INSERT INTO app_users (username, password_hash, role) VALUES ($1, $2, $3)',
        ['admin', hashPassword(tempPassword), 'admin']
      );
      console.warn('EVCORE_ADMIN_PASSWORD não configurado. Senha temporária do admin:', tempPassword);
      console.warn('Defina EVCORE_ADMIN_USER e EVCORE_ADMIN_PASSWORD nas Variables do Railway e faça redeploy.');
    }
  }
}

async function getSessionUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const result = await pool.query(`
    SELECT u.id, u.username, u.role
    FROM app_sessions s
    JOIN app_users u ON u.id = s.user_id
    WHERE s.token = $1 AND s.expires_at > NOW()
  `, [token]);
  return result.rows[0] || null;
}

async function requireAuth(req, res, next) {
  try {
    if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/api/webhooks/mercadopago') || req.path.startsWith('/api/webhooks/zapsign')) return next();
    const user = await getSessionUser(req);
    if (user) {
      req.user = user;
      // Usuário somente leitura: qualquer método que altera dados é bloqueado
      // AQUI no servidor (esconder botões no front é cosmético; a segurança é esta).
      if (user.role === 'leitura' && req.method !== 'GET') {
        return res.status(403).json({ error: 'Seu usuário é somente leitura — esta ação não é permitida.' });
      }
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado.' });
    return res.redirect('/login');
  } catch (err) {
    console.error('Erro de autenticação:', err);
    return res.status(500).json({ error: 'Erro de autenticação.' });
  }
}


async function initStateDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  await pool.query(`
    INSERT INTO app_state (id, data)
    VALUES (1, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  `);
}

async function initParceiroArquivosDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parceiro_arquivos (
      id SERIAL PRIMARY KEY,
      parceiro_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      tipo TEXT,
      tamanho INTEGER,
      dados BYTEA NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_parceiro_arquivos_pid ON parceiro_arquivos (parceiro_id);`);
}

await initStateDB();
await initAuthDB();
await initTupiDB();
await initAniversariosDB();
await initSegurancaDB();
await initDispositivosDB();
await initContratosDB();
if (twofaAtivo() && !aniversariosConfigurado()) {
  console.warn('LOGIN_2FA_EMAIL definido, mas nenhum provedor de e-mail configurado (BREVO_API_KEY ou SMTP). A verificação em duas etapas NÃO funcionará até configurar.');
} else if (twofaAtivo()) {
  console.log('Verificação em duas etapas ATIVA — códigos enviados para', twofaEmailDestino());
}
await initParceiroArquivosDB();

app.get('/login', async (req, res) => {
  const user = await getSessionUser(req);
  if (user) return res.redirect('/');
  return res.sendFile(path.join(publicDir, 'login.html'));
});

// Cria a sessão e dispara o alerta de acesso (assíncrono, não bloqueia o login)
async function concluirLogin(req, res, user, cookiesExtras = []) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO app_sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)`,
    [token, user.id, String(SESSION_MAX_AGE_HOURS)]
  );
  res.setHeader('Set-Cookie', [sessionCookie(token), ...cookiesExtras]);

  // Camada 3: alerta de acesso (fire-and-forget) — para o e-mail do próprio
  // usuário quando definido, senão para o e-mail de segurança global
  const destinoAlerta = user.twofa_email || twofaEmailDestino();
  if (destinoAlerta && aniversariosConfigurado()) {
    const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    enviarEmailGenerico({
      para: destinoAlerta,
      assunto: `🔐 Novo acesso ao EV Core — ${quando}`,
      html: emailAlertaLoginHTML({
        usuario: user.username,
        ip: getClientIp(req),
        agente: String(req.headers['user-agent'] || 'desconhecido').slice(0, 160),
        quando
      })
    }).catch(err => console.warn('Falha ao enviar alerta de acesso:', err.message));
  }
  return res.json({ ok: true, user: { username: user.username, role: user.role } });
}

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha.' });

    // Camada 1: bloqueio por tentativas
    const bloqueadoMin = checarBloqueio(req, username);
    if (bloqueadoMin) {
      return res.status(429).json({ error: `Muitas tentativas. Tente novamente em ${bloqueadoMin} minuto(s).` });
    }

    const result = await pool.query('SELECT id, username, password_hash, role, twofa_email FROM app_users WHERE username = $1', [String(username).trim()]);
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      registrarFalhaLogin(req, username);
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }
    limparFalhasLogin(req, username);

    // Camada 2: verificação em duas etapas por e-mail (se ativada).
    // O código vai para o e-mail do PRÓPRIO usuário (twofa_email), com
    // fallback para o LOGIN_2FA_EMAIL global.
    const destino2fa = user.twofa_email || twofaEmailDestino();
    if (twofaAtivo() || user.twofa_email) {
      // Navegador confiável (2FA confirmado nos últimos N dias) → pula o código
      if (await dispositivoConfiavel(user.id, req)) {
        return await concluirLogin(req, res, user);
      }
      if (!aniversariosConfigurado()) {
        return res.status(500).json({ error: 'Verificação em duas etapas ativa, mas o e-mail não está configurado no servidor.' });
      }
      const { ticket, codigo, validadeMin } = await criarOtp(user.id);
      try {
        await enviarEmailGenerico({
          para: destino2fa,
          assunto: `🔐 Código de acesso EV Core: ${codigo}`,
          html: emailCodigoHTML(codigo, validadeMin),
          nomeRemetente: 'EV Core Segurança'
        });
      } catch (err) {
        console.error('Falha ao enviar código 2FA:', err.message);
        return res.status(500).json({ error: 'Não foi possível enviar o código de verificação. Tente novamente.' });
      }
      return res.json({ twofa: true, ticket, mensagem: 'Código enviado para o e-mail de segurança.' });
    }

    return await concluirLogin(req, res, user);
  } catch (err) {
    console.error('Erro no login:', err);
    return res.status(500).json({ error: 'Erro ao fazer login.' });
  }
});

// Etapa 2: confirmação do código
app.post('/api/login/2fa', async (req, res) => {
  try {
    const { ticket, codigo } = req.body || {};
    const bloqueadoMin = checarBloqueio(req, '2fa');
    if (bloqueadoMin) {
      return res.status(429).json({ error: `Muitas tentativas. Tente novamente em ${bloqueadoMin} minuto(s).` });
    }
    const v = await validarOtp(ticket, codigo);
    if (!v.ok) {
      registrarFalhaLogin(req, '2fa');
      return res.status(401).json({ error: v.erro });
    }
    limparFalhasLogin(req, '2fa');
    const result = await pool.query('SELECT id, username, role, twofa_email FROM app_users WHERE id = $1', [v.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado.' });

    // "Lembrar este navegador": grava o dispositivo confiável e envia o
    // cookie junto com o da sessão (por padrão lembra, a menos que desmarque).
    const cookies = [];
    if (req.body?.lembrar !== false) {
      try { cookies.push(await confiarDispositivo(user.id, req)); }
      catch (e) { console.warn('Falha ao registrar dispositivo confiável:', e.message); }
    }
    return await concluirLogin(req, res, user, cookies);
  } catch (err) {
    console.error('Erro na verificação em duas etapas:', err);
    return res.status(500).json({ error: 'Erro na verificação.' });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    const token = getSessionToken(req);
    if (token) await pool.query('DELETE FROM app_sessions WHERE token = $1', [token]);
    res.setHeader('Set-Cookie', clearSessionCookie());
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao sair:', err);
    return res.status(500).json({ error: 'Erro ao sair.' });
  }
});

app.get('/api/me', async (req, res) => {
  const user = await getSessionUser(req);
  return res.json({ authenticated: !!user, user: user ? { username: user.username, role: user.role } : null });
});

// Webhook público da ZapSign. A autenticação é feita por segredo dedicado
// dentro do handler; ele nunca utiliza a sessão do usuário do EVCore.
app.post('/api/webhooks/zapsign', receberWebhookZapSign);

app.use(requireAuth);

// Módulo isolado de contratos. Usa tabelas próprias e apenas consulta o
// app_state para preencher parceiros e estações existentes.
app.use('/api/contracts', criarContratosRouter());


app.get('/api/state', async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
    res.json(result.rows[0]?.data || {});
  } catch (err) {
    console.error('Erro ao carregar estado:', err);
    res.status(500).json({ error: 'Erro ao carregar dados.' });
  }
});

app.post('/api/state', async (req, res) => {
  try {
    await pool.query('UPDATE app_state SET data = $1 WHERE id = 1', [req.body || {}]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao salvar estado:', err);
    res.status(500).json({ error: 'Erro ao salvar dados.' });
  }
});


// Revoga os dispositivos confiáveis (força 2FA em todos os navegadores no
// próximo login). Sem corpo = todos os usuários. Uso: em caso de suspeita.
app.post('/api/seguranca/revogar-dispositivos', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
    const n = await revogarDispositivos();
    res.json({ ok: true, revogados: n, mensagem: 'Todos os navegadores precisarão do código 2FA no próximo login.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Aniversários (e-mail automático com recarga grátis) =====

app.get('/api/aniversarios/status', async (_req, res) => {
  try { res.json(await statusAniversarios()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Dispara manualmente a verificação/envio do dia (force=1 reenvia mesmo se já enviado).
app.post('/api/aniversarios/rodar', async (req, res) => {
  try { res.json(await processarAniversarios({ force: req.query.force === '1' })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Envia um e-mail de teste para validar SMTP e layout: { "email": "voce@..." }
app.post('/api/aniversarios/teste', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    if (!email) return res.status(400).json({ error: 'Informe o e-mail de destino.' });
    res.json(await enviarTesteAniversario(email, req.body?.nome || 'Cliente Teste'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Integração Tupi (OCPI) =====

// Dispara uma sincronização manual (full=1 para reprocessar o histórico inicial).
app.post('/api/tupi/sync', async (req, res) => {
  try {
    const full = req.query.full === '1' || req.body?.full === true;
    const resultado = await syncTupi({ motivo: 'manual', full });
    res.json(resultado);
  } catch (err) {
    console.error('Erro no sync Tupi:', err);
    res.status(500).json({ error: err.message });
  }
});

// Situação da última sincronização + totais.
app.get('/api/tupi/sync/status', async (_req, res) => {
  try {
    res.json(await getSyncStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recargas já sincronizadas, em formato normalizado para o EVP.
app.get('/api/tupi/recargas', async (req, res) => {
  try {
    const { date_from, date_to, status, limit, offset } = req.query;
    const recargas = await listRecargas({
      dateFrom: date_from, dateTo: date_to, status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined
    });
    res.json({ total: recargas.length, recargas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Diagnóstico de divergência de faturamento ────────────────────────────────
// Compara, para uma estação e período, o que a API Tupi retornou (tupi_sessions,
// sempre atualizado pelo sync) contra as recargas efetivamente usadas no EV Core
// (app_state.data.recargas). Aponta sessão a sessão de onde vem a diferença.
// Uso: GET /api/tupi/diagnostico?stationId=1124387764&dateFrom=2026-06-01&dateTo=2026-06-30
// (datas interpretadas no fuso America/Sao_Paulo, inclusivas)
app.get('/api/tupi/diagnostico', async (req, res) => {
  try {
    const stationId = String(req.query.stationId || '').trim();
    const dateFrom = String(req.query.dateFrom || '').trim(); // YYYY-MM-DD
    const dateTo = String(req.query.dateTo || '').trim();     // YYYY-MM-DD
    if (!stationId) return res.status(400).json({ error: 'stationId é obrigatório.' });

    // 1) Lado API: tudo que a Tupi reportou para a estação no período (sem filtro de kwh).
    const condApi = [`s.location_id = $1`];
    const paramsApi = [stationId];
    if (dateFrom) { paramsApi.push(dateFrom); condApi.push(`(s.start_date_time AT TIME ZONE 'America/Sao_Paulo')::date >= $${paramsApi.length}::date`); }
    if (dateTo)   { paramsApi.push(dateTo);   condApi.push(`(s.start_date_time AT TIME ZONE 'America/Sao_Paulo')::date <= $${paramsApi.length}::date`); }
    const apiRows = (await pool.query(
      `SELECT s.id, s.status, s.kwh, s.currency,
              s.total_cost_excl_vat, s.total_cost_incl_vat,
              s.start_date_time, s.end_date_time, s.last_updated,
              to_char(s.start_date_time AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') AS inicio_local
         FROM tupi_sessions s
        WHERE ${condApi.join(' AND ')}
        ORDER BY s.start_date_time`,
      paramsApi
    )).rows;

    // 2) Lado EV Core: recargas do estado de negócio para a mesma estação/período.
    const stateRow = await pool.query('SELECT data FROM app_state WHERE id = 1');
    const state = stateRow.rows[0]?.data || {};
    const todasRecargas = Array.isArray(state.recargas) ? state.recargas : [];
    const noPeriodo = (dataStr) => {
      const d = String(dataStr || '').slice(0, 10); // "YYYY-MM-DD"
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      return true;
    };
    const evRecargas = todasRecargas.filter(r =>
      String(r.idEstacao || '') === stationId && noPeriodo(r.data)
    );
    const evPorUid = new Map(evRecargas.map(r => [String(r.uid || ''), r]));

    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const round2 = v => Math.round(v * 100) / 100;
    const valorApi = s => s.total_cost_incl_vat != null ? num(s.total_cost_incl_vat) : num(s.total_cost_excl_vat);

    // 3) Cruzamento sessão a sessão.
    const faltandoNoEV = [];      // está na API, não está no EV Core
    const valorDivergente = [];   // está nos dois, mas com valor diferente
    const ocultasNoEV = [];       // existe no EV Core mas está marcada como oculta/removida
    const semImpostoFallback = []; // sessões sem incl_vat (EV Core usa excl_vat)
    let totalApi = 0, totalEV = 0;

    for (const s of apiRows) {
      const vApi = valorApi(s);
      totalApi += vApi;
      if (s.total_cost_incl_vat == null && s.total_cost_excl_vat != null) {
        semImpostoFallback.push({ id: s.id, inicio: s.inicio_local, excl_vat: num(s.total_cost_excl_vat) });
      }
      const r = evPorUid.get(String(s.id));
      if (!r) {
        faltandoNoEV.push({
          id: s.id, inicio: s.inicio_local, status: s.status,
          kwh: s.kwh != null ? Number(s.kwh) : null, valorApi: round2(vApi),
          motivoProvavel: !(Number(s.kwh) > 0)
            ? 'kwh <= 0 ou nulo — excluída pelo filtro s.kwh > 0 do listRecargas'
            : 'não importada (verificar dedup/período no frontend)'
        });
        continue;
      }
      const vEV = num(r.cobranca ?? r.total ?? r.custo);
      totalEV += vEV;
      if (r.excluidaPendente || r.ocultaPendente || r.removidaManual) {
        ocultasNoEV.push({ id: s.id, inicio: s.inicio_local, valorEV: round2(vEV) });
      }
      if (Math.abs(vEV - vApi) >= 0.01) {
        valorDivergente.push({
          id: s.id, inicio: s.inicio_local, status: s.status,
          valorApi: round2(vApi), valorEVCore: round2(vEV), diff: round2(vApi - vEV),
          lastUpdatedApi: s.last_updated, fonteEV: r.fonte || 'desconhecida',
          importadaEm: r.importadaEm || null
        });
      }
    }

    // 4) Recargas no EV Core que a API não tem para essa estação/período (ex.: CSV/manual).
    const idsApi = new Set(apiRows.map(s => String(s.id)));
    const soNoEV = evRecargas
      .filter(r => !idsApi.has(String(r.uid || '')))
      .map(r => ({ uid: r.uid, data: r.data, fonte: r.fonte || 'desconhecida', valorEVCore: round2(num(r.cobranca ?? r.total ?? r.custo)) }));
    soNoEV.forEach(r => { totalEV += r.valorEVCore; });

    valorDivergente.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    res.json({
      stationId, dateFrom: dateFrom || null, dateTo: dateTo || null,
      totais: {
        api_tupi: round2(totalApi),
        ev_core: round2(totalEV),
        diferenca: round2(totalApi - totalEV)
      },
      resumo: {
        sessoes_api: apiRows.length,
        recargas_ev_core: evRecargas.length,
        faltando_no_ev_core: faltandoNoEV.length,
        valor_divergente: valorDivergente.length,
        ocultas_no_ev_core: ocultasNoEV.length,
        sem_incl_vat: semImpostoFallback.length,
        apenas_no_ev_core: soNoEV.length
      },
      faltandoNoEV, valorDivergente, ocultasNoEV, semImpostoFallback, apenasNoEV: soNoEV
    });
  } catch (err) {
    console.error('Erro no diagnóstico Tupi:', err);
    res.status(500).json({ error: err.message });
  }
});

// Dados do usuário de uma sessão específica (consulta ao vivo na Tupi).
app.get('/api/tupi/sessions/:id/user-data', async (req, res) => {
  try {
    const { countryCode, partyId } = tupiConfig();
    const cc = req.query.country_code || countryCode;
    const userData = await fetchSessionUserData(req.params.id, { countryCode: cc, partyId });
    if (!userData) return res.status(404).json({ error: 'Usuário não encontrado para a sessão.' });
    res.json({ session_id: req.params.id, user_data: userData });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ===== Arquivos do parceiro (contratos, fotos de etiquetas, documentos) =====
// Armazenados no Postgres (BYTEA) para sobreviver a redeploys do Railway.

// Upload: recebe { parceiroId, nome, tipo, base64 }. Parser dedicado com limite maior.
app.post('/api/parceiros/arquivos', express.json({ limit: '30mb' }), async (req, res) => {
  try {
    const { parceiroId, nome, tipo, base64 } = req.body || {};
    if (!parceiroId || !nome || !base64) return res.status(400).json({ error: 'Dados incompletos.' });
    const buffer = Buffer.from(String(base64), 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Arquivo vazio.' });
    if (buffer.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'Arquivo excede 25MB.' });
    const r = await pool.query(
      `INSERT INTO parceiro_arquivos (parceiro_id, nome, tipo, tamanho, dados)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, tipo, tamanho, criado_em`,
      [String(parceiroId), String(nome).slice(0, 300), tipo || null, buffer.length, buffer]
    );
    res.json({ ok: true, arquivo: r.rows[0] });
  } catch (err) {
    console.error('Erro no upload de arquivo do parceiro:', err);
    res.status(500).json({ error: 'Erro ao salvar arquivo.' });
  }
});

// Lista os arquivos de um parceiro (só metadados, sem os dados binários).
app.get('/api/parceiros/:parceiroId/arquivos', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nome, tipo, tamanho, criado_em
         FROM parceiro_arquivos WHERE parceiro_id = $1 ORDER BY criado_em DESC`,
      [req.params.parceiroId]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar arquivos.' });
  }
});

// Baixa/visualiza um arquivo.
app.get('/api/parceiros/arquivos/:id/download', async (req, res) => {
  try {
    const r = await pool.query('SELECT nome, tipo, dados FROM parceiro_arquivos WHERE id = $1', [req.params.id]);
    const arq = r.rows[0];
    if (!arq) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    res.setHeader('Content-Type', arq.tipo || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(arq.nome)}"`);
    res.send(arq.dados);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao baixar arquivo.' });
  }
});

// Exclui um arquivo.
app.delete('/api/parceiros/arquivos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM parceiro_arquivos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir arquivo.' });
  }
});

function somenteNumeros(value = '') {
  return String(value).replace(/\D/g, '');
}

function toDateBRorISO(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function toMoneyNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Valor inválido.');
  return Number(n.toFixed(2));
}

async function criarMockPix(body) {
  const txid = `EVP${Date.now()}`;
  const valor = toMoneyNumber(body.valor).toFixed(2);
  const payload = `00020101021226840014br.gov.bcb.pix2562pix.evparking.local/cob/${txid}520400005303986540${valor.length}${valor}5802BR5910EV PARKING6009SAO PAULO62070503***6304MOCK`;
  const qrCodeImage = await QRCode.toDataURL(payload, { margin: 1, width: 320 });
  const paymentId = `mock_${txid}`;
  const registro = {
    provider: 'mock',
    paymentId,
    txid,
    payload,
    qrCodeImage,
    expirationDate: toDateBRorISO(body.vencimento),
    status: 'PENDING',
    paid: false
  };
  memoria.set(paymentId, registro);
  return registro;
}

async function mpFetch(pathname, options = {}) {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) throw new Error('MERCADOPAGO_ACCESS_TOKEN não configurado no arquivo .env');

  const res = await fetch(`https://api.mercadopago.com${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detalhe = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Erro Mercado Pago ${res.status}: ${detalhe}`);
  }
  return data;
}

async function criarMercadoPagoPix(body) {
  const cliente = body.cliente || {};
  const valor = toMoneyNumber(body.valor);
  const idempotencyKey = crypto.randomUUID();

  const email = cliente.email || process.env.MERCADOPAGO_TEST_PAYER_EMAIL || 'cliente.teste@evparking.com.br';
  const descricao = body.descricao || `Recarga EV Parking - ${body.numero || body.faturaId}`;

  const payment = await mpFetch('/v1/payments', {
    method: 'POST',
    headers: {
      'X-Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify({
      transaction_amount: valor,
      description: descricao,
      payment_method_id: 'pix',
      external_reference: body.faturaId || body.numero || undefined,
      payer: {
        email,
        first_name: cliente.nome ? String(cliente.nome).split(' ')[0] : 'Cliente',
        last_name: cliente.nome ? String(cliente.nome).split(' ').slice(1).join(' ') || 'EV Parking' : 'EV Parking',
        identification: cliente.cpfCnpj ? {
          type: somenteNumeros(cliente.cpfCnpj).length > 11 ? 'CNPJ' : 'CPF',
          number: somenteNumeros(cliente.cpfCnpj)
        } : undefined
      }
    })
  });

  const txData = payment?.point_of_interaction?.transaction_data || {};
  const payload = txData.qr_code;
  const qrBase64 = txData.qr_code_base64;

  if (!payload && !qrBase64) {
    throw new Error('Mercado Pago não retornou QR Code Pix. Verifique se a credencial é do Brasil e está habilitada para Pix.');
  }

  const qrCodeImage = qrBase64
    ? `data:image/png;base64,${qrBase64}`
    : await QRCode.toDataURL(payload, { margin: 1, width: 320, errorCorrectionLevel: 'M' });

  return {
    provider: 'mercadopago',
    paymentId: String(payment.id),
    txid: String(payment.id),
    payload: payload || '',
    qrCodeImage,
    expirationDate: payment.date_of_expiration || null,
    status: payment.status || 'pending',
    paid: payment.status === 'approved'
  };
}

app.use(express.static(publicDir));

app.get('/api/health', (_, res) => {
  res.json({ ok: true, provider: PROVIDER });
});

app.get('/api/backup/status', async (_, res) => {
  try {
    await ensureBackupDir();
    const files = existsSync(BACKUP_DIR) ? (await fs.readdir(BACKUP_DIR)).filter(f => f.startsWith('evparking-backup-')).sort().reverse().slice(0, 20) : [];
    res.json({ ok: true, backupDir: BACKUP_DIR, intervalHours: BACKUP_INTERVAL_HOURS, keepLast: BACKUP_KEEP_LAST, ultimoBackup, files });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/backup/run', async (_, res) => {
  try {
    const backup = await criarBackupAutomatico('manual');
    res.json(backup);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


app.post('/api/pix/qrcode', async (req, res) => {
  try {
    const payload = String(req.body?.payload || '').trim();
    if (!payload) return res.status(400).json({ error: 'payload é obrigatório.' });
    const qrCodeImage = await QRCode.toDataURL(payload, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
    res.json({ ok: true, qrCodeImage });
  } catch (err) {
    console.error('Erro ao gerar imagem QR Code:', err);
    res.status(500).json({ error: err.message || 'Erro ao gerar QR Code.' });
  }
});

app.post('/api/pix/cobranca', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.valor || Number(body.valor) <= 0) return res.status(400).json({ error: 'Valor inválido.' });
    if (!body.faturaId) return res.status(400).json({ error: 'faturaId é obrigatório.' });

    let result;
    if (PROVIDER === 'mercadopago') {
      result = await criarMercadoPagoPix(body);
    } else {
      result = await criarMockPix(body);
    }

    memoria.set(result.paymentId, result);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Erro ao criar cobrança Pix.' });
  }
});

app.get('/api/pix/status/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;

    if (PROVIDER === 'mercadopago') {
      const status = await consultarMercadoPago(paymentId);
      const atual = memoria.get(String(paymentId)) || {};
      memoria.set(String(paymentId), { ...atual, ...status });
      return res.json(status);
    }

    const item = memoria.get(paymentId);
    if (!item) return res.status(404).json({ error: 'Cobrança não encontrada.' });
    res.json({ paymentId, status: item.status, paid: item.paid });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro ao consultar cobrança.' });
  }
});




async function estornarMercadoPagoPix(paymentId, amount = null) {
  const body = amount ? { amount: Number(amount) } : {};
  const refund = await mpFetch(`/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {
    method: 'POST',
    headers: {
      'X-Idempotency-Key': crypto.randomUUID(),
      'X-Render-In-Process-Refunds': 'true'
    },
    body: JSON.stringify(body)
  });

  return {
    paymentId: String(paymentId),
    refundId: refund.id ? String(refund.id) : null,
    id: refund.id ? String(refund.id) : null,
    status: refund.status || 'in_process',
    amount: refund.amount ?? amount ?? null,
    dateCreated: refund.date_created || null
  };
}

app.post('/api/pix/cancelar/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;

    if (PROVIDER === 'mercadopago') {
      const atual = await consultarMercadoPago(paymentId);
      if (atual.paid) return res.status(409).json({ error: 'Pagamento já aprovado. Para Pix pago, cancele por reembolso, não por cancelamento simples.' });
      const cancelado = await cancelarMercadoPagoPix(paymentId);
      memoria.set(String(paymentId), { ...(memoria.get(String(paymentId)) || {}), ...cancelado });
      return res.json({ ok: true, ...cancelado });
    }

    const item = memoria.get(paymentId) || { paymentId };
    item.status = 'CANCELLED';
    item.paid = false;
    memoria.set(paymentId, item);
    return res.json({ ok: true, paymentId, status: 'CANCELLED', paid: false });
  } catch (err) {
    console.error('Erro ao cancelar cobrança Pix:', err);
    res.status(500).json({ error: err.message || 'Erro ao cancelar cobrança Pix.' });
  }
});


app.post('/api/pix/estornar/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;

    if (PROVIDER !== 'mercadopago') {
      return res.status(400).json({ error: 'Estorno disponível apenas para Mercado Pago.' });
    }

    const atual = await consultarMercadoPago(paymentId);
    if (!atual.paid) {
      return res.status(409).json({ error: 'Pagamento ainda não está aprovado. Use cancelamento simples.' });
    }

    const refund = await estornarMercadoPagoPix(paymentId, req.body?.amount || null);
    const memAtual = memoria.get(String(paymentId)) || {};
    memoria.set(String(paymentId), { ...memAtual, ...atual, refund });

    return res.json({ ok: true, ...refund });
  } catch (err) {
    console.error('Erro ao estornar Pix:', err);
    res.status(500).json({ error: err.message || 'Erro ao estornar Pix.' });
  }
});

// Endpoint para simular pagamento no modo mock: POST /api/mock/pagar/mock_EVP...
app.post('/api/mock/pagar/:paymentId', (req, res) => {
  const item = memoria.get(req.params.paymentId);
  if (!item) return res.status(404).json({ error: 'Cobrança não encontrada.' });
  item.status = 'approved';
  item.paid = true;
  memoria.set(req.params.paymentId, item);
  res.json({ ok: true, paymentId: req.params.paymentId, paid: true });
});

function extrairPaymentIdWebhook(req) {
  return (
    req.body?.data?.id ||
    req.body?.id ||
    req.body?.resource?.split('/').pop() ||
    req.query?.['data.id'] ||
    req.query?.id ||
    req.query?.payment_id ||
    null
  );
}



async function cancelarMercadoPagoPix(paymentId) {
  const payment = await mpFetch(`/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'cancelled' })
  });
  return {
    paymentId: String(payment.id),
    status: payment.status || 'cancelled',
    paid: payment.status === 'approved'
  };
}

async function consultarMercadoPago(paymentId) {
  const payment = await mpFetch(`/v1/payments/${encodeURIComponent(paymentId)}`, { method: 'GET' });
  return {
    paymentId: String(payment.id),
    status: payment.status,
    statusDetail: payment.status_detail,
    paid: payment.status === 'approved',
    externalReference: payment.external_reference || null,
    dateApproved: payment.date_approved || null,
    transactionAmount: payment.transaction_amount || null
  };
}

// Webhook Mercado Pago: configure esta URL no painel do Mercado Pago.
// Em produção: https://SEU-DOMINIO.com/api/webhooks/mercadopago
// Em teste local: use ngrok e configure https://SEU-NGROK.ngrok-free.app/api/webhooks/mercadopago
app.post('/api/webhooks/mercadopago', async (req, res) => {
  try {
    console.log('Webhook Mercado Pago recebido:', JSON.stringify({ query: req.query, body: req.body }));

    const paymentId = extrairPaymentIdWebhook(req);
    if (!paymentId) return res.status(200).json({ received: true, ignored: 'sem paymentId' });

    const status = await consultarMercadoPago(paymentId);
    const atual = memoria.get(String(paymentId)) || {};
    memoria.set(String(paymentId), { ...atual, ...status });

    if (status.paid) {
      const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
      const data = result.rows[0]?.data || {};
      let atualizou = false;

      data.faturas = (data.faturas || []).map(f => {
        if (
          String(f.pixPaymentId || '') === String(paymentId) ||
          String(f.paymentId || '') === String(paymentId) ||
          String(f.pixTxid || '') === String(paymentId) ||
          String(f.id || '') === String(status.externalReference || '') ||
          String(f.numero || '') === String(status.externalReference || '')
        ) {
          atualizou = true;
          return {
            ...f,
            status: 'pago',
            pago: true,
            paid: true,
            pixStatus: 'APPROVED',
            dataPagamento: status.dateApproved || new Date().toISOString()
          };
        }
        return f;
      });

      if (atualizou) {
        await pool.query('UPDATE app_state SET data = $1 WHERE id = 1', [data]);
        console.log('Fatura atualizada no banco via webhook:', { paymentId, externalReference: status.externalReference });
      } else {
        console.log('Webhook recebido, mas nenhuma fatura foi encontrada para atualizar:', { paymentId, externalReference: status.externalReference });
      }
    }

    console.log('Pagamento atualizado via webhook:', status);
    return res.status(200).json({ received: true, ...status });
  } catch (err) {
    console.error('Erro no webhook Mercado Pago:', err);
    return res.status(200).json({ received: true, error: err.message });
  }
});

iniciarBackupAutomatico();
iniciarSyncAgendado();
iniciarAgendadorAniversarios();

app.listen(PORT, () => {
  console.log(`EV Parking Pix rodando em http://localhost:${PORT}`);
  console.log(`Provider: ${PROVIDER}`);
});
// rebuild
