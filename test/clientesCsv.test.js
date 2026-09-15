import test from 'node:test';
import assert from 'node:assert/strict';
import { emailUtilizavel, campoCsv, montarCsvClientes, contarRecargasPorCliente, ufPorCliente } from '../server/clientesCsv.js';

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
  assert.equal(csv.split('\r\n')[0], 'EMAIL,NOME,TELEFONE,TIPO,GRUPO,RECARGAS,UF');
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

// ─── Segmentação: recorrentes e por estado ──────────────────────────────────

const base = [
  { id: 'c1', nome: 'Ana',   email: 'ana@x.com',   rfid: 'AAA111' },
  { id: 'c2', nome: 'Bruno', email: 'bruno@x.com', doc: '123.456.789-00' },
  { id: 'c3', nome: 'Caio',  email: 'caio@x.com' }
];

test('conta recargas por clienteId, RFID e e-mail', () => {
  // Recarga vinda da API nasce só com e-mail e só ganha clienteId depois da
  // classificação. Contar apenas por id deixaria de fora justamente o cliente
  // recorrente que a campanha quer alcançar.
  const contagens = contarRecargasPorCliente(base, [
    { clienteId: 'c1' },
    { rfid: 'aaa111' },
    { email: 'ANA@X.COM' },
    { email: 'bruno@x.com' },
    { email: 'ninguem@x.com' }
  ]);
  assert.equal(contagens.get('c1'), 3, 'as três formas de vínculo somam no mesmo cliente');
  assert.equal(contagens.get('c2'), 1);
  assert.equal(contagens.get('c3'), undefined);
});

test('recarga de quem não é cliente não conta para ninguém', () => {
  const contagens = contarRecargasPorCliente(base, [{ email: 'desconhecido@x.com' }, null]);
  assert.equal(contagens.size, 0);
});

test('UF vem do e-mail ou do documento dos dados da Tupi', () => {
  const ufs = ufPorCliente(base, {
    porEmail: { 'ana@x.com': 'pr' },
    porDocumento: { '12345678900': 'SC' }
  });
  assert.equal(ufs.get('c1'), 'PR', 'normaliza para maiúscula');
  assert.equal(ufs.get('c2'), 'SC', 'casa pelo documento só com dígitos');
  assert.equal(ufs.get('c3'), undefined);
});

test('filtro de recorrentes deixa passar só quem atinge o mínimo', () => {
  const contagens = new Map([['c1', 5], ['c2', 1], ['c3', 2]]);
  const { csv, total, foraDoFiltro } = montarCsvClientes(base, [], { contagens, minRecargas: 2 });
  assert.equal(total, 2);
  assert.equal(foraDoFiltro, 1);
  assert.match(csv, /ana@x\.com/);
  assert.match(csv, /caio@x\.com/);
  assert.doesNotMatch(csv, /bruno@x\.com/, 'quem recarregou uma vez fica fora');
});

test('filtro por UF ignora quem não tem estado conhecido', () => {
  // Incluir "talvez seja do Paraná" num recorte regional é o mesmo que não
  // ter recorte — a oferta chegaria a quem não pode usá-la.
  const ufs = new Map([['c1', 'PR'], ['c2', 'SC']]);
  const { csv, total } = montarCsvClientes(base, [], { ufs, uf: 'PR' });
  assert.equal(total, 1);
  assert.match(csv, /ana@x\.com/);
  assert.doesNotMatch(csv, /caio@x\.com/, 'sem UF conhecida não entra no recorte por estado');
});

test('UF aceita minúscula no filtro', () => {
  const ufs = new Map([['c1', 'PR']]);
  assert.equal(montarCsvClientes(base, [], { ufs, uf: 'pr' }).total, 1);
});

test('os dois filtros juntos se somam', () => {
  const contagens = new Map([['c1', 4], ['c2', 9], ['c3', 7]]);
  const ufs = new Map([['c1', 'PR'], ['c2', 'SC'], ['c3', 'PR']]);
  const { total, csv } = montarCsvClientes(base, [], { contagens, ufs, minRecargas: 5, uf: 'PR' });
  assert.equal(total, 1, 'só quem é do PR E recorrente');
  assert.match(csv, /caio@x\.com/);
});

test('sem filtro, todo mundo sai e as colunas novas vêm preenchidas', () => {
  const contagens = new Map([['c1', 4]]);
  const ufs = new Map([['c1', 'PR']]);
  const { total, csv, semUfConhecida } = montarCsvClientes(base, [], { contagens, ufs });
  assert.equal(total, 3);
  assert.match(csv, /ana@x\.com,Ana,,,,4,PR/);
  assert.equal(semUfConhecida, 2);
});
