// Recorte equivalente do período anterior — lógica pura, testável fora do
// navegador (mesmo padrão de colecao-diff.js e parceiro-regras.js).
//
// O dashboard comparava o mês corrente, que só tem os dias já decorridos,
// contra o mês anterior INTEIRO. No dia 9 isso confronta 9 dias com 31 — a
// queda aparente não significa nada. Aqui calculamos o mesmo trecho do período
// anterior: dia 1 até o mesmo dia do mês.
(function () {
  function ultimoDiaDoMes(ano, mes) {
    return new Date(ano, mes + 1, 0).getDate();
  }

  // Dia 31 não existe em todo mês: comparar 31/03 com o mês anterior precisa
  // parar em 28 ou 29 de fevereiro, não estourar para março.
  function diaClampeado(ano, mes, dia) {
    return Math.min(Number(dia) || 1, ultimoDiaDoMes(ano, mes));
  }

  function ehUltimoDiaDoMes(referencia) {
    return referencia.getDate() === ultimoDiaDoMes(referencia.getFullYear(), referencia.getMonth());
  }

  // Mês anterior, do dia 1 até o mesmo dia do mês de referência.
  //
  // Exceção no fechamento: se a referência é o último dia do mês corrente, o
  // mês está completo e a comparação justa é mês cheio contra mês cheio. Sem
  // isso, 30/09 compararia setembro inteiro com agosto até o dia 30, jogando
  // fora o dia 31 de agosto.
  function trechoMesAnterior(referencia) {
    const base = new Date(referencia.getFullYear(), referencia.getMonth() - 1, 1);
    const ano = base.getFullYear();
    const mes = base.getMonth();
    const diaFim = ehUltimoDiaDoMes(referencia)
      ? ultimoDiaDoMes(ano, mes)
      : diaClampeado(ano, mes, referencia.getDate());
    return { ano, mes, diaInicio: 1, diaFim };
  }

  // Ano anterior, de 1º de janeiro até o mesmo mês e dia da referência.
  function trechoAnoAnterior(referencia) {
    const ano = referencia.getFullYear() - 1;
    const mes = referencia.getMonth();
    return { ano, mesInicio: 0, diaInicio: 1, mesFim: mes, diaFim: diaClampeado(ano, mes, referencia.getDate()) };
  }

  // Sufixo do rótulo, para o card dizer que o recorte é parcial. No último dia
  // do mês o trecho cobre o mês inteiro e o sufixo some.
  function rotuloParcial(ano, mes, diaFim) {
    return diaFim >= ultimoDiaDoMes(ano, mes) ? '' : ` · 1 a ${diaFim}`;
  }

  window.EVPeriodoComparativo = { ultimoDiaDoMes, diaClampeado, ehUltimoDiaDoMes, trechoMesAnterior, trechoAnoAnterior, rotuloParcial };
})();
