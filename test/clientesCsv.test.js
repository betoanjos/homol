import test from 'node:test';
import assert from 'node:assert/strict';
import { emailUtilizavel, campoCsv, montarCsvClientes } from '../server/clientesCsv.js';

// A exportação alimenta campanha de e-mail. Um endereço válido descartado aqui
// vira cliente que não recebe; um duplicado vira pessoa recebendo duas vezes,
// que é como se perde descadastro e reputação de remetente.

test('aceita endereços comuns', () => {
  for (const e of ['a@b.com', 'roberto.anjos@evparking.com.br', 'nome+tag@dominio.co']) {
    assert.equal(emailUtilizavel(e), true, e);
  }
});

test('descarta o que claramente não é e-mail', () => {
  for (const e of ['', '   ', 'semarroba.com', 'sem@dominio', 'a@b', null, undefined, 'a @b.com']) {
    assert.equal(emailUtilizavel(e), false, JSON.stringify(e));
  }
});

test('campo com vírgula, aspas ou quebra de linha não quebra o CSV', () => {
  assert.equal(campoCsv('Silva, João'), '"Silva, João"');
  assert.equal(campoCsv('Ele disse "oi"'), '"Ele disse ""oi"""');
  assert.equal(campoCsv('linha1\nlinha2'), 'linha1 linha2');
  assert.equal(campoCsv('simples'), 'simples');
  assert.equal(campoCsv(null), '');
});

test('monta o cabeçalho que o Brevo reconhece', () => {
  const { csv } = montarCsvClientes([], []);
  assert.equal(csv.split('\r\n')[0], 'EMAIL,NOME,TELEFONE,TIPO,GRUPO');
});

test('exporta cliente com grupo e tipo traduzidos', () => {
  const { csv, total } = montarCsvClientes(
    [{ nome: 'Ana', email: 'ana@x.com', telefone: '4799999', tipo: 'pos', grupoId: 'g1' }],
    [{ id: 'g1', nome: 'Motoristas APP' }]
  );
  assert.equal(total, 1);
  assert.match(csv, /ana@x\.com,Ana,4799999,Pós-pago,Motoristas APP/);
});

test('e-mail repetido entra uma vez só', () => {
  const { total, duplicados } = montarCsvClientes([
    { nome: 'Ana', email: 'ana@x.com' },
    { nome: 'Ana 2', email: 'ANA@X.COM' }
  ]);
  assert.equal(total, 1, 'maiúscula não cria um segundo contato');
  assert.equal(duplicados, 1);
});

test('cliente sem e-mail é contado, não exportado', () => {
  const { total, semEmail } = montarCsvClientes([
    { nome: 'Sem email' },
    { nome: 'Invalido', email: 'xxx' },
    { nome: 'Ok', email: 'ok@x.com' }
  ]);
  assert.equal(total, 1);
  assert.equal(semEmail, 2, 'o total precisa bater com a base para ninguém sumir sem explicação');
});

test('grupo inexistente vira coluna vazia, não erro', () => {
  const { csv } = montarCsvClientes([{ nome: 'Ana', email: 'ana@x.com', grupoId: 'inexistente' }], []);
  assert.match(csv, /ana@x\.com,Ana,,,/);
});

test('lista vazia ou inválida devolve só o cabeçalho', () => {
  assert.equal(montarCsvClientes(null).total, 0);
  assert.equal(montarCsvClientes([null, undefined]).total, 0);
});

test('o arquivo termina com quebra de linha', () => {
  // Sem isso, alguns importadores ignoram a última linha.
  const { csv } = montarCsvClientes([{ nome: 'Ana', email: 'ana@x.com' }]);
  assert.ok(csv.endsWith('\r\n'));
});
