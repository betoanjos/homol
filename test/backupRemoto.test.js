import test from 'node:test';
import assert from 'node:assert/strict';
import { assinarSigV4, encodeCaminho, backupRemotoConfigurado } from '../server/backupRemoto.js';

// Vetor oficial da suite "aws4_testsuite" da AWS (caso get-vanilla). Se a
// implementacao do SigV4 estiver errada em qualquer detalhe — ordem dos
// cabecalhos, formato da data, derivacao da chave — a assinatura muda por
// completo e este teste quebra. E a unica forma de validar a assinatura sem rede.
const VETOR = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  host: 'example.amazonaws.com',
  data: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
  // sha256 de corpo vazio
  payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
};

test('SigV4 reproduz o vetor oficial get-vanilla da AWS', () => {
  const r = assinarSigV4({
    method: 'GET',
    host: VETOR.host,
    caminho: '/',
    query: '',
    payloadHash: VETOR.payloadHash,
    region: VETOR.region,
    service: VETOR.service,
    accessKeyId: VETOR.accessKeyId,
    secretAccessKey: VETOR.secretAccessKey,
    data: VETOR.data
  });

  assert.equal(r.amzDate, '20150830T123600Z');
  assert.equal(r.escopo, '20150830/us-east-1/service/aws4_request');
  assert.equal(r.signedHeaders, 'host;x-amz-date');
  assert.equal(
    r.canonicalRequest,
    ['GET', '/', '', 'host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n', 'host;x-amz-date', VETOR.payloadHash].join('\n')
  );
  assert.equal(r.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.match(r.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/);
});

test('a assinatura muda quando qualquer entrada muda', () => {
  const base = {
    method: 'PUT', host: 'exemplo.com', caminho: '/bucket/arquivo.json', payloadHash: 'a'.repeat(64),
    region: 'us-east-1', service: 's3', accessKeyId: 'AKID', secretAccessKey: 'segredo',
    data: new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
  };
  const original = assinarSigV4(base).signature;

  assert.notEqual(assinarSigV4({ ...base, method: 'GET' }).signature, original);
  assert.notEqual(assinarSigV4({ ...base, caminho: '/bucket/outro.json' }).signature, original);
  assert.notEqual(assinarSigV4({ ...base, payloadHash: 'b'.repeat(64) }).signature, original);
  assert.notEqual(assinarSigV4({ ...base, region: 'sa-east-1' }).signature, original);
  assert.notEqual(assinarSigV4({ ...base, secretAccessKey: 'outro' }).signature, original);
  assert.notEqual(assinarSigV4({ ...base, data: new Date(Date.UTC(2026, 0, 3, 3, 4, 5)) }).signature, original);
});

test('cabecalhos extras entram assinados e em ordem alfabetica', () => {
  const r = assinarSigV4({
    method: 'PUT', host: 'exemplo.com', caminho: '/b/k', payloadHash: 'c'.repeat(64),
    region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'segredo',
    data: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    headersExtras: { 'x-amz-content-sha256': 'c'.repeat(64) }
  });
  assert.equal(r.signedHeaders, 'host;x-amz-content-sha256;x-amz-date');
});

test('o caminho e codificado preservando as barras', () => {
  assert.equal(encodeCaminho('/bucket/pasta/arquivo.json'), '/bucket/pasta/arquivo.json');
  assert.equal(encodeCaminho('/b/backup 2026.json'), '/b/backup%202026.json');
  assert.equal(encodeCaminho('/b/a+b.json'), '/b/a%2Bb.json');
});

test('configuracao incompleta nao e considerada configurada', () => {
  const completo = { endpoint: 'https://s3.exemplo.com', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' };
  assert.equal(backupRemotoConfigurado(completo), true);
  for (const campo of Object.keys(completo)) {
    assert.equal(backupRemotoConfigurado({ ...completo, [campo]: '' }), false, `faltando ${campo}`);
  }
});
