// PASSO 2 — Importa o arquivo estado-producao.json para a HOMOLOGAÇÃO.
// Este script GRAVA apenas na homologação. Confira duas vezes a URL abaixo:
// ela DEVE ser a do ambiente de TESTE, nunca a da produção.
// Rode com:  node importar-homologacao.mjs
//
// Edite as 3 linhas abaixo com os dados da HOMOLOGAÇÃO (o ambiente de teste):
const HOMOLOG_URL  = 'https://homol-production.up.railway.app';
const HOMOLOG_USER = 'usuario_admin_homologacao';
const HOMOLOG_PASS = 'senha_admin_homologacao';

import { readFileSync } from 'fs';

// Trava de segurança: recusa gravar se a URL não parecer de homologação.
if (!/homol|staging|teste|test/i.test(HOMOLOG_URL)) {
  console.error('❌ Por segurança, o script só grava em URLs de homologação (que contenham "homol", "staging", "teste" ou "test").');
  console.error('   Se sua URL de teste for diferente, ajuste esta verificação de propósito, com cuidado.');
  process.exit(1);
}

async function login(url, user, pass) {
  const res = await fetch(url + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass })
  });
  if (!res.ok) throw new Error(`Login falhou (${res.status}). Confira URL/usuário/senha.`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('Login sem cookie de sessão.');
  return setCookie.split(';')[0];
}

(async () => {
  const state = JSON.parse(readFileSync('estado-producao.json', 'utf8'));
  const n = k => Array.isArray(state[k]) ? state[k].length : '-';
  console.log(`Arquivo lido: clientes=${n('clientes')}  parceiros=${n('parceiros')}  estacoes=${n('estacoes')}  recargas=${n('recargas')}`);
  console.log(`→ Vou GRAVAR estes dados em: ${HOMOLOG_URL}`);

  console.log('→ Logando na HOMOLOGAÇÃO...');
  const cookie = await login(HOMOLOG_URL, HOMOLOG_USER, HOMOLOG_PASS);

  console.log('→ Enviando o estado...');
  const res = await fetch(HOMOLOG_URL + '/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(state)
  });
  if (!res.ok) throw new Error(`Falha ao gravar o estado (${res.status}).`);

  console.log('✅ Dados copiados para a homologação. Recarregue o app (F5) para ver.');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
