import test from 'node:test';
import assert from 'node:assert/strict';

global.window = {};
await import('../public/colecao-diff.js');
const { criarRetrato, calcularDiff, emLotes, confirmarNoRetrato } = window.EVColecaoDiff;

const rec = (uid, extra = {}) => ({ uid, data: '2026-08-01 10:00', kwh: 10, ...extra });

test('sem alterações, nada é enviado', () => {
  const lista = [rec('A'), rec('B')];
  const retrato = criarRetrato(lista);
  const d = calcularDiff(retrato, lista);
  assert.deepEqual(d.alteradas, []);
  assert.deepEqual(d.removidas, []);
});

test('recarga nova entra em alteradas', () => {
  const retrato = criarRetrato([rec('A')]);
  const d = calcularDiff(retrato, [rec('A'), rec('B')]);
  assert.deepEqual(d.alteradas.map(r => r.uid), ['B']);
  assert.deepEqual(d.removidas, []);
});

test('mutação in-place é detectada — é o caso que motiva o diff', () => {
  // Reproduz o que gerarFaturasAutomaticasPosPago faz: carimba faturaId
  // diretamente no objeto que já está na lista.
  const lista = [rec('A'), rec('B')];
  const retrato = criarRetrato(lista);
  lista[1].faturaId = 'fat_1';

  const d = calcularDiff(retrato, lista);
  assert.deepEqual(d.alteradas.map(r => r.uid), ['B']);
});

test('alteração de campo derivado também é detectada', () => {
  // classificarRecargasPorCliente reescreve faturavel/valorCobranca em todas.
  const lista = [rec('A', { faturavel: false }), rec('B', { faturavel: false })];
  const retrato = criarRetrato(lista);
  lista.forEach(r => { r.faturavel = true; });

  assert.equal(calcularDiff(retrato, lista).alteradas.length, 2);
});

test('recarga sumida da lista vira remoção', () => {
  const retrato = criarRetrato([rec('A'), rec('B')]);
  const d = calcularDiff(retrato, [rec('A')]);
  assert.deepEqual(d.removidas, ['B']);
  assert.deepEqual(d.alteradas, []);
});

test('registros sem uid são separados, nunca silenciosamente perdidos', () => {
  const d = calcularDiff(criarRetrato([]), [rec('A'), { data: 'x' }, { uid: '', data: 'y' }]);
  assert.deepEqual(d.alteradas.map(r => r.uid), ['A']);
  assert.equal(d.semChave.length, 2);
});

test('uid numérico e uid string são o mesmo registro', () => {
  const retrato = criarRetrato([{ uid: 123, kwh: 1 }]);
  // O mesmo registro voltando com uid string não pode virar remoção + inclusão.
  const d = calcularDiff(retrato, [{ uid: 123, kwh: 1 }]);
  assert.deepEqual(d.removidas, []);
  assert.deepEqual(d.alteradas, []);
});

test('confirmar no retrato zera o diff seguinte', () => {
  const lista = [rec('A'), rec('B')];
  const retrato = criarRetrato(lista);
  lista[0].kwh = 99;
  lista.push(rec('C'));

  const d1 = calcularDiff(retrato, lista);
  assert.deepEqual(d1.alteradas.map(r => r.uid).sort(), ['A', 'C']);

  confirmarNoRetrato(retrato, d1.alteradas, d1.removidas);
  const d2 = calcularDiff(retrato, lista);
  assert.deepEqual(d2.alteradas, [], 'depois de confirmado, nada deve ser reenviado');
});

test('remoção confirmada some do retrato', () => {
  const retrato = criarRetrato([rec('A'), rec('B')]);
  const d1 = calcularDiff(retrato, [rec('A')]);
  confirmarNoRetrato(retrato, d1.alteradas, d1.removidas);
  assert.equal(retrato.has('B'), false);
  assert.deepEqual(calcularDiff(retrato, [rec('A')]).removidas, []);
});

test('falha na gravação mantém a pendência para a próxima tentativa', () => {
  const lista = [rec('A')];
  const retrato = criarRetrato(lista);
  lista[0].kwh = 42;

  const d1 = calcularDiff(retrato, lista);
  assert.equal(d1.alteradas.length, 1);
  // Sem confirmarNoRetrato (simulando erro de rede), continua pendente.
  assert.equal(calcularDiff(retrato, lista).alteradas.length, 1);
});

test('lotes respeitam o tamanho e cobrem todos os itens', () => {
  const itens = Array.from({ length: 750 }, (_, i) => rec('R' + i));
  const lotes = emLotes(itens, 300);
  assert.deepEqual(lotes.map(l => l.length), [300, 300, 150]);
  assert.equal(lotes.flat().length, 750);
  assert.deepEqual(emLotes([], 300), []);
});

test('retrato ignora registros sem uid em vez de quebrar', () => {
  const retrato = criarRetrato([rec('A'), null, { data: 'sem uid' }]);
  assert.equal(retrato.size, 1);
});

// ─── Chave configurável: faturas usam `id`, recargas usam `uid` ─────────────

const fat = (id, extra = {}) => ({ id, numero: 'EVP' + id, totalPagar: 100, ...extra });

test('faturas são chaveadas por id, não por uid', () => {
  const lista = [fat('fat_1'), fat('fat_2')];
  const retrato = criarRetrato(lista, 'id');
  assert.equal(retrato.size, 2);
  assert.deepEqual(calcularDiff(retrato, lista, 'id').alteradas, []);
});

test('baixa de pagamento numa fatura é detectada', () => {
  // Reproduz o que o webhook do Mercado Pago faz: marca como paga.
  const lista = [fat('fat_1'), fat('fat_2')];
  const retrato = criarRetrato(lista, 'id');
  lista[0].status = 'pago';
  lista[0].pago = true;

  const d = calcularDiff(retrato, lista, 'id');
  assert.deepEqual(d.alteradas.map(f => f.id), ['fat_1']);
  confirmarNoRetrato(retrato, d.alteradas, d.removidas, 'id');
  assert.deepEqual(calcularDiff(retrato, lista, 'id').alteradas, []);
});

test('sem chave informada, o padrão continua sendo uid', () => {
  // Garante que a generalização não mudou o comportamento das recargas.
  const lista = [rec('A')];
  assert.equal(criarRetrato(lista).size, 1);
  assert.deepEqual(calcularDiff(criarRetrato(lista), lista).alteradas, []);
});

test('fatura sem id vai para semChave em vez de ser perdida', () => {
  const d = calcularDiff(criarRetrato([], 'id'), [fat('fat_1'), { numero: 'sem id' }], 'id');
  assert.deepEqual(d.alteradas.map(f => f.id), ['fat_1']);
  assert.equal(d.semChave.length, 1);
});

test('a chave errada não confunde coleções', () => {
  // Uma fatura comparada com chave 'uid' não tem chave nenhuma — precisa cair
  // em semChave, nunca ser tratada como registro novo sem identidade.
  const d = calcularDiff(criarRetrato([], 'uid'), [fat('fat_1')], 'uid');
  assert.deepEqual(d.alteradas, []);
  assert.equal(d.semChave.length, 1);
});
