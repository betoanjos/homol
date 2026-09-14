import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarTelefone, mascararTelefone, mensagemPedeAbertura, lerMensagemRecebida } from '../server/portaoMensagem.js';

// Esta regra decide se a grade da estação abre. Um falso positivo abre a
// proteção do equipamento por engano; um falso negativo deixa o motorista
// parado no portão às 3 da manhã, que é justamente quando não há ninguém
// no posto para ajudar.

test('a palavra-chave abre, em qualquer caixa ou pontuação', () => {
  for (const texto of ['ABRIR', 'abrir', 'Abrir', 'abrir!', 'Abrir.', ' abrir ']) {
    assert.equal(mensagemPedeAbertura(texto, 'ABRIR'), true, texto);
  }
});

test('texto colado antes ou depois não atrapalha', () => {
  // O usuário edita a mensagem, o teclado sugere algo, o WhatsApp cola assinatura.
  assert.equal(mensagemPedeAbertura('oi, abrir por favor', 'ABRIR'), true);
  assert.equal(mensagemPedeAbertura('ABRIR 🙏', 'ABRIR'), true);
  assert.equal(mensagemPedeAbertura('bom dia! ABRIR a grade', 'ABRIR'), true);
});

test('acento não impede o reconhecimento', () => {
  assert.equal(mensagemPedeAbertura('LIBERAÇÃO', 'liberacao'), true);
  assert.equal(mensagemPedeAbertura('liberacao', 'LIBERAÇÃO'), true);
});

test('palavra parecida não abre', () => {
  // "abrirei" contém "abrir" como substring — não pode valer.
  assert.equal(mensagemPedeAbertura('abrirei amanha', 'ABRIR'), false);
  assert.equal(mensagemPedeAbertura('reabrir', 'ABRIR'), false);
  assert.equal(mensagemPedeAbertura('sobrar', 'ABRIR'), false);
});

test('mensagem comum não abre a grade', () => {
  for (const texto of ['bom dia', 'quanto custa a recarga?', 'oi', '', '   ', '👍']) {
    assert.equal(mensagemPedeAbertura(texto, 'ABRIR'), false, JSON.stringify(texto));
  }
});

test('palavra-chave com mais de um termo exige a sequência', () => {
  assert.equal(mensagemPedeAbertura('abrir grade', 'abrir grade'), true);
  assert.equal(mensagemPedeAbertura('por favor abrir grade agora', 'abrir grade'), true);
  assert.equal(mensagemPedeAbertura('grade abrir', 'abrir grade'), false, 'fora de ordem não vale');
  assert.equal(mensagemPedeAbertura('abrir', 'abrir grade'), false, 'falta o segundo termo');
});

test('entradas inválidas nunca abrem', () => {
  assert.equal(mensagemPedeAbertura(null, 'ABRIR'), false);
  // Palavra-chave vazia cai no padrão 'abrir': ela separa pedido de conversa,
  // não é a proteção — quem autoriza é o segredo do webhook.
  assert.equal(mensagemPedeAbertura('abrir', ''), true, 'sem configuração vale o padrão');
  assert.equal(mensagemPedeAbertura('bom dia', ''), false);
  assert.equal(mensagemPedeAbertura(undefined, undefined), false);
});

test('telefone é reduzido a dígitos', () => {
  assert.equal(normalizarTelefone('+55 (47) 99999-8888'), '5547999998888');
  assert.equal(normalizarTelefone('5547999998888@c.us'), '5547999998888');
  assert.equal(normalizarTelefone(null), '');
});

test('o log guarda o telefone mascarado', () => {
  // Registro de acesso não precisa do número inteiro — DDI, DDD e os quatro
  // últimos bastam para reconhecer quem foi.
  assert.equal(mascararTelefone('5547999998888'), '5547•••••8888');
  assert.equal(mascararTelefone('+55 47 99999-8888'), '5547•••••8888');
  assert.equal(mascararTelefone(''), '');
});

test('lê os nomes de campo das plataformas mais comuns', () => {
  assert.deepEqual(lerMensagemRecebida({ telefone: '5547999998888', texto: 'ABRIR' }),
    { telefone: '5547999998888', texto: 'ABRIR' });
  assert.deepEqual(lerMensagemRecebida({ from: '+55 47 99999-8888', body: 'abrir' }),
    { telefone: '5547999998888', texto: 'abrir' });
  assert.deepEqual(lerMensagemRecebida({ phone: '5547999998888', message: 'abrir' }),
    { telefone: '5547999998888', texto: 'abrir' });
  assert.deepEqual(lerMensagemRecebida({}), { telefone: '', texto: '' });
});
