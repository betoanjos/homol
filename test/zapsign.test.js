import test from 'node:test';
import assert from 'node:assert/strict';
import { assinaturaConfig, criarDocumentoZapSign } from '../server/contratos/zapsign.js';

test('modo simulador não realiza chamadas externas', async () => {
  const anterior = process.env.CONTRACTS_SIGNATURE_MODE;
  process.env.CONTRACTS_SIGNATURE_MODE = 'simulator';
  try {
    const cfg = assinaturaConfig();
    assert.equal(cfg.mode, 'simulator');
    assert.equal(cfg.configured, true);
    const retorno = await criarDocumentoZapSign({
      contratoId: '00000000-0000-4000-8000-000000000001',
      nomeArquivo: 'contrato.pdf',
      pdfBase64: 'JVBERi0xLjQ=',
      signatarios: [{ nome: 'Parceiro', email: 'parceiro@example.com' }, { nome: 'Integrador', email: 'integrador@example.com' }],
    });
    assert.equal(retorno.simulated, true);
    assert.equal(retorno.signers.length, 2);
  } finally {
    if (anterior === undefined) delete process.env.CONTRACTS_SIGNATURE_MODE;
    else process.env.CONTRACTS_SIGNATURE_MODE = anterior;
  }
});

