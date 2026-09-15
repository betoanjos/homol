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
import { initTupiDB, syncTupi, getSyncStatus, listRecargas, iniciarSyncAgendado, ufPorContato } from './tupiSync.js';
import { fetchSessionUserData, tupiConfig } from './tupi.js';
import { initAniversariosDB, processarAniversarios, enviarTesteAniversario, statusAniversarios, iniciarAgendadorAniversarios, enviarEmailGenerico, aniversariosConfigurado } from './aniversarios.js';
import { initSegurancaDB, checarBloqueio, registrarFalhaLogin, limparFalhasLogin, twofaAtivo, twofaEmailDestino, criarOtp, validarOtp, emailCodigoHTML, emailAlertaLoginHTML, getClientIp, initDispositivosDB, confiarDispositivo, dispositivoConfiavel, revogarDispositivos, diasLembrarDispositivo } from './seguranca.js';
import { initContratosDB, criarContratosRouter, receberWebhookZapSign, exportarContratosBackup } from './contratos/index.js';
import { initEstadoDB, lerEstado, lerEstadoData, salvarEstado, listarHistorico, lerVersaoHistorico, restaurarVersao, ConflitoDeVersao, EstadoSuspeito } from './estado.js';
import { enviarBackup, backupRemotoConfigurado, s3Config } from './backupRemoto.js';
import { initRecargasDB, listarRecargas, salvarRecargas, excluirRecargas, contarRecargas, migrarRecargasDoEstado, listarVinculosRecargas } from './recargas.js';
import { initFaturasDB, listarFaturas, salvarFaturas, excluirFaturas, contarFaturas, migrarFaturasDoEstado, marcarFaturaPaga } from './faturas.js';
import { initPortaoDB, portaoConfig, portaoConfigurado, segredoConfere, registrarLiberacao, consumirPendente, listarEventos, aberturasNaUltimaHora, tokenDaEstacao, midiaJaUsada } from './portao.js';
import { montarCsvClientes, contarRecargasPorCliente, ufPorCliente } from './clientesCsv.js';
import { lerMensagemRecebida, mensagemPedeAbertura, mascararTelefone, midiaPareceUrl, resolverEstacaoDaMensagem } from './portaoMensagem.js';

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
  const state = await lerEstadoData();
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

  // Envio para fora do container. BACKUP_DIR fica no sistema de arquivos do
  // container, que o Railway apaga a cada deploy/restart — sem esta etapa o
  // backup existe apenas até o próximo deploy.
  const remoto = await enviarBackup([jsonFile, dumpFile]);

  ultimoBackup = { ok: true, criadoEm: new Date().toISOString(), motivo, jsonFile, dumpFile, dumpOk, dumpErro, remoto };
  await limparBackupsAntigos();

  // Um backup que só existe localmente é um backup perdido: avisa alto.
  if (!remoto.ok) {
    console.warn('BACKUP SEM CÓPIA REMOTA:', remoto.erro);
    await alertarFalhaBackup(remoto, { motivo, dumpErro }).catch(err => console.warn('Alerta de backup não enviado:', err.message));
  }

  return ultimoBackup;
}

// Avisa por e-mail quando o backup não sai do container. Só dispara se
// BACKUP_ALERTA_EMAIL estiver definido, e no máximo uma vez a cada 12h para
// não transformar uma configuração ausente em enxurrada de e-mails.
let ultimoAlertaBackup = 0;
async function alertarFalhaBackup(remoto, { motivo, dumpErro }) {
  const destino = process.env.BACKUP_ALERTA_EMAIL;
  if (!destino) return;
  const agora = Date.now();
  if (agora - ultimoAlertaBackup < 12 * 60 * 60 * 1000) return;
  ultimoAlertaBackup = agora;

  const html = `
    <p><strong>O backup do EV Core não foi copiado para fora do servidor.</strong></p>
    <p>Os arquivos foram gravados dentro do container, que é apagado a cada deploy ou reinício.
       Enquanto isso não for corrigido, não há backup recuperável.</p>
    <p><strong>Motivo:</strong> ${remoto.erro || 'desconhecido'}</p>
    ${dumpErro ? `<p><strong>pg_dump:</strong> ${dumpErro}</p>` : ''}
    <p>Execução: ${motivo} — ${new Date().toISOString()}</p>`;

  await enviarEmailGenerico({ para: destino, assunto: 'ALERTA: backup do EV Core sem cópia remota', html });
}

