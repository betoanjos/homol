import test from 'node:test';
import assert from 'node:assert/strict';
import { toRecarga } from '../server/tupiFormato.js';
import { fetchAllSessions, fetchSessionUserData } from '../server/tupi.js';

// ─── Normalização (tupiFormato.js) ──────────────────────────────────────────

const linhaCompleta = {
  id: 'SESS-1', location_id: 'LOC-9', evse_uid: 'EVSE-3', connector_id: '1',
  authorization_reference: 'AUTH-7', auth_method: 'AUTH_REQUEST', status: 'COMPLETED',
  start_date_time: '2026-08-01T10:00:00.000Z', end_date_time: '2026-08-01T10:45:00.000Z',
  kwh: '24.500', currency: 'BRL', total_cost_excl_vat: '48.75', total_cost_incl_vat: '52.10',
  name: 'Fulano de Tal', document: '04646356910', email: 'fulano@example.com',
  street_name: 'Rua A', number: '10', district: 'Centro', city: 'Joinville', state: 'SC',
  zip_code: '89200-000', cars: [{ plate: 'ABC1D23' }], user_found: true,
  last_updated: '2026-08-01T10:46:00.000Z'
};

test('converte os campos numéricos que vêm como string do Postgres', () => {
  const r = toRecarga(linhaCompleta);
  // NUMERIC do pg chega como string; se vazar assim, todo cálculo de
  // faturamento vira concatenação de texto.
  assert.equal(r.kwh, 24.5);
  assert.equal(r.custoApiSemImposto, 48.75);
  assert.equal(r.custoApiComImposto, 52.1);
  assert.equal(typeof r.kwh, 'number');
  assert.equal(typeof r.custoApiSemImposto, 'number');
});

test('uid é sempre string e espelha o id da sessão', () => {
  assert.equal(toRecarga({ id: 'SESS-1' }).uid, 'SESS-1');
  assert.equal(toRecarga({ id: 12345 }).uid, '12345');
  assert.equal(typeof toRecarga({ id: 12345 }).uid, 'string');
});

test('zero e valores ausentes não se confundem', () => {
  // Uma sessão de 0 kWh é diferente de uma sessão sem leitura: 0 precisa
  // sobreviver como 0, e ausente precisa virar null — nunca o contrário.
  const zerada = toRecarga({ id: 'S', kwh: 0, total_cost_excl_vat: 0, total_cost_incl_vat: 0 });
  assert.equal(zerada.kwh, 0);
  assert.equal(zerada.custoApiSemImposto, 0);

  const vazia = toRecarga({ id: 'S' });
  assert.equal(vazia.kwh, null);
  assert.equal(vazia.custoApiSemImposto, null);
  assert.equal(vazia.custoApiComImposto, null);
});

test('o documento é preservado — é a chave de vínculo com o cliente', () => {
  // A API Tupi não devolve placa; sem o document não há como ligar a recarga
  // ao cliente/parceiro no faturamento.
  assert.equal(toRecarga(linhaCompleta).cliente.documento, '04646356910');
  assert.equal(toRecarga({ id: 'S' }).cliente.documento, null);
});

test('sessão sem usuário associado vem marcada como não encontrada', () => {
  const r = toRecarga({ id: 'S', user_found: false });
  assert.equal(r.cliente.encontrado, false);
  assert.equal(r.cliente.nome, null);
  assert.equal(r.cliente.endereco, null);
  // user_found nulo (sem linha no LEFT JOIN) também é "não encontrado".
  assert.equal(toRecarga({ id: 'S' }).cliente.encontrado, false);
});

test('endereço só aparece quando há nome ou cidade', () => {
  assert.equal(toRecarga({ id: 'S', street_name: 'Rua A' }).cliente.endereco, null);
  assert.deepEqual(toRecarga({ id: 'S', city: 'Joinville' }).cliente.endereco, {
    logradouro: null, numero: null, bairro: null, cidade: 'Joinville', uf: null, cep: null
  });
});

// ─── Paginação defensiva (tupi.js) ──────────────────────────────────────────
// A API real pode ignorar o `limit` e repetir registros entre páginas. A lógica
// de fetchAllSessions existe por causa disso — estes testes a prendem no lugar.

function stubFetch(paginas, { totalHeader = null } = {}) {
  let chamada = 0;
  const chamadas = [];
  globalThis.fetch = async (url) => {
    chamadas.push(String(url));
    const data = paginas[chamada++] ?? [];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data, status_code: 1000 }),
      headers: { get: nome => (nome === 'X-Total-Count' ? totalHeader : null) }
    };
  };
  return chamadas;
}

const sessao = id => ({ id, kwh: 1, last_updated: '2026-08-01T00:00:00Z' });
const fetchOriginal = globalThis.fetch;

test('deduplica sessões repetidas entre páginas', async (t) => {
  process.env.TUPI_TOKEN = 'token-de-teste';
  t.after(() => { globalThis.fetch = fetchOriginal; });

  stubFetch([
    [sessao('A'), sessao('B')],
    [sessao('B'), sessao('C')], // B repetido — a API real faz isso
    []
  ]);

  const todas = await fetchAllSessions({ limit: 2 });
  assert.deepEqual(todas.map(s => s.id), ['A', 'B', 'C']);
});

