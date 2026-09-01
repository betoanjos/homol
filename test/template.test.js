import test from 'node:test';
import assert from 'node:assert/strict';

global.window = {};
await import('../public/contratos-template.js');

const dados = {
  razaoSocial: 'GODOY & RETZLAFF COMBUSTIVEIS LTDA', nomeFantasia: 'GMAX', cnpj: '23.494.616/0001-61',
  inscricaoEstadual: '90743400-13', enderecoParceiro: 'Rua Rodolfo Wolff, 30', representanteNome: 'Alexandre de Oliveira Godoy',
  representanteCpf: '867.483.789-15', enderecoEstacao: 'Rodovia BR-476, Rua Rodolfo Wolff, 30', fabricante: 'WEG',
  modelo: 'WEMOB Station', potenciaKw: 40, potenciaOperacionalKw: 40, quantidadeSaidas: 1, quantidadeVagas: 1,
  conectores: 'CCS2', tensaoV: 380, disjuntorA: 0, internetMbps: 20, operacao24h: true, prazoMeses: 48,
  avisoPrevioDias: 90, investimento: 318000, custoEnergia: .94, precoKwh: 1.99, taxaOperacionalPct: 22,
  comissaoPct: 12, recargasMensais: 160, consumoMedioKwh: 25, cidadeForo: 'São Mateus do Sul - PR', dataContrato: '2026-09-01'
};
const calculos = { energiaMensalKwh:4000, receitaBruta:7960, custoEnergiaMensal:3760, taxaOperacional:1751.2, receitaLiquida:2448.8, comissao:293.856, repasseTotal:4053.856 };

test('modelo contém as correções contratuais aprovadas', () => {
  const conteudo = window.EVContratoTemplate.gerarConteudoContrato(dados, calculos, { integrador:{} });
  const texto = conteudo.map(x => x.text || `${x.left || ''} ${x.right || ''}`).join('\n');
  assert.match(texto, /48 \(quarenta e oito\) meses/);
  assert.match(texto, /taxa operacional contratual fixa: 22,00%/i);
  assert.match(texto, /somente poderá ser alterado por termo aditivo/i);
  assert.match(texto, /INTEGRADOR deverá retirar os equipamentos/i);
  assert.match(texto, /R\$\s*4\.053,86/);
  assert.doesNotMatch(texto, /CONTRATANTE/);
});

