import test from 'node:test';
import assert from 'node:assert/strict';

global.window = {};
await import('../public/estacao-vigencia.js');
const { soData, dentroDaVigencia, escolherPorData, indexarPorIdTupi } = window.EVEstacaoVigencia;

// Cenário real que motivou isto: a estação 1125790813 operou no local da Lefel
// até 07/09/2026 e passou a operar no Serra Alta a partir de 08/09/2026. As
// recargas de agosto precisam continuar sendo da Lefel, mesmo com o equipamento
// já em outro parceiro — senão o fechamento de um mês já pago muda sozinho.

const lefel = { nome: 'Lefel 46kW AC', idTupi: '1125790813', parceiroId: 'par_lefel', vigenciaFim: '2026-09-07' };
const serraAlta = { nome: 'Serra Alta 46kW AC', idTupi: '1125790813', parceiroId: 'par_serra', vigenciaInicio: '2026-09-08' };
const semJanela = { nome: 'M7 Mafra 40kW DC', idTupi: '1124093062', parceiroId: 'par_m7' };

test('reconhece os formatos de data usados nas recargas', () => {
  assert.equal(soData('2026-08-15'), '2026-08-15');
  assert.equal(soData('2026-08-15T10:30:00.000Z'), '2026-08-15');
  assert.equal(soData('2026-08-15 10:30'), '2026-08-15');
  assert.equal(soData('15/08/2026'), '2026-08-15', 'formato brasileiro das recargas importadas');
  assert.equal(soData('15/08/2026 10:30'), '2026-08-15');
  assert.equal(soData(''), '');
  assert.equal(soData(null), '');
});

test('recarga de agosto fica com a Lefel', () => {
  const escolhida = escolherPorData([lefel, serraAlta], '2026-08-20');
  assert.equal(escolhida.parceiroId, 'par_lefel');
});

test('recarga a partir da troca vai para o Serra Alta', () => {
  assert.equal(escolherPorData([lefel, serraAlta], '2026-09-08').parceiroId, 'par_serra');
  assert.equal(escolherPorData([lefel, serraAlta], '2026-10-01').parceiroId, 'par_serra');
});

test('os extremos da janela são inclusivos', () => {
  // 07/09 é o último dia da Lefel; 08/09 é o primeiro do Serra Alta.
  assert.equal(escolherPorData([lefel, serraAlta], '2026-09-07').parceiroId, 'par_lefel');
  assert.equal(escolherPorData([lefel, serraAlta], '2026-09-08').parceiroId, 'par_serra');
});

test('não há dia órfão nem dia disputado na virada', () => {
  for (const dia of ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09']) {
    const casam = [lefel, serraAlta].filter(e => dentroDaVigencia(e, dia));
    assert.equal(casam.length, 1, `${dia} deveria casar com exatamente um cadastro`);
  }
});

test('estação sem janela continua valendo sempre', () => {
  assert.equal(dentroDaVigencia(semJanela, '2020-01-01'), true);
  assert.equal(dentroDaVigencia(semJanela, '2030-01-01'), true);
  assert.equal(escolherPorData([semJanela], '2026-08-20'), semJanela);
});

test('recarga com data ilegível cai no cadastro sem janela', () => {
  // Perder a recarga seria pior do que atribuí-la ao cadastro corrente.
  const escolhida = escolherPorData([lefel, semJanela], '');
  assert.equal(escolhida, semJanela);
});

test('sem data e todas com janela, fica com a mais recente', () => {
  const escolhida = escolherPorData([lefel, serraAlta], '');
  assert.equal(escolhida.parceiroId, 'par_serra', 'o dono atual do equipamento');
});

test('data anterior a todas as janelas não perde a recarga', () => {
  // Recarga de antes de qualquer vigência cadastrada: melhor cair no mais
  // recente do que sumir do relatório sem ninguém perceber.
  const escolhida = escolherPorData([lefel, serraAlta], '2020-01-01');
  assert.ok(escolhida, 'nunca deve devolver nulo quando há cadastros');
});

test('lista vazia devolve nulo', () => {
  assert.equal(escolherPorData([], '2026-08-20'), null);
  assert.equal(escolherPorData(null, '2026-08-20'), null);
});

test('índice agrupa os cadastros que dividem o mesmo ID Tupi', () => {
  const idx = indexarPorIdTupi([lefel, serraAlta, semJanela, { nome: 'sem id' }]);
  assert.equal(idx.get('1125790813').length, 2);
  assert.equal(idx.get('1124093062').length, 1);
  assert.equal(idx.size, 2, 'cadastro sem ID Tupi não entra no índice');
});

test('ID com formatação é normalizado para dígitos', () => {
  const idx = indexarPorIdTupi([{ nome: 'X', idTupi: ' 1125790813 ' }]);
  assert.equal(idx.get('1125790813').length, 1);
});
