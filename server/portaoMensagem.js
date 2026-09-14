// Interpretação da mensagem de WhatsApp que libera a grade de proteção da
// estação — lógica pura, sem banco, para ser testável isoladamente (mesmo
// padrão de contratos/validacao.js e estadoValidacao.js).
//
// O motorista toca no QR da grade, o WhatsApp abre com o texto já digitado e
// ele aperta enviar. A plataforma de mensagens chama nosso endpoint, e é aqui
// que se decide se aquela mensagem é mesmo um pedido de abertura.
//
// A comparação precisa ser tolerante: teclado com autocorreção, acento,
// maiúscula, emoji e texto colado antes ou depois são todos esperados. O que
// não pode é abrir com uma mensagem que só menciona a palavra por acaso.

// Só dígitos. Números de WhatsApp chegam como 5547999998888.
export function normalizarTelefone(valor) {
  return String(valor || '').replace(/\D/g, '');
}

// Para log e tela: preserva DDI/DDD e os quatro últimos, esconde o miolo.
// Registrar o número inteiro em log de acesso é dado pessoal sem necessidade.
export function mascararTelefone(valor) {
  const d = normalizarTelefone(valor);
  if (d.length < 8) return d ? '•'.repeat(d.length) : '';
  return `${d.slice(0, 4)}${'•'.repeat(Math.max(0, d.length - 8))}${d.slice(-4)}`;
}

// Remove acento, baixa a caixa e reduz tudo que não é letra ou número a um
// espaço — assim "Abrir!", "ABRIR 🙏" e "abrir." chegam iguais aqui.
function normalizarTexto(valor) {
  return String(valor || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const PALAVRA_PADRAO = 'abrir';

// A mensagem pede abertura quando a palavra-chave aparece como palavra
// inteira. Exigir a mensagem exata quebraria com qualquer texto extra que o
// WhatsApp ou o usuário acrescentem; aceitar substring abriria com "abrirei".
//
// A palavra-chave NÃO é o mecanismo de segurança — ela só separa um pedido de
// abertura de uma conversa qualquer que chegue no mesmo número. Quem autoriza
// a chamada é o segredo compartilhado do webhook. Por isso ela tem um padrão
// em vez de falhar fechado: sem configuração, vale "abrir".
export function mensagemPedeAbertura(texto, palavraChave) {
  const alvo = normalizarTexto(palavraChave || PALAVRA_PADRAO);
  if (!alvo) return false;
  const msg = normalizarTexto(texto);
  if (!msg) return false;
  const palavras = msg.split(' ');
  const partes = alvo.split(' ');
  // Palavra-chave com mais de um termo: procura a sequência.
  for (let i = 0; i + partes.length <= palavras.length; i++) {
    if (partes.every((p, j) => palavras[i + j] === p)) return true;
  }
  return false;
}

// Interpreta o corpo recebido da plataforma de mensagens. Cada uma nomeia os
// campos de um jeito, então aceitamos os formatos mais comuns em vez de
// amarrar o EV Core a um fornecedor.
export function lerMensagemRecebida(corpo = {}) {
  const telefone = normalizarTelefone(
    corpo.telefone ?? corpo.phone ?? corpo.from ?? corpo.sender ?? corpo.numero ?? ''
  );
  const texto = String(
    corpo.texto ?? corpo.text ?? corpo.message ?? corpo.body ?? corpo.mensagem ?? ''
  );
  return { telefone, texto };
}
