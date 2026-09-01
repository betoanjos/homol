const API_BASE = (process.env.ZAPSIGN_API_BASE || 'https://api.zapsign.com.br/api/v1').replace(/\/$/, '');
const AUTH_MODES = new Set(['assinaturaTela', 'tokenEmail', 'assinaturaTela-tokenEmail', 'tokenSms', 'assinaturaTela-tokenSms', 'tokenWhatsapp', 'assinaturaTela-tokenWhatsapp', 'certificadoDigital']);

function config() {
  return {
    mode: String(process.env.CONTRACTS_SIGNATURE_MODE || 'simulator').toLowerCase(),
    token: String(process.env.ZAPSIGN_API_TOKEN || '').trim(),
  };
}

async function apiZapSign(path, options = {}) {
  const { token } = config();
  if (!token) throw new Error('ZAPSIGN_API_TOKEN não configurado.');
  const resposta = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const texto = await resposta.text();
  let corpo = {};
  try { corpo = texto ? JSON.parse(texto) : {}; } catch { corpo = { detail: texto }; }
  if (!resposta.ok) {
    const detalhe = corpo.detail || corpo.error || corpo.message || `HTTP ${resposta.status}`;
    throw new Error(`ZapSign: ${detalhe}`);
  }
  return corpo;
}

export function assinaturaConfig() {
  const cfg = config();
  return { mode: cfg.mode, configured: cfg.mode === 'simulator' || Boolean(cfg.token), provider: 'zapsign' };
}

export async function criarDocumentoZapSign({ contratoId, nomeArquivo, pdfBase64, signatarios }) {
  const cfg = config();
  if (cfg.mode === 'simulator') {
    return {
      token: `sim_doc_${contratoId}`,
      status: 'pending',
      signers: signatarios.map((s, i) => ({ token: `sim_signer_${contratoId}_${i + 1}`, name: s.nome, email: s.email })),
      simulated: true,
    };
  }

  const authModeEnv = String(process.env.ZAPSIGN_AUTH_MODE || 'assinaturaTela-tokenEmail').trim();
  const authMode = AUTH_MODES.has(authModeEnv) ? authModeEnv : 'assinaturaTela-tokenEmail';

  const payload = {
    name: nomeArquivo,
    base64_pdf: pdfBase64,
    lang: 'pt-br',
    external_id: contratoId,
    signed_file_only_finished: true,
    signers: signatarios.map(s => {
      let telefone = String(s.telefone || '').replace(/\D/g, '');
      if (telefone.startsWith('55') && telefone.length >= 12) telefone = telefone.slice(2);
      return {
        name: s.nome,
        email: s.email,
        auth_mode: authMode,
        send_automatic_email: true,
        ...(telefone ? { phone_country: '55', phone_number: telefone } : {}),
      };
    }),
  };
  return apiZapSign('/docs/', { method: 'POST', body: JSON.stringify(payload) });
}

export async function detalharDocumentoZapSign(tokenDocumento) {
  return apiZapSign(`/docs/${encodeURIComponent(tokenDocumento)}/`, { method: 'GET' });
}

export async function baixarArquivoZapSign(url) {
  if (!url || !/^https:\/\//i.test(url)) throw new Error('URL de arquivo da ZapSign inválida.');
  const resposta = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resposta.ok) throw new Error(`Não foi possível baixar o arquivo assinado (HTTP ${resposta.status}).`);
  return Buffer.from(await resposta.arrayBuffer());
}
