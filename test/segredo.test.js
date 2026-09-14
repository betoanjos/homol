import test from 'node:test';
import assert from 'node:assert/strict';
import { segredoConfere } from '../server/segredo.js';

// É o que separa "a plataforma de WhatsApp pediu para abrir a grade" de
// "qualquer um na internet pediu". As rotas do portão não têm sessão de
// usuário, então este é o único controle de acesso delas.

test('o segredo correto confere', () => {
  assert.equal(segredoConfere('s3gr3d0-longo-e-aleatorio', 's3gr3d0-longo-e-aleatorio'), true);
});

test('segredo errado do mesmo tamanho não confere', () => {
  assert.equal(segredoConfere('aaaaaaaa', 'bbbbbbbb'), false);
  assert.equal(segredoConfere('segredo1', 'segredo2'), false);
});

test('tamanho diferente não confere e não lança', () => {
  // timingSafeEqual lança quando os tamanhos diferem; sem a guarda isso
  // viraria 500 e já denunciaria que o tamanho tentado estava errado.
  assert.doesNotThrow(() => segredoConfere('curto', 'bem-mais-comprido'));
  assert.equal(segredoConfere('curto', 'bem-mais-comprido'), false);
  assert.equal(segredoConfere('bem-mais-comprido', 'curto'), false);
});

test('sem segredo configurado, nada confere', () => {
  // Servidor sem PORTAO_WEBHOOK_SECRET não pode virar portão aberto.
  assert.equal(segredoConfere('', ''), false);
  assert.equal(segredoConfere('qualquer', ''), false);
  assert.equal(segredoConfere('', null), false);
  assert.equal(segredoConfere(null, undefined), false);
});

test('valor ausente não confere com segredo definido', () => {
  assert.equal(segredoConfere(undefined, 'segredo'), false);
  assert.equal(segredoConfere(null, 'segredo'), false);
});

test('prefixo correto não confere', () => {
  // Quem tenta adivinhar caractere a caractere não pode receber "quase".
  assert.equal(segredoConfere('segredo', 'segredo-completo'), false);
  assert.equal(segredoConfere('s', 'segredo-completo'), false);
});

test('acentos e unicode são comparados por bytes', () => {
  assert.equal(segredoConfere('segurança', 'segurança'), true);
  assert.equal(segredoConfere('seguranca', 'segurança'), false);
});
