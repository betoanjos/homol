// PASSO 1 — Exporta o estado da PRODUÇÃO para um arquivo local.
// Este script é SOMENTE LEITURA na produção: ele apenas baixa os dados.
// Rode com:  node exportar-producao.mjs
//
// Edite as 3 linhas abaixo com os dados da PRODUÇÃO (o sistema oficial):
const PROD_URL  = 'https://evocore.com.br';
const PROD_USER = 'admin';
const PROD_PASS = '@Hope8899#';

import { writeFileSync } from 'fs';

async function login(url, user, pass) {
  const res = await fetch(url + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass })
  });
  if (!res.ok) throw new Error(`Login falhou (${res.status}). Confira URL/usuário/senha.`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('Login sem cookie de sessão.');
  return setCookie.split(';')[0]; // evcore_session=...
}

(async () => {
  console.log('→ Logando na PRODUÇÃO (somente leitura)...');
  const cookie = await login(PROD_URL, PROD_USER, PROD_PASS);

  console.log('→ Baixando o estado...');
  const res = await fetch(PROD_URL + '/api/state', { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`Falha ao baixar o estado (${res.status}).`);
  const state = await res.json();

  const n = k => Array.isArray(state[k]) ? state[k].length : '-';
  console.log(`  clientes=${n('clientes')}  parceiros=${n('parceiros')}  estacoes=${n('estacoes')}  recargas=${n('recargas')}  faturas=${n('faturas')}`);

  writeFileSync('estado-producao.json', JSON.stringify(state, null, 2));
  console.log('✅ Salvo em estado-producao.json. Agora rode: node importar-homologacao.mjs');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
