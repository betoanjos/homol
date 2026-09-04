// Regra que decide qual fatura recebe a baixa quando chega um webhook de
// pagamento — lógica pura, sem banco, para ser testável isoladamente (mesmo
// padrão de contratos/validacao.js, estadoValidacao.js e tupiFormato.js).
//
// Um falso positivo marca como paga uma fatura que ninguém pagou; um falso
// negativo deixa o cliente pagando e a cobrança em aberto.

// Comparação sempre por string: o id do pagamento chega ora como número, ora
// como texto, dependendo do formato do webhook. Valores vazios nunca casam
// entre si — do contrário, um webhook sem referência externa marcaria como
// paga toda fatura que ainda não tem Pix emitido.
export function faturaCorrespondeAoPagamento(f, paymentId, externalReference) {
  if (!f) return false;
  const pid = paymentId == null ? '' : String(paymentId);
  const ref = externalReference == null ? '' : String(externalReference);
  const igual = (valor, alvo) => alvo !== '' && String(valor ?? '') === alvo;
  return (
    igual(f.pixPaymentId, pid) ||
    igual(f.paymentId, pid) ||
    igual(f.pixTxid, pid) ||
    igual(f.id, ref) ||
    igual(f.numero, ref)
  );
}
