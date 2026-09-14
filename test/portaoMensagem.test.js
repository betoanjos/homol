import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarTelefone, mascararTelefone, mensagemPedeAbertura, lerMensagemRecebida, midiaPareceUrl } from '../server/portaoMensagem.js';

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
    { telefone: '5547999998888', texto: 'ABRIR', midiaUrl: '' });
  assert.deepEqual(lerMensagemRecebida({ from: '+55 47 99999-8888', body: 'abrir' }),
    { telefone: '5547999998888', texto: 'abrir', midiaUrl: '' });
  assert.deepEqual(lerMensagemRecebida({ phone: '5547999998888', message: 'abrir' }),
    { telefone: '5547999998888', texto: 'abrir', midiaUrl: '' });
  assert.deepEqual(lerMensagemRecebida({}), { telefone: '', texto: '', midiaUrl: '' });
});

// ─── Foto da placa ──────────────────────────────────────────────────────────
// Pedida antes de liberar, como rastro junto do telefone e do horário. Placa é
// dado comum; selfie e documento seriam dado pessoal sensível, com obrigação
// desproporcional para abrir um portão.

test('lê a URL da foto nos nomes de campo mais comuns', () => {
  const url = 'https://midia.exemplo.com/abc123.jpg';
  for (const campo of ['midiaUrl', 'media_url', 'imagem', 'foto', 'anexo', 'attachment', 'url']) {
    assert.equal(lerMensagemRecebida({ telefone: '5547999998888', texto: 'abrir', [campo]: url }).midiaUrl, url, campo);
  }
});

test('mensagem sem foto devolve midiaUrl vazia', () => {
  assert.equal(lerMensagemRecebida({ telefone: '5547999998888', texto: 'abrir' }).midiaUrl, '');
  assert.equal(lerMensagemRecebida({}).midiaUrl, '');
});

test('campo de mídia em branco não vira foto', () => {
  assert.equal(lerMensagemRecebida({ foto: '   ' }).midiaUrl, '');
  assert.equal(lerMensagemRecebida({ foto: null, imagem: 'https://x.com/a.jpg' }).midiaUrl, 'https://x.com/a.jpg');
});

test('só aceita como foto o que é endereço de verdade', () => {
  assert.equal(midiaPareceUrl('https://midia.exemplo.com/abc.jpg'), true);
  assert.equal(midiaPareceUrl('http://midia.exemplo.com/abc.jpg'), true);
  // Algumas plataformas mandam o id interno do arquivo no mesmo campo;
  // guardar isso como se fosse foto daria falsa sensação de registro.
  assert.equal(midiaPareceUrl('1234567890'), false);
  assert.equal(midiaPareceUrl('media_id:abc123'), false);
  assert.equal(midiaPareceUrl(''), false);
  assert.equal(midiaPareceUrl(null), false);
});
