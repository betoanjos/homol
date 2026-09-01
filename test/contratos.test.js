import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularPremissas, documentoValido, normalizarDadosContrato, validarDadosContrato } from '../server/contratos/validacao.js';

const dadosValidos = {
  parceiroId: 'par_1', estacaoId: 'est_1', razaoSocial: 'Parceiro Teste Ltda', cnpj: '23.494.616/0001-61',
  enderecoParceiro: 'Rua Teste, 10', representanteNome: 'Representante Teste', representanteCpf: '867.483.789-15',
  representanteEmail: 'representante@example.com', enderecoEstacao: 'Rodovia Teste, km 1',
  dataContrato: '2026-09-01', cidadeForo: 'São Mateus do Sul - PR',
  potenciaKw: 40, investimento: 318000, custoEnergia: .94, precoKwh: 1.99,
  taxaOperacionalPct: 22, comissaoPct: 12, recargasMensais: 160, consumoMedioKwh: 25,
};

test('reproduz as premissas financeiras do contrato GMAX', () => {
  const c = calcularPremissas(dadosValidos);
  assert.equal(c.energiaMensalKwh, 4000);
  assert.equal(c.receitaBruta, 7960);
  assert.equal(c.custoEnergiaMensal, 3760);
  assert.equal(c.taxaOperacional, 1751.2);
  assert.ok(Math.abs(c.receitaLiquida - 2448.8) < 1e-9);
  assert.ok(Math.abs(c.comissao - 293.856) < 1e-9);
  assert.ok(Math.abs(c.repasseTotal - 4053.856) < 1e-9);
});

test('normalização aplica os padrões contratuais aprovados', () => {
  const d = normalizarDadosContrato({ parceiroId: 'x' });
  assert.equal(d.prazoMeses, 48);
  assert.equal(d.avisoPrevioDias, 90);
  assert.equal(d.taxaOperacionalPct, 22);
  assert.equal(d.comissaoPct, 12);
  assert.equal(d.internetMbps, 20);
});

test('validação exige identidade e e-mail do signatário', () => {
  const r = validarDadosContrato({ ...dadosValidos, representanteEmail: 'invalido', representanteCpf: '' });
  assert.equal(r.ok, false);
  assert.match(r.erros.join(' '), /CPF do representante/);
  assert.match(r.erros.join(' '), /e-mail válido/);
});

test('dados válidos são aceitos', () => {
  const r = validarDadosContrato(dadosValidos);
  assert.equal(r.ok, true);
  assert.deepEqual(r.erros, []);
});

test('valida dígitos verificadores de CPF e CNPJ', () => {
  assert.equal(documentoValido('867.483.789-15'), true);
  assert.equal(documentoValido('23.494.616/0001-61'), true);
  assert.equal(documentoValido('23.494.616/0001-62'), false);
  assert.equal(documentoValido('111.111.111-11'), false);
});
