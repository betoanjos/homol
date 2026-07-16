import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pool from './db.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const PORT = process.env.PORT || 3001;
const PROVIDER = (process.env.PIX_PROVIDER || 'mercadopago').toLowerCase().trim();

const memoria = new Map();

const SESSION_COOKIE = 'evcore_session';
const SESSION_MAX_AGE_HOURS = 8;
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/logout', '/api/me', '/api/health']);

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

  const adminUser = process.env.EVCORE_ADMIN_USER || process.env.ADMIN_USER || 'admin';
  const adminPassword = process.env.EVCORE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;

  if (adminPassword) {
    const passwordHash = hashPassword(adminPassword);
    await pool.query(`
      INSERT INTO app_users (username, password_hash, role)
      VALUES ($1, $2, 'admin')
      ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
    `, [adminUser, passwordHash]);
  } else {
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
    if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/api/webhooks/mercadopago')) return next();
    const user = await getSessionUser(req);
    if (user) {
      req.user = user;
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

await initStateDB();
await initAuthDB();

app.get('/login', async (req, res) => {
  const user = await getSessionUser(req);
  if (user) return res.redirect('/');
  return res.sendFile(path.join(publicDir, 'login.html'));
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha.' });

    const result = await pool.query('SELECT id, username, password_hash, role FROM app_users WHERE username = $1', [String(username).trim()]);
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO app_sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)`,
      [token, user.id, String(SESSION_MAX_AGE_HOURS)]
    );
    res.setHeader('Set-Cookie', sessionCookie(token));
    return res.json({ ok: true, user: { username: user.username, role: user.role } });
  } catch (err) {
    console.error('Erro no login:', err);
    return res.status(500).json({ error: 'Erro ao fazer login.' });
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

app.use(requireAuth);


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

app.listen(PORT, () => {
  console.log(`EV Parking Pix rodando em http://localhost:${PORT}`);
  console.log(`Provider: ${PROVIDER}`);
});
// rebuild
