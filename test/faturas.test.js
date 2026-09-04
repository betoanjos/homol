import test from 'node:test';
import assert from 'node:assert/strict';
import { faturaCorrespondeAoPagamento } from '../server/faturasPagamento.js';

// Esta é a regra que decide qual cobrança recebe a baixa quando o webhook do
// Mercado Pago chega. Um falso positivo marca como paga uma fatura que ninguém
// pagou; um falso negativo deixa o cliente pagando e a fatura em aberto.

const fatura = extra => ({ id: 'fat_1', numero: 'EVP1234500', ...extra });

test('casa pelo pixPaymentId', () => {
  assert.equal(faturaCorrespondeAoPagamento(fatura({ pixPaymentId: '111' }), '111', ''), true);
});

test('casa pelos campos alternativos de pagamento', () => {
  assert.equal(faturaCorrespondeAoPagamento(fatura({ paymentId: '222' }), '222', ''), true);
  assert.equal(faturaCorrespondeAoPagamento(fatura({ pixTxid: '333' }), '333', ''), true);
});

test('casa pela referência externa, por id ou número', () => {
  assert.equal(faturaCorrespondeAoPagamento(fatura(), '999', 'fat_1'), true);
  assert.equal(faturaCorrespondeAoPagamento(fatura(), '999', 'EVP1234500'), true);
});

test('compara número com string — o id do MP chega como número', () => {
  assert.equal(faturaCorrespondeAoPagamento(fatura({ pixPaymentId: 111 }), '111', ''), true);
  assert.equal(faturaCorrespondeAoPagamento(fatura({ pixPaymentId: '111' }), 111, ''), true);
});

test('fatura sem vínculo com o pagamento não é marcada', () => {
  assert.equal(faturaCorrespondeAoPagamento(fatura({ pixPaymentId: '111' }), '222', ''), false);
  assert.equal(faturaCorrespondeAoPagamento(fatura(), '222', 'outro'), false);
});

test('campos vazios não podem casar entre si', () => {
  // O risco real: fatura sem Pix (pixPaymentId undefined) contra um webhook
  // sem externalReference. Se '' casasse com '', toda fatura sem Pix seria
  // marcada como paga de uma vez.
  assert.equal(faturaCorrespondeAoPagamento(fatura(), '', ''), false);
  assert.equal(faturaCorrespondeAoPagamento(fatura({ pixPaymentId: '' }), '', ''), false);
  assert.equal(faturaCorrespondeAoPagamento(fatura({ pixPaymentId: null }), null, undefined), false);
});

test('registro ausente não quebra a comparação', () => {
  assert.equal(faturaCorrespondeAoPagamento(null, '111', ''), false);
  assert.equal(faturaCorrespondeAoPagamento(undefined, '111', ''), false);
});
