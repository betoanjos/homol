// Cliente da API Tupi (OCPI 2.2.1) — EV Parking
// Documentação: sessions (OCPI padrão) + session user-data (Tupi Extra v1).
// Autenticação: header "Authorization: Token <token>".

const DEFAULT_BASE = 'https://ocpi.tupinrg.app';

function config() {
  const base = (process.env.TUPI_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const token = process.env.TUPI_TOKEN || '';
  const version = process.env.TUPI_OCPI_VERSION || '2.2.1';
  const countryCode = process.env.TUPI_COUNTRY_CODE || 'BR';
  const partyId = process.env.TUPI_PARTY_ID || '';
  return { base, token, version, countryCode, partyId };
}

export function tupiConfigurado() {
  const { token } = config();
  return Boolean(token);
}

async function tupiFetch(url, { method = 'GET' } = {}) {
  const { token } = config();
  if (!token) throw new Error('TUPI_TOKEN não configurado nas variáveis de ambiente.');

  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Token ${token}`
    }
  });

  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (!res.ok) {
    const detalhe = body?.status_message || body?.message || body?.error || `HTTP ${res.status}`;
    const erro = new Error(`Erro Tupi ${res.status}: ${detalhe}`);
    erro.status = res.status;
    erro.body = body;
    throw erro;
  }
  return { body, headers: res.headers };
}

// Lê UMA página do endpoint de sessions.
async function fetchSessionsPage({ limit = 100, offset = 0, dateFrom, dateTo } = {}) {
  const { base, version } = config();
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);

  const url = `${base}/${version}/sessions?${params.toString()}`;
  const { body, headers } = await tupiFetch(url);
  const data = Array.isArray(body?.data) ? body.data : [];
  // Cuidado: header ausente faz headers.get() devolver null, e Number(null) é 0
  // — um zero finito, que fazia a paginação parar na primeira página e truncar
  // o sync inteiro em silêncio. Só aceitamos um número quando veio de fato.
  const bruto = headers.get('X-Total-Count');
  const totalCount = bruto == null || String(bruto).trim() === '' ? NaN : Number(bruto);
  return {
    data,
    total: Number.isFinite(totalCount) ? totalCount : null,
    statusCode: body?.status_code
  };
}

// Busca TODAS as sessions no intervalo, com paginação robusta.
// Observado na API real: o servidor pode ignorar o `limit` e repetir registros.
// Por isso: deduplicamos por id, avançamos o offset pelo que REALMENTE veio,
// e paramos quando uma página não traz nenhuma sessão nova.
export async function fetchAllSessions({ dateFrom, dateTo, limit = 1000, maxPages = 5000 } = {}) {
  const todas = [];
  const vistos = new Set();
  let offset = 0;
  let total = null;

  for (let page = 0; page < maxPages; page++) {
    const { data, total: t } = await fetchSessionsPage({ limit, offset, dateFrom, dateTo });
    if (t !== null) total = t;
    if (!data.length) break;

    let novos = 0;
    for (const s of data) {
      const id = s?.id != null ? String(s.id) : null;
      if (id && vistos.has(id)) continue;
      if (id) vistos.add(id);
      todas.push(s);
      novos++;
    }
    if (novos === 0) break;               // página sem nada novo -> fim
    offset += data.length;                // avança pelo que veio (robusto se limit é ignorado)
    if (total !== null && offset >= total) break;
  }
  return todas;
}

// Busca os dados do usuário de UMA sessão (Tupi Extra v1).
// Retorna null quando não há dados (404) — sessão sem usuário associado.
export async function fetchSessionUserData(sessionId, { countryCode, partyId } = {}) {
  const cfg = config();
  const cc = countryCode || cfg.countryCode;
  const pid = partyId || cfg.partyId;
  if (!pid) throw new Error('TUPI_PARTY_ID não configurado (obrigatório para user-data).');
  if (!sessionId) throw new Error('sessionId é obrigatório.');

  const url = `${cfg.base}/extra/v1/sessions/${encodeURIComponent(cc)}/${encodeURIComponent(pid)}/${encodeURIComponent(sessionId)}/user-data`;
  try {
    const { body } = await tupiFetch(url);
    return body?.data?.user_data || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

export { config as tupiConfig };
