import test from 'node:test';
import assert from 'node:assert/strict';

global.window = {};
await import('../public/periodo-comparativo.js');
const { ultimoDiaDoMes, diaClampeado, trechoMesAnterior, trechoAnoAnterior, rotuloParcial } = window.EVPeriodoComparativo;

// O dashboard comparava o mês corrente (só os dias decorridos) contra o mês
// anterior inteiro. No dia 9 isso confronta 9 dias com 31, e a "queda de 88%"
// que aparecia era só o calendário.

const em = (ano, mes, dia) => new Date(ano, mes - 1, dia);

test('mês anterior é recortado até o mesmo dia', () => {
  // 09/09/2026 → agosto de 1 a 9.
  const t = trechoMesAnterior(em(2026, 9, 9));
  assert.deepEqual(t, { ano: 2026, mes: 7, diaInicio: 1, diaFim: 9 });
});

test('vira o ano corretamente em janeiro', () => {
  const t = trechoMesAnterior(em(2026, 1, 15));
  assert.equal(t.ano, 2025);
  assert.equal(t.mes, 11, 'dezembro');
  assert.equal(t.diaFim, 15);
});

test('dia 31 encolhe para o último dia do mês anterior', () => {
  // 31/03 → fevereiro não tem 31; o trecho para em 28 (ou 29 em bissexto).
  assert.equal(trechoMesAnterior(em(2026, 3, 31)).diaFim, 28);
  assert.equal(trechoMesAnterior(em(2024, 3, 31)).diaFim, 29, '2024 é bissexto');
  // 31/05 → abril tem 30.
  assert.equal(trechoMesAnterior(em(2026, 5, 31)).diaFim, 30);
});


test('o rótulo avisa que o recorte é parcial', () => {
  assert.equal(rotuloParcial(2026, 7, 9), ' · 1 a 9');
  assert.equal(rotuloParcial(2026, 7, 31), '', 'agosto tem 31 dias');
});

test('ano anterior vai de janeiro até o mesmo mês e dia', () => {
  const t = trechoAnoAnterior(em(2026, 9, 9));
  assert.deepEqual(t, { ano: 2025, mesInicio: 0, diaInicio: 1, mesFim: 8, diaFim: 9 });
});

test('29 de fevereiro cai para 28 no ano anterior não bissexto', () => {
  const t = trechoAnoAnterior(em(2024, 2, 29));
  assert.equal(t.ano, 2023);
  assert.equal(t.diaFim, 28);
});

test('utilitários de calendário', () => {
  assert.equal(ultimoDiaDoMes(2026, 1), 28, 'fevereiro/2026');
  assert.equal(ultimoDiaDoMes(2024, 1), 29, 'fevereiro/2024');
  assert.equal(ultimoDiaDoMes(2026, 8), 30, 'setembro');
  assert.equal(diaClampeado(2026, 1, 31), 28);
  assert.equal(diaClampeado(2026, 8, 5), 5);
});

test('fechamento de mês curto ainda pega o mês anterior inteiro', () => {
  // 30/09 (setembro completo) → agosto inteiro, incluindo o dia 31.
  const t = trechoMesAnterior(em(2026, 9, 30));
  assert.equal(t.diaFim, 31);
  assert.equal(rotuloParcial(t.ano, t.mes, t.diaFim), '');
  // 28/02 em ano não bissexto também fecha o mês → janeiro inteiro.
  assert.equal(trechoMesAnterior(em(2026, 2, 28)).diaFim, 31);
});

test('dia 30 de um mês de 31 dias segue sendo recorte parcial', () => {
  // 30/08 não é o último dia de agosto: compara com julho até o dia 30.
  const t = trechoMesAnterior(em(2026, 8, 30));
  assert.equal(t.diaFim, 30);
  assert.equal(rotuloParcial(t.ano, t.mes, t.diaFim), ' · 1 a 30');
});