test('para quando uma página não traz nada novo, sem laço infinito', async (t) => {
  process.env.TUPI_TOKEN = 'token-de-teste';
  t.after(() => { globalThis.fetch = fetchOriginal; });

  // A API ignora offset e devolve a mesma página para sempre. Sem a guarda de
  // "nenhum novo -> para", isto rodaria até maxPages (5000 requisições).
  const chamadas = stubFetch(Array.from({ length: 50 }, () => [sessao('A'), sessao('B')]));

  const todas = await fetchAllSessions({ limit: 2 });
  assert.deepEqual(todas.map(s => s.id), ['A', 'B']);
  assert.equal(chamadas.length, 2, 'deve parar na segunda página, ao ver que nada é novo');
});

test('para ao alcançar o total informado no cabeçalho', async (t) => {
  process.env.TUPI_TOKEN = 'token-de-teste';
  t.after(() => { globalThis.fetch = fetchOriginal; });

  const chamadas = stubFetch([[sessao('A'), sessao('B')], [sessao('C')]], { totalHeader: '2' });
  const todas = await fetchAllSessions({ limit: 2 });
  assert.deepEqual(todas.map(s => s.id), ['A', 'B']);
  assert.equal(chamadas.length, 1);
});

test('sem o cabeçalho X-Total-Count, continua paginando em vez de truncar', async (t) => {
  process.env.TUPI_TOKEN = 'token-de-teste';
  t.after(() => { globalThis.fetch = fetchOriginal; });

  // Regressão: Number(null) é 0, um número finito. O total virava 0 e a
  // condição `offset >= total` interrompia tudo na primeira página — o sync
  // truncava silenciosamente e ninguém percebia, porque não havia erro.
  stubFetch([[sessao('A'), sessao('B')], [sessao('C'), sessao('D')], []], { totalHeader: null });

  const todas = await fetchAllSessions({ limit: 2 });
  assert.deepEqual(todas.map(s => s.id), ['A', 'B', 'C', 'D']);
});

test('cabeçalho X-Total-Count vazio ou inválido também não trunca', async (t) => {
  process.env.TUPI_TOKEN = 'token-de-teste';
  t.after(() => { globalThis.fetch = fetchOriginal; });

  for (const header of ['', '   ', 'desconhecido']) {
    stubFetch([[sessao('A')], [sessao('B')], []], { totalHeader: header });
    const todas = await fetchAllSessions({ limit: 1 });
    assert.deepEqual(todas.map(s => s.id), ['A', 'B'], `header ${JSON.stringify(header)}`);
  }
});

test('o intervalo pedido vai na query da requisição', async (t) => {
  process.env.TUPI_TOKEN = 'token-de-teste';
  t.after(() => { globalThis.fetch = fetchOriginal; });

  const chamadas = stubFetch([[]]);
  await fetchAllSessions({ dateFrom: '2026-08-01T00:00:00Z', dateTo: '2026-08-02T00:00:00Z' });
  assert.match(chamadas[0], /date_from=2026-08-01T00%3A00%3A00Z/);
  assert.match(chamadas[0], /date_to=2026-08-02T00%3A00%3A00Z/);
});

test('sessão sem usuário (404) devolve null em vez de quebrar o sync', async (t) => {
  process.env.TUPI_TOKEN = 'token-de-teste';
  t.after(() => { globalThis.fetch = fetchOriginal; });

  globalThis.fetch = async () => ({
    ok: false, status: 404,
    text: async () => JSON.stringify({ status_message: 'not found' }),
    headers: { get: () => null }
  });

  const ud = await fetchSessionUserData('SESS-1', { countryCode: 'BR', partyId: 'XYZ' });
  assert.equal(ud, null);
});

test('erro diferente de 404 no user-data é propagado', async (t) => {
  process.env.TUPI_TOKEN = 'token-de-teste';
  t.after(() => { globalThis.fetch = fetchOriginal; });

  globalThis.fetch = async () => ({
    ok: false, status: 500,
    text: async () => JSON.stringify({ status_message: 'boom' }),
    headers: { get: () => null }
  });

  await assert.rejects(
    () => fetchSessionUserData('SESS-1', { countryCode: 'BR', partyId: 'XYZ' }),
    /Erro Tupi 500/
  );
});

test('user-data exige o party id — sem ele a chamada nem sai', async (t) => {
  process.env.TUPI_TOKEN = 'token-de-teste';
  const partyOriginal = process.env.TUPI_PARTY_ID;
  delete process.env.TUPI_PARTY_ID;
  t.after(() => {
    globalThis.fetch = fetchOriginal;
    if (partyOriginal !== undefined) process.env.TUPI_PARTY_ID = partyOriginal;
  });

  globalThis.fetch = async () => { throw new Error('não deveria chamar a rede'); };
  await assert.rejects(() => fetchSessionUserData('SESS-1'), /TUPI_PARTY_ID/);
});
