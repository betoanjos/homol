// Sincronização Tupi (OCPI) -> Postgres — EV Parking
// - Cria as tabelas necessárias
// - Sync incremental por last_updated (com buffer de sobreposição)
// - Agendador no mesmo padrão do backup automático

import pool from './db.js';
import { fetchAllSessions, fetchSessionUserData, tupiConfigurado, tupiConfig } from './tupi.js';

const SYNC_INTERVAL_MIN = Number(process.env.TUPI_SYNC_INTERVAL_MIN || 60);
const INITIAL_DAYS = Number(process.env.TUPI_SYNC_INITIAL_DAYS || 30);
const OVERLAP_MIN = Number(process.env.TUPI_SYNC_OVERLAP_MIN || 10);
const USERDATA_CONCURRENCY = Math.max(1, Number(process.env.TUPI_USERDATA_CONCURRENCY || 4));
const USERDATA_MAX_PER_RUN = Number(process.env.TUPI_USERDATA_MAX_PER_RUN || 1000);

let sincronizando = false;

export async function initTupiDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tupi_sessions (
      id TEXT PRIMARY KEY,
      country_code TEXT,
      party_id TEXT,
      currency TEXT,
      start_date_time TIMESTAMPTZ,
      end_date_time TIMESTAMPTZ,
      kwh NUMERIC,
      status TEXT,
      auth_method TEXT,
      authorization_reference TEXT,
      total_cost_excl_vat NUMERIC,
      total_cost_incl_vat NUMERIC,
      meter_id TEXT,
      location_id TEXT,
      evse_uid TEXT,
      connector_id TEXT,
      last_updated TIMESTAMPTZ,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tupi_sessions_start ON tupi_sessions (start_date_time DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tupi_sessions_updated ON tupi_sessions (last_updated DESC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tupi_session_users (
      session_id TEXT PRIMARY KEY REFERENCES tupi_sessions(id) ON DELETE CASCADE,
      found BOOLEAN NOT NULL DEFAULT FALSE,
      name TEXT,
      document TEXT,
      email TEXT,
      street_name TEXT,
      number TEXT,
      district TEXT,
      city TEXT,
      state TEXT,
      zip_code TEXT,
      cars JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tupi_users_document ON tupi_session_users (document);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tupi_sync_state (
      id INTEGER PRIMARY KEY,
      last_updated_cursor TIMESTAMPTZ,
      last_sync_at TIMESTAMPTZ,
      last_run_ok BOOLEAN,
      last_run_message TEXT,
      last_run_sessions INTEGER,
      last_run_users INTEGER
    );
  `);
  await pool.query(`INSERT INTO tupi_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function upsertSession(s) {
  await pool.query(
    `INSERT INTO tupi_sessions
      (id, country_code, party_id, currency, start_date_time, end_date_time, kwh, status,
       auth_method, authorization_reference, total_cost_excl_vat, total_cost_incl_vat,
       meter_id, location_id, evse_uid, connector_id, last_updated, raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, NOW())
     ON CONFLICT (id) DO UPDATE SET
       country_code = EXCLUDED.country_code,
       party_id = EXCLUDED.party_id,
       currency = EXCLUDED.currency,
       start_date_time = EXCLUDED.start_date_time,
       end_date_time = EXCLUDED.end_date_time,
       kwh = EXCLUDED.kwh,
       status = EXCLUDED.status,
       auth_method = EXCLUDED.auth_method,
       authorization_reference = EXCLUDED.authorization_reference,
       total_cost_excl_vat = EXCLUDED.total_cost_excl_vat,
       total_cost_incl_vat = EXCLUDED.total_cost_incl_vat,
       meter_id = EXCLUDED.meter_id,
       location_id = EXCLUDED.location_id,
       evse_uid = EXCLUDED.evse_uid,
       connector_id = EXCLUDED.connector_id,
       last_updated = EXCLUDED.last_updated,
       raw = EXCLUDED.raw,
       synced_at = NOW()`,
    [
      s.id, s.country_code || null, s.party_id || null, s.currency || null,
      s.start_date_time || null, s.end_date_time || null, num(s.kwh), s.status || null,
      s.auth_method || null, s.authorization_reference || null,
      num(s.total_cost?.excl_vat), num(s.total_cost?.incl_vat),
      s.meter_id || null, s.location_id || null, s.evse_uid || null, s.connector_id || null,
      s.last_updated || null, JSON.stringify(s)
    ]
  );
}

async function upsertUserData(sessionId, userData) {
  if (!userData) {
    await pool.query(
      `INSERT INTO tupi_session_users (session_id, found, fetched_at)
       VALUES ($1, FALSE, NOW())
       ON CONFLICT (session_id) DO UPDATE SET found = FALSE, fetched_at = NOW()`,
      [sessionId]
    );
    return;
  }
  await pool.query(
    `INSERT INTO tupi_session_users
      (session_id, found, name, document, email, street_name, number, district, city, state, zip_code, cars, fetched_at)
     VALUES ($1, TRUE, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       found = TRUE, name = EXCLUDED.name, document = EXCLUDED.document, email = EXCLUDED.email,
       street_name = EXCLUDED.street_name, number = EXCLUDED.number, district = EXCLUDED.district,
       city = EXCLUDED.city, state = EXCLUDED.state, zip_code = EXCLUDED.zip_code,
       cars = EXCLUDED.cars, fetched_at = NOW()`,
    [
      sessionId, userData.name || null, userData.document || null, userData.email || null,
      userData.street_name || null, userData.number || null, userData.district || null,
      userData.city || null, userData.state || null, userData.zip_code || null,
      userData.cars ? JSON.stringify(userData.cars) : null
    ]
  );
}

// Executa fetchers em pequenos lotes concorrentes.
async function emLotes(itens, concorrencia, tarefa) {
  let i = 0;
  async function worker() {
    while (i < itens.length) {
      const idx = i++;
      await tarefa(itens[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concorrencia, itens.length) }, worker));
}

export async function syncTupi({ motivo = 'manual', full = false } = {}) {
  if (!tupiConfigurado()) throw new Error('Integração Tupi não configurada (defina TUPI_TOKEN e TUPI_PARTY_ID).');
  if (sincronizando) return { skipped: true, motivo: 'já em execução' };
  sincronizando = true;

  const inicio = Date.now();
  try {
    // Janela incremental
    let dateFrom;
    if (!full) {
      const cur = await pool.query('SELECT last_updated_cursor FROM tupi_sync_state WHERE id = 1');
      const cursor = cur.rows[0]?.last_updated_cursor;
      if (cursor) {
        dateFrom = new Date(new Date(cursor).getTime() - OVERLAP_MIN * 60 * 1000).toISOString();
      }
    }
    if (!dateFrom) {
      dateFrom = new Date(Date.now() - INITIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    }
    const dateTo = new Date().toISOString();

    const sessions = await fetchAllSessions({ dateFrom, dateTo });

    let maxUpdated = null;
    for (const s of sessions) {
      if (!s?.id) continue;
      await upsertSession(s);
      if (s.last_updated) {
        const t = new Date(s.last_updated).getTime();
        if (!maxUpdated || t > maxUpdated) maxUpdated = t;
      }
    }

    // Descobre sessões que ainda precisam de user-data (sem registro found=true).
    const { countryCode, partyId } = tupiConfig();
    let usuariosBuscados = 0;
    if (partyId) {
      const pend = await pool.query(
        `SELECT s.id, s.country_code
           FROM tupi_sessions s
           LEFT JOIN tupi_session_users u ON u.session_id = s.id
          WHERE u.session_id IS NULL OR u.found = FALSE
          ORDER BY s.start_date_time DESC
          LIMIT $1`,
        [USERDATA_MAX_PER_RUN]
      );
      await emLotes(pend.rows, USERDATA_CONCURRENCY, async (row) => {
        try {
          const ud = await fetchSessionUserData(row.id, { countryCode: row.country_code || countryCode, partyId });
          await upsertUserData(row.id, ud);
          usuariosBuscados++;
        } catch (err) {
          console.warn(`Tupi user-data falhou para ${row.id}:`, err.message);
        }
      });
    }

    const novoCursor = maxUpdated ? new Date(maxUpdated).toISOString() : dateTo;
    const mensagem = `${sessions.length} sessões, ${usuariosBuscados} usuários (${((Date.now() - inicio) / 1000).toFixed(1)}s)`;
    await pool.query(
      `UPDATE tupi_sync_state
          SET last_updated_cursor = $1, last_sync_at = NOW(),
              last_run_ok = TRUE, last_run_message = $2,
              last_run_sessions = $3, last_run_users = $4
        WHERE id = 1`,
      [novoCursor, mensagem, sessions.length, usuariosBuscados]
    );

    return { ok: true, motivo, dateFrom, dateTo, sessions: sessions.length, users: usuariosBuscados };
  } catch (err) {
    await pool.query(
      `UPDATE tupi_sync_state SET last_sync_at = NOW(), last_run_ok = FALSE, last_run_message = $1 WHERE id = 1`,
      [err.message]
    ).catch(() => null);
    throw err;
  } finally {
    sincronizando = false;
  }
}

export async function getSyncStatus() {
  const r = await pool.query('SELECT * FROM tupi_sync_state WHERE id = 1');
  const total = await pool.query('SELECT COUNT(*)::int AS n FROM tupi_sessions');
  const comUsuario = await pool.query('SELECT COUNT(*)::int AS n FROM tupi_session_users WHERE found = TRUE');
  return {
    configurado: tupiConfigurado(),
    ...(r.rows[0] || {}),
    total_sessoes: total.rows[0]?.n || 0,
    total_com_usuario: comUsuario.rows[0]?.n || 0
  };
}

// Lista sessões já sincronizadas (com dados do usuário), em formato normalizado "recarga".
export async function listRecargas({ dateFrom, dateTo, status, incluirZerados = false, limit = 500, offset = 0 } = {}) {
  const cond = [];
  const params = [];
  // Paridade com o CSV "Histórico de cargas": o relatório só contém sessões que
  // entregaram energia. Sessões falhas (timed_out/rejected/0 kWh) NÃO entram.
  if (!incluirZerados) cond.push(`s.kwh > 0`);
  if (dateFrom) { params.push(dateFrom); cond.push(`s.start_date_time >= $${params.length}`); }
  if (dateTo) { params.push(dateTo); cond.push(`s.start_date_time <= $${params.length}`); }
  if (status) { params.push(status); cond.push(`s.status = $${params.length}`); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  params.push(Math.min(Number(limit) || 500, 5000));
  params.push(Number(offset) || 0);

  const q = await pool.query(
    `SELECT s.*, u.name, u.document, u.email, u.street_name, u.number, u.district,
            u.city, u.state, u.zip_code, u.cars, u.found AS user_found
       FROM tupi_sessions s
       LEFT JOIN tupi_session_users u ON u.session_id = s.id
       ${where}
       ORDER BY s.start_date_time DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return q.rows.map(toRecarga);
}

// Mapeia a linha do banco para o formato "recarga" do EVP.
// Observação: a API Tupi NÃO fornece placa; a chave de vínculo com cliente/parceiro é o `document`.
export function toRecarga(row) {
  return {
    id: row.id,
    // uid = chave de deduplicação unificada CSV<->API.
    // Confirmado com dados reais: API `id` == coluna "ID da Transação" do CSV.
    uid: String(row.id),
    stationId: row.location_id,
    evseUid: row.evse_uid,
    connectorId: row.connector_id,
    autorizacao: row.authorization_reference,
    authMethod: row.auth_method,
    status: row.status,
    dataInicio: row.start_date_time,
    dataFim: row.end_date_time,
    kwh: row.kwh != null ? Number(row.kwh) : null,
    moeda: row.currency,
    custoApiSemImposto: row.total_cost_excl_vat != null ? Number(row.total_cost_excl_vat) : null,
    custoApiComImposto: row.total_cost_incl_vat != null ? Number(row.total_cost_incl_vat) : null,
    cliente: {
      nome: row.name || null,
      documento: row.document || null,
      email: row.email || null,
      endereco: row.name || row.city ? {
        logradouro: row.street_name || null,
        numero: row.number || null,
        bairro: row.district || null,
        cidade: row.city || null,
        uf: row.state || null,
        cep: row.zip_code || null
      } : null,
      veiculos: row.cars || null,
      encontrado: Boolean(row.user_found)
    },
    lastUpdated: row.last_updated
  };
}

export function iniciarSyncAgendado() {
  if (!tupiConfigurado()) {
    console.warn('Sync Tupi não iniciado: TUPI_TOKEN não configurado.');
    return;
  }
  const intervaloMs = Math.max(5, SYNC_INTERVAL_MIN) * 60 * 1000;
  // Primeira execução logo após o boot, depois no intervalo configurado.
  setTimeout(() => syncTupi({ motivo: 'startup' }).catch(err => console.error('Erro no sync Tupi inicial:', err.message)), 20000);
  setInterval(() => syncTupi({ motivo: 'agendado' }).catch(err => console.error('Erro no sync Tupi agendado:', err.message)), intervaloMs);
  console.log(`Sync Tupi agendado a cada ${Math.max(5, SYNC_INTERVAL_MIN)} min.`);
}