function iniciarBackupAutomatico() {
  if (backupRemotoConfigurado()) {
    const { endpoint, bucket } = s3Config();
    console.log(`Backup com cópia remota em ${endpoint}/${bucket}`);
  } else {
    console.warn('ATENÇÃO: backup sem armazenamento remoto. Os arquivos ficam no container e são perdidos a cada deploy. Configure BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID e BACKUP_S3_SECRET_ACCESS_KEY.');
  }
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
    // /api/portao/* tem autenticação própria por segredo compartilhado: quem
    // chama é a plataforma de WhatsApp e o controlador no portão, nenhum dos
    // dois tem sessão de usuário. As rotas de consulta do painel ficam sob
    // /api/portao/eventos, que exige sessão explicitamente.
    if (PUBLIC_PATHS.has(req.path)
        || req.path.startsWith('/api/webhooks/mercadopago')
        || req.path.startsWith('/api/webhooks/zapsign')
        || req.path === '/api/portao/whatsapp'
        || req.path === '/api/portao/pendente') return next();
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

await initEstadoDB();
await initRecargasDB();
await initFaturasDB();
await initPortaoDB();
// Move recargas e faturas que ainda estiverem no app_state para as tabelas
// próprias. Não bloqueia o boot: se falhar, o app sobe e a migração é tentada
// de novo no próximo restart (as operações são idempotentes).
await migrarRecargasDoEstado().catch(err => console.error('Migração de recargas falhou (será repetida no próximo boot):', err.message));
await migrarFaturasDoEstado().catch(err => console.error('Migração de faturas falhou (será repetida no próximo boot):', err.message));
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


// O estado vem com __version: a versão que esta leitura enxergou. O cliente
// devolve esse número no POST para que gravações em cima de dados velhos
// sejam recusadas em vez de apagarem o trabalho de outra sessão.
app.get('/api/state', async (req, res) => {
  try {
    const { data, version, updatedAt, updatedBy } = await lerEstado();
    // As recargas moram em tabela própria, mas o painel recebe a lista junto
    // com o estado, como sempre recebeu — nada muda na leitura.
    // Se a migração ainda não completou, a tabela está vazia e o documento
    // ainda tem a lista: servimos a do documento para o painel nunca aparecer
    // sem dados enquanto eles existem.
    const [recargasBanco, faturasBanco] = await Promise.all([listarRecargas(), listarFaturas()]);
    const recargas = recargasBanco.length ? recargasBanco : (Array.isArray(data.recargas) ? data.recargas : []);
    const faturas = faturasBanco.length ? faturasBanco : (Array.isArray(data.faturas) ? data.faturas : []);
    res.json({ ...data, recargas, faturas, __version: version, __updatedAt: updatedAt, __updatedBy: updatedBy });
  } catch (err) {
    console.error('Erro ao carregar estado:', err);
    res.status(500).json({ error: 'Erro ao carregar dados.' });
  }
});

app.post('/api/state', async (req, res) => {
  try {
    const corpo = req.body || {};
    // Metadados de controle não são persistidos junto com o estado.
    const { __version, __updatedAt, __updatedBy, __forcar, ...estado } = corpo;
    // Recargas têm tabela e endpoint próprios. Um cliente que ainda as envia
    // no estado é uma aba aberta desde antes do deploy: descartar em silêncio
    // faria as edições de recarga dessa aba sumirem sem aviso. Recusamos e
    // pedimos recarga da página, que é o único caminho que não perde nada.
    if (Array.isArray(estado.recargas) || Array.isArray(estado.faturas)) {
      // 426 e não 409: o 409 significa conflito de versão e faria o cliente
      // antigo exibir "outra sessão alterou os dados", que é enganoso aqui.
      return res.status(426).json({
        error: 'Esta página está desatualizada. Recarregue (F5) antes de continuar — suas alterações não foram gravadas.',
        recarregar: true
      });
    }

    // Se a migração não completou, o documento ainda guarda recargas/faturas e
    // este corpo (cliente novo) não as traz. Gravar assim apagaria as listas do
    // documento sem que existissem nas tabelas. Tentamos migrar — as operações
    // são idempotentes — e só então seguimos.
    const antes = await lerEstado();
    const pendente = ['recargas', 'faturas'].filter(k => Array.isArray(antes.data[k]) && antes.data[k].length);
    if (pendente.length) {
      if (pendente.includes('recargas')) await migrarRecargasDoEstado();
      if (pendente.includes('faturas')) await migrarFaturasDoEstado();

      const depois = await lerEstado();
      const aindaPendente = ['recargas', 'faturas'].filter(k => Array.isArray(depois.data[k]) && depois.data[k].length);
      if (aindaPendente.length) {
        return res.status(503).json({ error: `Migração pendente no servidor (${aindaPendente.join(', ')}). Tente salvar novamente em instantes.` });
      }
      // A migração alterou o documento, então a versão que este cliente tinha
      // ficou velha. Devolvemos o estado atual para ele recarregar e repetir.
      const [recargasAtuais, faturasAtuais] = await Promise.all([listarRecargas(), listarFaturas()]);
      return res.status(409).json({
        error: 'Os dados foram reorganizados no servidor. Recarregando para continuar.',
        conflito: true,
        versaoAtual: depois.version,
        estadoAtual: { ...depois.data, recargas: recargasAtuais, faturas: faturasAtuais, __version: depois.version }
      });
    }
    const resultado = await salvarEstado(estado, {
      baseVersion: __version == null ? null : Number(__version),
      usuario: req.user?.username || null,
      motivo: 'api',
      forcar: __forcar === true
    });
    res.json({ ok: true, version: resultado.version, updatedAt: resultado.updatedAt });
  } catch (err) {
    if (err instanceof ConflitoDeVersao) {
      return res.status(409).json({
        error: err.message,
        conflito: true,
        versaoAtual: err.versaoAtual,
        estadoAtual: { ...err.estadoAtual, __version: err.versaoAtual }
      });
    }
    if (err instanceof EstadoSuspeito) {
      return res.status(422).json({ error: err.message, suspeito: true, perdas: err.perdas });
    }
    console.error('Erro ao salvar estado:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro ao salvar dados.' });
  }
});

