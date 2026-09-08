// Regras de seleção de recargas para o repasse ao parceiro — lógica pura,
// para ser testável fora do navegador (mesmo padrão de colecao-diff.js).
//
// Recargas sem valor cobrado são cortesia do próprio parceiro: ele mantém um
// cadastro com tarifa zerada e recarrega de graça. Não geram receita, então
// não entram na base do repasse — a rede não deve pagar o kWh de uma recarga
// que o parceiro ofereceu por conta própria.
//
// Isso vale para o PDF do parceiro, que é o documento de conferência e
// pagamento. As telas internas continuam enxergando todas as recargas.
(function () {
  // Valor efetivamente cobrado. `??` só cai para o próximo quando o anterior é
  // null/undefined, então uma recarga com cobranca = 0 é zero mesmo que tenha
  // `total` preenchido — cobranca é a palavra final sobre o que foi cobrado.
  function valorCobrado(r) {
    if (!r) return 0;
    return Number(r.cobranca ?? r.total ?? 0) || 0;
  }

  function foiCobrada(r) {
    return valorCobrado(r) > 0;
  }

  // Separa a lista entre o que entra no repasse e o que fica de fora.
  // O total de kWh descartado é devolvido para conferência interna.
  function separarPorCobranca(lista) {
    const cobradas = [];
    const descartadas = [];
    (lista || []).forEach(r => {
      if (!r) return;
      (foiCobrada(r) ? cobradas : descartadas).push(r);
    });
    return {
      cobradas,
      semCobranca: {
        quantidade: descartadas.length,
        kwh: descartadas.reduce((s, r) => s + (Number(r.kwh || 0) || 0), 0),
        lista: descartadas
      }
    };
  }

  // Define as duas listas do relatório do parceiro:
  //   base     — o que entra em TODOS os cálculos (receita, kWh, custo de
  //              energia, base de comissão, repasse)
  //   exibicao — o que é detalhado linha a linha no PDF
  //
  // Parceiro comum: as recargas gratuitas são cortesia dele, com cadastro de
  // tarifa zerada. Não entram em cálculo nenhum — a rede não paga o kWh de
  // algo que ele ofereceu por conta própria. Continuam no painel para edição
  // futura; ganhando valor, entram normalmente.
  //
  // energiaPelaRede: a rede paga a concessionária direto e as recargas
  // gratuitas são da nossa própria equipe. O kWh entra no custo (a rede
  // pagou mesmo), mas não é cobrado de ninguém nem gera comissão — o que já
  // decorre de não haver receita. Por isso a base inclui tudo, enquanto a
  // listagem segue mostrando só o que foi cobrado do parceiro.
  function baseDoRelatorio(lista, opcoes) {
    const { cobradas, semCobranca } = separarPorCobranca(lista);
    const energiaPelaRede = !!(opcoes && opcoes.energiaPelaRede);
    return {
      base: energiaPelaRede ? (lista || []).filter(Boolean) : cobradas,
      exibicao: cobradas,
      semCobranca
    };
  }

  // Quanto da mensalidade do integrador é efetivamente cobrado no mês.
  //
  // A mensalidade é receita da rede, cobrada do parceiro por abatimento no
  // repasse — não é um custo da operação. Por isso ela só pode ser cobrada
  // até onde o repasse alcança: se o mês não gerou repasse, o parceiro não
  // paga nada, e o resultado nunca fica negativo. Sem esse limite, um mês sem
  // recargas aparecia como prejuízo do valor cheio da mensalidade.
  //
  // O saldo não cobrado não é acumulado para os meses seguintes.
  function mensalidadeCobravel(mensalidade, repasseBruto) {
    const devida = Number(mensalidade || 0) || 0;
    const disponivel = Number(repasseBruto || 0) || 0;
    if (devida <= 0 || disponivel <= 0) return 0;
    return Math.min(devida, disponivel);
  }

  window.EVParceiroRegras = { valorCobrado, foiCobrada, separarPorCobranca, baseDoRelatorio, mensalidadeCobravel };
})();
