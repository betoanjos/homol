import test from 'node:test';
import assert from 'node:assert/strict';

global.window = {};
await import('../public/parceiro-regras.js');
const { valorCobrado, foiCobrada, separarPorCobranca, baseDoRelatorio } = window.EVParceiroRegras;

// Esta regra decide o que entra no repasse ao parceiro. Incluir uma recarga
// gratuita faz a rede pagar kWh que o parceiro ofereceu de graça; excluir uma
// recarga cobrada tira dinheiro do parceiro. Os dois erros custam.

const rec = (extra = {}) => ({ uid: 'R1', kwh: 10, ...extra });

test('recarga com valor entra no repasse', () => {
  assert.equal(foiCobrada(rec({ cobranca: 25.5 })), true);
  assert.equal(foiCobrada(rec({ total: 25.5 })), true);
});

test('recarga zerada fica de fora', () => {
  assert.equal(foiCobrada(rec({ cobranca: 0 })), false);
  assert.equal(foiCobrada(rec({ total: 0 })), false);
  assert.equal(foiCobrada(rec()), false, 'sem campo de valor = sem cobrança');
});

test('cobranca zero vence total preenchido', () => {
  // `??` só cai para o próximo em null/undefined. Uma recarga marcada com
  // cobranca = 0 é cortesia, mesmo que `total` ainda carregue o valor de
  // tabela — cobranca é a palavra final sobre o que foi efetivamente cobrado.
  assert.equal(valorCobrado(rec({ cobranca: 0, total: 50 })), 0);
  assert.equal(foiCobrada(rec({ cobranca: 0, total: 50 })), false);
});

test('cobranca ausente cai para total', () => {
  assert.equal(valorCobrado(rec({ cobranca: null, total: 50 })), 50);
  assert.equal(valorCobrado(rec({ total: 50 })), 50);
});

test('valor negativo não conta como cobrado', () => {
  // Estorno lançado como valor negativo não pode virar base de repasse.
  assert.equal(foiCobrada(rec({ cobranca: -10 })), false);
});

test('valor inválido não quebra nem vira cobrança', () => {
  assert.equal(valorCobrado(rec({ cobranca: 'abc' })), 0);
  assert.equal(foiCobrada(rec({ cobranca: 'abc' })), false);
  assert.equal(valorCobrado(null), 0);
  assert.equal(foiCobrada(undefined), false);
});

test('valor em string numérica é aceito', () => {
  // Valores vindos de importação podem chegar como texto.
  assert.equal(valorCobrado(rec({ cobranca: '25.50' })), 25.5);
  assert.equal(foiCobrada(rec({ cobranca: '25.50' })), true);
});

test('separa a lista e soma o kWh descartado', () => {
  const lista = [
    rec({ uid: 'A', cobranca: 20, kwh: 15 }),
    rec({ uid: 'B', cobranca: 0, kwh: 30 }),
    rec({ uid: 'C', cobranca: 10, kwh: 5 }),
    rec({ uid: 'D', kwh: 12 })
  ];
  const { cobradas, semCobranca } = separarPorCobranca(lista);

  assert.deepEqual(cobradas.map(r => r.uid), ['A', 'C']);
  assert.equal(semCobranca.quantidade, 2);
  assert.equal(semCobranca.kwh, 42, 'kWh gratuito não pode entrar no custo de energia');
  assert.deepEqual(semCobranca.lista.map(r => r.uid), ['B', 'D']);
});

test('lista vazia ou nula não quebra', () => {
  assert.deepEqual(separarPorCobranca([]).cobradas, []);
  assert.equal(separarPorCobranca(null).semCobranca.quantidade, 0);
  assert.equal(separarPorCobranca([null, undefined]).semCobranca.quantidade, 0);
});

test('lista só de cortesias não sobra nada para cobrar', () => {
  const { cobradas, semCobranca } = separarPorCobranca([rec({ cobranca: 0, kwh: 8 }), rec({ cobranca: 0, kwh: 2 })]);
  assert.deepEqual(cobradas, []);
  assert.equal(semCobranca.kwh, 10);
});

// ─── Base de cálculo x listagem ─────────────────────────────────────────────

const lista3 = () => [
  rec({ uid: 'PAGA1', cobranca: 20, kwh: 15 }),
  rec({ uid: 'GRATIS', cobranca: 0, kwh: 30 }),
  rec({ uid: 'PAGA2', cobranca: 10, kwh: 5 })
];

test('parceiro comum: gratuita fica fora de todo cálculo', () => {
  const { base, exibicao, semCobranca } = baseDoRelatorio(lista3(), { energiaPelaRede: false });
  assert.deepEqual(base.map(r => r.uid), ['PAGA1', 'PAGA2'], 'o kWh gratuito não pode custar energia à rede');
  assert.deepEqual(exibicao.map(r => r.uid), ['PAGA1', 'PAGA2']);
  assert.equal(semCobranca.kwh, 30);
});

test('energia paga pela rede: gratuita entra no custo, mas não na listagem', () => {
  // Max Center: a rede paga a concessionária e as recargas zeradas são da
  // nossa equipe. O kWh foi consumido de fato, então conta no custo.
  const { base, exibicao } = baseDoRelatorio(lista3(), { energiaPelaRede: true });
  assert.deepEqual(base.map(r => r.uid), ['PAGA1', 'GRATIS', 'PAGA2']);
  assert.deepEqual(exibicao.map(r => r.uid), ['PAGA1', 'PAGA2'], 'nada foi cobrado do parceiro por elas');
});

test('sem opções, o padrão é o parceiro comum', () => {
  assert.deepEqual(baseDoRelatorio(lista3()).base.map(r => r.uid), ['PAGA1', 'PAGA2']);
  assert.deepEqual(baseDoRelatorio(lista3(), {}).base.map(r => r.uid), ['PAGA1', 'PAGA2']);
});

test('recarga editada com valor volta para os dois lados', () => {
  // O fluxo que o usuário descreveu: a cortesia fica no painel até alguém
  // lançar o valor; a partir daí entra no cálculo e sobe para o PDF.
  const lista = lista3();
  lista[1].cobranca = 45;
  const { base, exibicao, semCobranca } = baseDoRelatorio(lista, { energiaPelaRede: false });
  assert.deepEqual(base.map(r => r.uid), ['PAGA1', 'GRATIS', 'PAGA2']);
  assert.deepEqual(exibicao.map(r => r.uid), ['PAGA1', 'GRATIS', 'PAGA2']);
  assert.equal(semCobranca.quantidade, 0);
});