// Grava um lote de recargas (as que mudaram no painel) e remove as excluídas.
// O painel manda só o diff, então o corpo é proporcional ao que foi alterado
// e não ao tamanho do histórico.
app.post('/api/recargas/lote', async (req, res) => {
  try {
    const { alteradas = [], removidas = [] } = req.body || {};
    if (!Array.isArray(alteradas) || !Array.isArray(removidas)) {
      return res.status(400).json({ error: 'Formato inválido: alteradas e removidas devem ser listas.' });
    }
    const gravadas = await salvarRecargas(alteradas, { usuario: req.user?.username || null });
    const excluidas = await excluirRecargas(removidas);
    res.json({ ok: true, gravadas, excluidas, total: await contarRecargas() });
  } catch (err) {
    console.error('Erro ao gravar recargas:', err);
    res.status(500).json({ error: 'Erro ao gravar recargas.' });
  }
});

app.get('/api/recargas/contagem', async (_req, res) => {
  try {
    res.json({ total: await contarRecargas() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mesmo desenho das recargas: o painel manda só as faturas que mudaram.
app.post('/api/faturas/lote', async (req, res) => {
  try {
    const { alteradas = [], removidas = [] } = req.body || {};
    if (!Array.isArray(alteradas) || !Array.isArray(removidas)) {
      return res.status(400).json({ error: 'Formato inválido: alteradas e removidas devem ser listas.' });
    }
    const gravadas = await salvarFaturas(alteradas, { usuario: req.user?.username || null });
    const excluidas = await excluirFaturas(removidas);
    res.json({ ok: true, gravadas, excluidas, total: await contarFaturas() });
  } catch (err) {
    console.error('Erro ao gravar faturas:', err);
    res.status(500).json({ error: 'Erro ao gravar faturas.' });
  }
});

app.get('/api/faturas/contagem', async (_req, res) => {
  try {
    res.json({ total: await contarFaturas() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Histórico de versões do estado — permite auditar e desfazer uma gravação
// ruim sem esperar/restaurar o backup de 6 horas.
app.get('/api/state/historico', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
    res.json({ versoes: await listarHistorico(req.query.limite) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/state/historico/:version', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
    const versao = await lerVersaoHistorico(req.params.version);
    if (!versao) return res.status(404).json({ error: 'Versão não encontrada.' });
    res.json(versao);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/state/restaurar/:version', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
    const r = await restaurarVersao(req.params.version, { usuario: req.user?.username || null });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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
// Inspeciona o payload BRUTO que a Tupi devolve, para responder se algum dado
// que hoje não é lido chega pela API — a pergunta concreta foi desconto/cupom,
// que o painel só conhece pelas colunas do CSV.
//
// O sync guarda a sessão inteira em tupi_sessions.raw, então dá para responder
// sobre o histórico todo sem chamar a Tupi de novo. A varredura por palavra é o
// que fecha a questão: um campo de desconto pode simplesmente não aparecer nas
// sessões sem desconto, e olhar poucas amostras daria falso negativo.
//
// Uso: GET /api/tupi/campos-brutos
// ── Grade de proteção da estação ────────────────────────────────────────────
// Ver server/portao.js para o desenho e o porquê de cada decisão.

// Chamado pela plataforma de WhatsApp quando chega mensagem no número.
// Autenticado pelo segredo compartilhado, não por sessão de usuário.
app.post('/api/portao/whatsapp', async (req, res) => {
  const cfg = portaoConfig();
  try {
    if (!portaoConfigurado(cfg)) {
      return res.status(503).json({ error: 'Liberação da grade não configurada no servidor.' });
    }
    // Aceita o segredo por header ou no corpo — as plataformas variam no que
    // conseguem enviar.
    const recebido = req.get('X-Portao-Secret') || req.body?.secret || '';
    if (!segredoConfere(recebido, cfg.webhookSecret)) {
      console.warn('Portão: chamada recusada por segredo inválido.', { ip: getClientIp(req) });
      return res.status(401).json({ error: 'Não autorizado.' });
    }

    const { telefone, texto, midiaUrl } = lerMensagemRecebida(req.body || {});
    const mascarado = mascararTelefone(telefone);
    const foto = midiaPareceUrl(midiaUrl) ? midiaUrl : null;

    // Qual estação a mensagem libera. Cada estação tem sua frase, cadastrada
    // no próprio cadastro dela; a frase do PORTAO_PALAVRA continua valendo
    // como portão padrão, para a estação que já operava antes disso existir.
    const estacoes = (await lerEstadoData())?.estacoes || [];
    const estacao = resolverEstacaoDaMensagem(estacoes, texto);
    const ehPadrao = !estacao && mensagemPedeAbertura(texto, cfg.palavra);

    // Mensagem comum no mesmo número não pode acionar o trinco. Responde 200
    // para a plataforma não ficar reenviando: recebemos e decidimos ignorar.
    if (!estacao && !ehPadrao) {
      return res.json({
        ok: true, abriu: false, motivo: 'mensagem não é pedido de abertura',
        resposta: 'Não reconheci este pedido. Use o QR Code da grade para liberar o acesso.'
      });
    }
    if (!telefone) {
      return res.json({
        ok: true, abriu: false, motivo: 'sem telefone identificado',
        resposta: 'Não consegui identificar seu número. Tente novamente pelo QR Code da grade.'
      });
    }

    // Foto da placa: rastro que fica junto do telefone e do horário. Só barra
    // a abertura quando PORTAO_EXIGIR_FOTO=true — assim dá para ligar o fluxo,
    // confirmar no histórico que a URL está mesmo chegando, e só então passar
    // a exigir. Exigir antes de confirmar deixaria o motorista trancado do
    // lado de fora às 3 da manhã por um campo mal mapeado na automação.
    if (cfg.exigirMidia && !foto) {
      console.warn('Portão: liberação recusada por falta da foto da placa.', { telefone: mascarado });
      return res.json({
        ok: true, abriu: false, motivo: 'foto da placa não recebida',
        resposta: 'Para liberar, envie também uma foto da placa do veículo.'
      });
    }

    // Foto repetida vale como foto ausente. A plataforma guarda a última
    // imagem no cadastro do contato: se a pessoa responder com texto, o campo
    // não é atualizado e a automação reenvia a foto da vez anterior — um
    // endereço válido, indistinguível de uma foto nova. Sem esta checagem,
    // responder qualquer coisa abriria a grade a partir da segunda vez.
    if (cfg.exigirMidia && foto && await midiaJaUsada(foto)) {
      console.warn('Portão: liberação recusada por foto repetida.', { telefone: mascarado });
      return res.json({
        ok: true, abriu: false, motivo: 'foto da placa repetida',
        resposta: 'Essa foto já foi usada. Tire uma foto nova da placa do veículo para liberar.'
      });
    }

    const jaPediu = await aberturasNaUltimaHora(telefone);
    if (jaPediu >= cfg.limiteHora) {
      console.warn('Portão: limite por hora atingido.', { telefone: mascarado, jaPediu });
      return res.json({
        ok: true, abriu: false, motivo: 'limite por hora atingido',
        resposta: 'Você já solicitou a abertura várias vezes na última hora. Se houver algum problema, fale com a gente.'
      });
    }

    const lib = await registrarLiberacao({
      telefone, telefoneMascarado: mascarado, midiaUrl: foto,
      estacaoId: estacao?.id || null, estacaoNome: estacao?.nome || null
    });
    console.log('Portão: liberação registrada.', {
      id: lib.id, telefone: mascarado, comFoto: Boolean(foto),
      estacao: estacao?.nome || '(portão padrão)'
    });

    // `resposta` é o texto que a plataforma deve devolver ao motorista.
    res.json({
      ok: true,
      abriu: true,
      liberacaoId: lib.id,
      validaPorSegundos: cfg.janelaSeg,
      comFoto: Boolean(foto),
      estacao: estacao?.nome || null,
      resposta: `EV Parking — grade liberada. Você tem ${cfg.janelaSeg} segundos para abrir. Ao terminar a recarga, feche a grade: ela tranca sozinha.`
    });
  } catch (err) {
    console.error('Erro na liberação da grade:', err);
    res.status(500).json({ error: 'Erro ao processar a liberação.' });
  }
});

// Consultado pelo controlador no portão a cada poucos segundos. Consultar em
// vez de receber conexão dispensa IP fixo e porta aberta — funciona atrás do
// NAT da operadora móvel.
app.get('/api/portao/pendente', async (req, res) => {
  const cfg = portaoConfig();
  try {
    if (!portaoConfigurado(cfg)) return res.status(503).json({ abrir: false });

    // Cada controlador consulta a fila da sua estação, com o token dela.
    // Sem o parâmetro, é o portão padrão — a estação que já operava antes de
    // existir roteamento, com o PORTAO_TOKEN raiz.
    const estacaoId = String(req.query.estacao || '').trim() || null;
    const recebido = req.get('X-Portao-Token') || req.query.token || '';
    if (!segredoConfere(recebido, tokenDaEstacao(estacaoId, cfg))) {
      return res.status(401).json({ abrir: false });
    }

    const pendente = await consumirPendente(estacaoId);
    if (!pendente) return res.json({ abrir: false });

    console.log('Portão: trinco acionado.', {
      id: pendente.id, telefone: pendente.telefone_mascarado,
      estacao: pendente.estacao_nome || '(portão padrão)'
    });
    res.json({ abrir: true, liberacaoId: pendente.id });
  } catch (err) {
    console.error('Erro ao consultar liberação da grade:', err);
    res.status(500).json({ abrir: false });
  }
});

// Reúne o que a segmentação precisa: a base, quantas recargas cada cliente
// fez e a UF de cada um. Compartilhado pela exportação e pelo resumo, para os
// dois nunca discordarem sobre quem entra na campanha.
async function prepararSegmentoClientes(req) {
  const estado = await lerEstadoData();
  const clientes = estado?.clientes || [];
  const grupos = estado?.gruposClientes || [];

  const [vinculos, ufsBrutas] = await Promise.all([listarVinculosRecargas(), ufPorContato()]);

  return {
    clientes,
    grupos,
    opcoes: {
      contagens: contarRecargasPorCliente(clientes, vinculos),
      ufs: ufPorCliente(clientes, ufsBrutas),
      minRecargas: Math.max(0, Number(req.query.minRecargas || 0)),
      uf: String(req.query.uf || '').trim().toUpperCase()
    }
  };
}

// Base de clientes em CSV, para importar em ferramenta de campanha.
// Filtros opcionais: ?minRecargas=2 (recorrentes) e ?uf=PR (por estado).
//
// Restrito ao administrador: é a lista de e-mails e telefones dos clientes.
// Uso: GET /api/clientes/csv — o navegador baixa o arquivo direto.
app.get('/api/clientes/csv', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
    const { opcoes, clientes, grupos } = await prepararSegmentoClientes(req);
    const { csv, total, semEmail, duplicados, foraDoFiltro } = montarCsvClientes(clientes, grupos, opcoes);

    console.log('Exportação de clientes:', {
      total, semEmail, duplicados, foraDoFiltro,
      minRecargas: opcoes.minRecargas, uf: opcoes.uf, por: req.user?.username
    });

    const hoje = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="clientes-evparking-${hoje}.csv"`);
    // BOM para o Excel abrir os acentos corretamente.
    res.send('﻿' + csv);
  } catch (err) {
    console.error('Erro ao exportar clientes:', err);
    res.status(500).json({ error: err.message });
  }
});

// Quantos clientes a exportação traria, sem baixar o arquivo.
app.get('/api/clientes/csv/resumo', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
    const { opcoes, clientes, grupos } = await prepararSegmentoClientes(req);
    const r = montarCsvClientes(clientes, grupos, opcoes);

    // Quantos há em cada estado e quantos são recorrentes, para escolher o
    // recorte sabendo o tamanho antes de montar a campanha.
    const porUf = {};
    opcoes.ufs.forEach(uf => { porUf[uf] = (porUf[uf] || 0) + 1; });
    const recorrentes = [...opcoes.contagens.values()].filter(n => n >= 2).length;

    res.json({
      cadastrados: clientes.length,
      exportaveis: r.total,
      semEmailValido: r.semEmail,
      duplicados: r.duplicados,
      foraDoFiltro: r.foraDoFiltro,
      semUfConhecida: r.semUfConhecida,
      filtros: { minRecargas: opcoes.minRecargas, uf: opcoes.uf || null },
      clientesComDuasOuMaisRecargas: recorrentes,
      porUf
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Portões configurados e o token de cada controlador, para o painel.
//
// Restrito ao administrador: aqui aparecem os segredos que abrem os trincos.
// Eles são derivados do PORTAO_TOKEN e não ficam gravados em lugar nenhum —
// guardá-los no app_state os exporia a qualquer usuário logado.
app.get('/api/portao/portoes', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
    const cfg = portaoConfig();
    const estacoes = (await lerEstadoData())?.estacoes || [];

    const portoes = estacoes
      .filter(e => e && String(e.palavraLiberacao || '').trim())
      .map(e => ({
        estacaoId: e.id,
        nome: e.nome,
        palavra: e.palavraLiberacao,
        token: tokenDaEstacao(e.id, cfg),
        consulta: `/api/portao/pendente?estacao=${encodeURIComponent(e.id)}`
      }));

    // O portão padrão só aparece enquanto a frase do ambiente não tiver sido
    // migrada para o cadastro de alguma estação.
    const jaMigrado = portoes.some(p => p.palavra.trim().toLowerCase() === cfg.palavra.trim().toLowerCase());
    if (!jaMigrado) {
      portoes.unshift({
        estacaoId: null,
        nome: 'Portão padrão (sem estação vinculada)',
        palavra: cfg.palavra,
        token: tokenDaEstacao(null, cfg),
        consulta: '/api/portao/pendente'
      });
    }

    res.json({ configurado: portaoConfigurado(cfg), portoes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Histórico de aberturas, para o painel. Exige sessão como o resto da API.
app.get('/api/portao/eventos', async (req, res) => {
  try {
    const cfg = portaoConfig();
    res.json({
      configurado: portaoConfigurado(cfg),
      palavra: cfg.palavra,
      janelaSeg: cfg.janelaSeg,
      limiteHora: cfg.limiteHora,
      exigeFoto: cfg.exigirMidia,
      // O telefone completo é o que fecha o rastro numa ocorrência — com ele,
      // a foto e o horário, dá para ligar para a pessoa ou entregar à polícia.
      // Fica restrito ao administrador: o perfil de leitura não precisa de uma
      // lista de telefones de clientes na tela, e telefone é dado pessoal.
      eventos: (await listarEventos(req.query.limite)).map(e =>
        req.user?.role === 'admin' ? e : { ...e, telefone: undefined })
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A API da Tupi publica a sessão enquanto ela acontece, ou só depois de
// encerrada? É o que decide se dá para usar o início da recarga como gatilho
// para abrir a grade de proteção da estação.
//
// Responde a partir das sessões já sincronizadas, sem chamar a Tupi.
// Uso: GET /api/tupi/sessoes-ao-vivo
app.get('/api/tupi/sessoes-ao-vivo', async (_req, res) => {
  try {
    const total = (await pool.query('SELECT COUNT(*)::int AS n FROM tupi_sessions')).rows[0]?.n || 0;
    if (!total) return res.json({ total: 0, aviso: 'Nenhuma sessão sincronizada ainda.' });

    // Sessão em andamento não tem hora de término. Se nunca apareceu nenhuma,
    // a API só publica o que já acabou.
    const semFim = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM tupi_sessions WHERE end_date_time IS NULL OR raw->>'end_date_time' IS NULL`
    )).rows[0]?.n || 0;

    const porStatus = (await pool.query(
      `SELECT COALESCE(status, '(nulo)') AS status, COUNT(*)::int AS n
         FROM tupi_sessions GROUP BY 1 ORDER BY n DESC`
    )).rows;

    // Quanto tempo depois do fim a Tupi tocou no registro pela última vez.
    // Perto de zero em todas = o registro nasce já encerrado.
    const atraso = (await pool.query(
      `SELECT ROUND(MIN(EXTRACT(EPOCH FROM (last_updated - end_date_time))))::int  AS min_seg,
              ROUND(AVG(EXTRACT(EPOCH FROM (last_updated - end_date_time))))::int  AS media_seg,
              ROUND(MAX(EXTRACT(EPOCH FROM (last_updated - end_date_time))))::int  AS max_seg,
              COUNT(*) FILTER (WHERE last_updated < end_date_time)::int             AS atualizadas_antes_do_fim
         FROM tupi_sessions
        WHERE end_date_time IS NOT NULL AND last_updated IS NOT NULL`
    )).rows[0] || {};

    // Duração típica: com sync de hora em hora e sessões longas, se a API
    // mostrasse sessão ao vivo teríamos capturado várias em andamento.
    const duracao = (await pool.query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (end_date_time - start_date_time))/60))::int AS media_min,
              ROUND(MAX(EXTRACT(EPOCH FROM (end_date_time - start_date_time))/60))::int AS max_min
         FROM tupi_sessions
        WHERE end_date_time IS NOT NULL AND start_date_time IS NOT NULL
          AND end_date_time > start_date_time`
    )).rows[0] || {};

    const aoVivo = semFim > 0 || (atraso.atualizadas_antes_do_fim || 0) > 0;
    res.json({
      total,
      sessoesSemHoraDeTermino: semFim,
      porStatus,
      atrasoDoUltimoUpdateAposOFim: atraso,
      duracaoDasSessoes: duracao,
      conclusao: aoVivo
        ? 'Há sessões registradas antes de terminar — a API publica sessão ao vivo e ela pode servir de gatilho.'
        : `Nenhuma das ${total} sessões foi vista em andamento. A API só publica sessão encerrada, então o início da recarga não serve de gatilho para a grade.`
    });
  } catch (err) {
    console.error('Erro no diagnóstico de sessões ao vivo:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tupi/campos-brutos', async (_req, res) => {
  try {
    const total = (await pool.query('SELECT COUNT(*)::int AS n FROM tupi_sessions')).rows[0]?.n || 0;
    if (!total) return res.json({ total: 0, aviso: 'Nenhuma sessão sincronizada ainda.' });

    // Todas as chaves de primeiro nível já vistas, em qualquer sessão.
    const chaves = (await pool.query(
      `SELECT DISTINCT jsonb_object_keys(raw) AS chave FROM tupi_sessions ORDER BY chave`
    )).rows.map(r => r.chave);

    // Chaves dentro de total_cost, onde valores monetários costumam ficar.
    const chavesCusto = (await pool.query(
      `SELECT DISTINCT jsonb_object_keys(raw->'total_cost') AS chave
         FROM tupi_sessions
        WHERE jsonb_typeof(raw->'total_cost') = 'object'
        ORDER BY chave`
    )).rows.map(r => r.chave);

    // Varredura textual: se nenhuma sessão contém nada parecido com desconto,
    // a resposta é definitiva — a Tupi não manda esse dado.
    const termos = ['coupon', 'discount', 'cupom', 'desconto', 'promo', 'voucher', 'rebate'];
    const ocorrencias = {};
    for (const termo of termos) {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM tupi_sessions WHERE raw::text ILIKE '%' || $1 || '%'`, [termo]
      );
      ocorrencias[termo] = r.rows[0]?.n || 0;
    }

    // Uma sessão com valor cobrado, como exemplo para leitura humana.
    const exemplo = (await pool.query(
      `SELECT raw FROM tupi_sessions WHERE kwh > 0 ORDER BY start_date_time DESC LIMIT 1`
    )).rows[0]?.raw || null;

    const achou = Object.values(ocorrencias).some(n => n > 0);
    res.json({
      total,
      chavesDeSessao: chaves,
      chavesDeTotalCost: chavesCusto,
      ocorrenciasPorTermo: ocorrencias,
      conclusao: achou
        ? 'Há sessões contendo termos de desconto — vale inspecionar o exemplo e passar a ler o campo.'
        : 'Nenhuma sessão contém qualquer termo de desconto/cupom. A API da Tupi não envia esse dado.',
      exemploSessao: exemplo
    });
  } catch (err) {
    console.error('Erro no diagnóstico de campos brutos:', err);
    res.status(500).json({ error: err.message });
  }
});

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
    const state = await lerEstadoData();
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
    // Os arquivos listados vivem no container e somem no próximo deploy. Só há
    // backup recuperável de verdade quando o envio remoto está configurado.
    const cfg = s3Config();
    const remotoConfigurado = backupRemotoConfigurado(cfg);
    res.json({
      ok: true,
      backupDir: BACKUP_DIR,
      intervalHours: BACKUP_INTERVAL_HOURS,
      keepLast: BACKUP_KEEP_LAST,
      ultimoBackup,
      files,
      armazenamentoEfemero: !remotoConfigurado,
      remoto: {
        configurado: remotoConfigurado,
        destino: remotoConfigurado ? `${cfg.endpoint}/${cfg.bucket}` : null,
        ultimoEnvio: ultimoBackup?.remoto || null
      },
      aviso: remotoConfigurado
        ? null
        : 'Sem armazenamento remoto: estes arquivos existem apenas dentro do container e serão perdidos no próximo deploy. Configure BACKUP_S3_*.'
    });
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
      // A fatura vive em tabela própria: a baixa altera só a linha dela, sem
      // read-modify-write no documento de estado inteiro.
      const { alterado, faturas: baixadas } = await marcarFaturaPaga(paymentId, status);

      if (alterado) {
        console.log('Fatura atualizada no banco via webhook:', { paymentId, externalReference: status.externalReference, faturas: baixadas });
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
