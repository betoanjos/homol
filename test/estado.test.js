import test from 'node:test';
import assert from 'node:assert/strict';
import { avaliarPerdas } from '../server/estadoValidacao.js';

const lista = n => Array.from({ length: n }, (_, i) => ({ id: `i${i}` }));

test('estado igual ou maior não acusa perda', () => {
  const atual = { clientes: lista(10), recargas: lista(500) };
  assert.deepEqual(avaliarPerdas(atual, { clientes: lista(10), recargas: lista(500) }), []);
  assert.deepEqual(avaliarPerdas(atual, { clientes: lista(11), recargas: lista(620) }), []);
});

test('exclusão avulsa passa mesmo em lista pequena', () => {
  // 1 de 2 é 50% — acima da fração, mas a tolerância mínima de 1 item cobre.
  assert.deepEqual(avaliarPerdas({ clientes: lista(2) }, { clientes: lista(1) }), []);
  assert.deepEqual(avaliarPerdas({ recargas: lista(100) }, { recargas: lista(80) }), []);
});

test('encolhimento acima do limite é recusado', () => {
  const perdas = avaliarPerdas({ clientes: lista(100) }, { clientes: lista(20) });
  assert.equal(perdas.length, 1);
  assert.equal(perdas[0].colecao, 'clientes');
  assert.equal(perdas[0].antes, 100);
  assert.equal(perdas[0].depois, 20);
  assert.equal(perdas[0].removidos, 80);
});

test('estado vazio sobre banco populado é recusado em todas as coleções', () => {
  const atual = { clientes: lista(10), faturas: lista(10), recargas: lista(10), parceiros: lista(10) };
  const perdas = avaliarPerdas(atual, {});
  assert.equal(perdas.length, 4);
  assert.ok(perdas.every(p => p.ausente && p.depois === 0));
});

test('coleção omitida conta como perda total, não como ausência de mudança', () => {
  const perdas = avaliarPerdas({ clientes: lista(50), faturas: lista(50) }, { clientes: lista(50) });
  assert.equal(perdas.length, 1);
  assert.equal(perdas[0].colecao, 'faturas');
  assert.equal(perdas[0].ausente, true);
});

test('coleção vazia no banco nunca gera perda', () => {
  assert.deepEqual(avaliarPerdas({ clientes: [] }, {}), []);
  assert.deepEqual(avaliarPerdas({}, {}), []);
});

test('campos fora das coleções de negócio são ignorados pela guarda', () => {
  const atual = { configuracoesRede: { nomeRede: 'EV Parking' }, configFin: { categorias: lista(5) } };
  assert.deepEqual(avaliarPerdas(atual, { configuracoesRede: {} }), []);
});
