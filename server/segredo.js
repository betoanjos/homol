// Comparação de segredo compartilhado — lógica pura, sem banco, para ser
// testável isoladamente.
//
// Usada nas rotas que não têm sessão de usuário: a plataforma de WhatsApp e o
// controlador do portão se identificam por um segredo fixo.
import crypto from 'crypto';

// Comparação em tempo constante. Comparar segredo com === devolve mais rápido
// quando os primeiros caracteres diferem, e isso permite descobrir o valor
// caractere a caractere medindo o tempo de resposta.
//
// timingSafeEqual exige buffers do mesmo tamanho e LANÇA quando diferem, o que
// viraria erro 500 e já entregaria que o tamanho está errado. Por isso o
// tamanho é conferido antes, e tamanho diferente simplesmente não confere.
export function segredoConfere(recebido, esperado) {
  const b = Buffer.from(String(esperado ?? ''), 'utf8');
  if (!b.length) return false;              // sem segredo configurado, nada confere
  const a = Buffer.from(String(recebido ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
