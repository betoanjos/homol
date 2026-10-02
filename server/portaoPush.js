// Protocolo "push" do iDFace (Control iD) — lógica pura, sem banco, para ser
// testável isoladamente (mesmo padrão de portaoMensagem.js e segredo.js).
//
// No modo push o aparelho é quem consulta: a cada poucos segundos faz
//   GET /push?deviceId=<id>&uuid=<uuid>
// e o servidor responde VAZIO (nada a fazer) ou com um comando em JSON. Depois
// de executar, o aparelho devolve o resultado em POST /result.
//
// É o mesmo desenho do controlador que consulta /api/portao/pendente, só que o
// consultante agora é o próprio leitor facial e não um relé à parte: dispensa
// firmware nosso, IP fixo e porta aberta.
//
// Limitação aceita: a documentação do push não prevê token nem HTTPS, só
// "IP:porta". A identificação é o deviceId. Quem souber esse número consegue
// consumir uma liberação pendente — sabotagem, não arrombamento, porque a
// abertura é executada pelo aparelho e não por quem consultou.
//
// Documentação: https://www.controlid.com.br/docs/access-api-en/push-mode/introduction-to-push/

// Só dígitos. O deviceId é um inteiro de 64 bits; qualquer outra coisa é lixo
// ou tentativa de injetar texto em algo que depois é comparado e logado.
export function normalizarDeviceId(valor) {
  const s = String(valor ?? '').trim();
  return /^\d{1,20}$/.test(s) ? s : '';
}

// Qual estação é dona do aparelho. O vínculo fica no cadastro da estação
// (campo idfaceId), do mesmo jeito que a frase de liberação.
export function estacaoDoAparelho(estacoes, deviceId) {
  const id = normalizarDeviceId(deviceId);
  if (!id) return null;
  return (estacoes || []).find(e => e && normalizarDeviceId(e.idfaceId) === id) || null;
}

// Comando de abertura remota. O iDFace abre pela ação "sec_box" — a fechadura
// fica no relé do módulo de acionamento externo —, e não por "door", que é
// das famílias com relé no próprio terminal (iDAccess, iDFit, iDBox).
//
//   id     identificador do módulo de acionamento no barramento RS-485
//   reason código do motivo da abertura (a documentação só exemplifica o 3)
//
// bodyComoTexto existe porque a documentação descreve o campo `body` como
// string mas exemplifica com objeto. Começa como objeto, que é o exemplo, e dá
// para virar texto por variável de ambiente sem novo deploy se o aparelho
// recusar — o motivo da recusa aparece em /result.
export function montarComandoAbertura({ secboxId = '65793', reason = '3', bodyComoTexto = false } = {}) {
  const corpo = {
    actions: [{ action: 'sec_box', parameters: `id=${secboxId}, reason=${reason}` }]
  };
  return {
    verb: 'POST',
    endpoint: 'execute_actions',
    body: bodyComoTexto ? JSON.stringify(corpo) : corpo,
    contentType: 'application/json'
  };
}

// Lê o que o aparelho devolve em /result. Aceita JSON ou formulário e nunca
// lança: o corpo vem de fora e o resultado só serve para registro.
export function lerResultado(corpo) {
  const c = corpo && typeof corpo === 'object' ? corpo : {};
  const erro = c.error != null && String(c.error).trim() !== '' ? String(c.error).trim() : '';
  const endpoint = String(c.endpoint ?? '').trim();
  let resposta = c.response;
  if (resposta != null && typeof resposta === 'object') {
    try { resposta = JSON.stringify(resposta); } catch { resposta = String(resposta); }
  }
  return {
    ok: !erro,
    endpoint,
    texto: erro ? `erro: ${erro}` : (resposta != null && String(resposta) !== '' ? `ok: ${String(resposta)}` : 'ok')
  };
}
