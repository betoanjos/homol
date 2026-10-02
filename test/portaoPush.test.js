import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarDeviceId, estacaoDoAparelho, montarComandoAbertura, lerResultado } from '../server/portaoPush.js';

// O iDFace consulta o servidor e executa o que vier na resposta. Um comando
// malformado vira porta que não abre às 3 da manhã; um deviceId aceito sem
// critério vira texto arbitrário em log e comparação.

test('deviceId só aceita dígitos', () => {
  assert.equal(normalizarDeviceId('123456789'), '123456789');
  assert.equal(normalizarDeviceId(' 42 '), '42');
  assert.equal(normalizarDeviceId(987654321), '987654321');
});

test('deviceId inválido vira vazio', () => {
  for (const ruim of ['', null, undefined, 'abc', '12a', '1.5', '-3', '1 2', '<script>', '9'.repeat(21)]) {
    assert.equal(normalizarDeviceId(ruim), '', JSON.stringify(ruim));
  }
});

test('o aparelho resolve para a estação que o cadastrou', () => {
  const cwb = { id: 'est_cwb', nome: 'Curitiba', idfaceId: '5551234' };
  const mafra = { id: 'est_mafra', nome: 'Mafra', idfaceId: '7778899' };
  assert.equal(estacaoDoAparelho([cwb, mafra], '7778899').id, 'est_mafra');
  assert.equal(estacaoDoAparelho([cwb, mafra], '5551234').id, 'est_cwb');
});

test('aparelho desconhecido não resolve estação', () => {
  const cwb = { id: 'est_cwb', idfaceId: '5551234' };
  assert.equal(estacaoDoAparelho([cwb], '999'), null);
  assert.equal(estacaoDoAparelho([cwb], ''), null);
  assert.equal(estacaoDoAparelho([cwb], 'abc'), null);
});

test('estação sem idfaceId nunca é escolhida', () => {
  // Sem esta guarda, deviceId vazio casaria com toda estação sem o campo.
  assert.equal(estacaoDoAparelho([{ id: 'a' }, { id: 'b', idfaceId: '' }], ''), null);
  assert.equal(estacaoDoAparelho([{ id: 'a' }], '123'), null);
});

test('formatos diferentes do mesmo número são o mesmo aparelho', () => {
  assert.equal(estacaoDoAparelho([{ id: 'a', idfaceId: ' 5551234 ' }], 5551234).id, 'a');
});

test('lista nula ou com itens vazios não quebra', () => {
  assert.equal(estacaoDoAparelho(null, '1'), null);
  assert.equal(estacaoDoAparelho([null, undefined, { id: 'a', idfaceId: '1' }], '1').id, 'a');
});

test('o comando de abertura usa sec_box, que é o do iDFace', () => {
  const c = montarComandoAbertura();
  assert.equal(c.verb, 'POST');
  assert.equal(c.endpoint, 'execute_actions');
  assert.equal(c.contentType, 'application/json');
  assert.equal(c.body.actions.length, 1);
  assert.equal(c.body.actions[0].action, 'sec_box', 'door é das famílias com relé no terminal');
  assert.equal(c.body.actions[0].parameters, 'id=65793, reason=3');
});

test('id do módulo e motivo são configuráveis', () => {
  const c = montarComandoAbertura({ secboxId: '65794', reason: '5' });
  assert.equal(c.body.actions[0].parameters, 'id=65794, reason=5');
});

test('o corpo pode ir como texto, se o aparelho recusar objeto', () => {
  // A documentação descreve body como string mas exemplifica com objeto.
  const c = montarComandoAbertura({ bodyComoTexto: true });
  assert.equal(typeof c.body, 'string');
  assert.deepEqual(JSON.parse(c.body).actions[0], { action: 'sec_box', parameters: 'id=65793, reason=3' });
});

test('o comando serializa em JSON válido', () => {
  const volta = JSON.parse(JSON.stringify(montarComandoAbertura()));
  assert.equal(volta.endpoint, 'execute_actions');
  assert.equal(volta.body.actions[0].action, 'sec_box');
});

test('resultado sem erro é ok', () => {
  const r = lerResultado({ endpoint: 'execute_actions', response: { success: true } });
  assert.equal(r.ok, true);
  assert.equal(r.endpoint, 'execute_actions');
  assert.match(r.texto, /^ok: .*success/);
});

test('resultado com erro é registrado como falha', () => {
  const r = lerResultado({ endpoint: 'execute_actions', error: 'invalid action' });
  assert.equal(r.ok, false);
  assert.equal(r.texto, 'erro: invalid action');
});

test('erro vazio não conta como falha', () => {
  assert.equal(lerResultado({ error: '', response: 'x' }).ok, true);
  assert.equal(lerResultado({ error: '   ' }).ok, true);
});

test('corpo ilegível nunca lança', () => {
  for (const ruim of [null, undefined, 'texto solto', 42, [], {}]) {
    assert.doesNotThrow(() => lerResultado(ruim));
  }
  assert.equal(lerResultado(null).ok, true);
  assert.equal(lerResultado({}).texto, 'ok');
});
