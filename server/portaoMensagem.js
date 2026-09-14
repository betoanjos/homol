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

// Primeiro valor não vazio de uma lista de nomes possíveis.
function primeiro(corpo, nomes) {
  for (const nome of nomes) {
    const v = corpo?.[nome];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// Interpreta o corpo recebido da plataforma de mensagens. Cada uma nomeia os
// campos de um jeito, então aceitamos os formatos mais comuns em vez de
// amarrar o EV Core a um fornecedor.
//
// `midiaUrl` é a foto da placa do veículo, pedida antes de liberar. Serve de
// rastro junto do telefone e do horário. Foto de placa é dado comum, ao
// contrário de selfie ou documento, que são dado pessoal sensível e trariam
// obrigação desproporcional para abrir um portão.
export function lerMensagemRecebida(corpo = {}) {
  const telefone = normalizarTelefone(
    primeiro(corpo, ['telefone', 'phone', 'from', 'sender', 'numero'])
  );
  const texto = primeiro(corpo, ['texto', 'text', 'message', 'body', 'mensagem']);
  const midiaUrl = primeiro(corpo, [
    'midiaUrl', 'midia_url', 'mediaUrl', 'media_url', 'midia', 'media',
    'imagem', 'image', 'foto', 'arquivo', 'file', 'anexo', 'attachment', 'url'
  ]);
  return { telefone, texto, midiaUrl };
}

// Descobre a QUAL estação a mensagem se refere.
//
// O único sinal que viaja do QR até aqui é o texto, então cada estação tem a
// sua frase, cadastrada em `palavraLiberacao`. Sem isso, com duas estações,
// uma mensagem em Curitiba acionaria o trinco de todas — os controladores
// consultam a mesma fila.
//
// Quando duas frases servem para a mesma mensagem (uma contém a outra, como
// "liberar acesso estação" e "liberar acesso estação Mafra"), vence a MAIS
// LONGA. A mais específica é a que o QR daquela estação manda; a curta só
// casou por ser prefixo, e abrir o portão errado é pior que não abrir.
export function resolverEstacaoDaMensagem(estacoes, texto) {
  const candidatas = (estacoes || [])
    .filter(e => e && String(e.palavraLiberacao || '').trim())
    .filter(e => mensagemPedeAbertura(texto, e.palavraLiberacao));
  if (!candidatas.length) return null;
  return candidatas.reduce((melhor, e) =>
    String(e.palavraLiberacao).trim().length > String(melhor.palavraLiberacao).trim().length ? e : melhor
  );
}

// A URL da mídia precisa ser buscável depois. Rejeita o que claramente não é
// endereço — algumas plataformas mandam o identificador interno do arquivo no
// mesmo campo, e guardar isso como se fosse foto daria falsa sensação de
// registro.
export function midiaPareceUrl(valor) {
  const s = String(valor || '').trim();
  return /^https?:\/\/\S+$/i.test(s);
}
