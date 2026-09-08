// Vigência do vínculo estação ↔ parceiro — lógica pura, testável fora do
// navegador (mesmo padrão de colecao-diff.js e parceiro-regras.js).
//
// Um equipamento físico pode mudar de local e de parceiro: sai de um ponto,
// entra em outro, mantendo o mesmo ID Tupi. Sem vigência, apontar a estação
// para o novo parceiro arrastaria todo o histórico junto — as recargas
// antigas, que aconteceram no local do parceiro anterior, passariam a contar
// no repasse do novo. O fechamento de meses já pagos mudaria sozinho.
//
// Com vigência, cada recarga é atribuída ao cadastro que valia NA DATA dela.
// Dois cadastros de estação podem dividir o mesmo ID Tupi, cada um com sua
// janela e seu parceiro.
(function () {
  // Normaliza para 'YYYY-MM-DD'. Aceita ISO, 'YYYY-MM-DD HH:mm' e
  // 'DD/MM/YYYY' (formato usado nas recargas importadas).
  function soData(valor) {
    const s = String(valor || '').trim();
    if (!s) return '';
    const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return iso ? iso[1] : '';
  }

  // A janela é inclusiva nos dois extremos: uma estação com fim em 07/09
  // ainda responde pelas recargas do dia 07.
  function dentroDaVigencia(estacao, data) {
    const d = soData(data);
    const ini = soData(estacao && estacao.vigenciaInicio);
    const fim = soData(estacao && estacao.vigenciaFim);
    if (!ini && !fim) return true;            // cadastro sem janela vale sempre
    if (!d) return false;                     // sem data não dá para decidir
    if (ini && d < ini) return false;
    if (fim && d > fim) return false;
    return true;
  }

  function temVigencia(estacao) {
    return !!(estacao && (estacao.vigenciaInicio || estacao.vigenciaFim));
  }

  // Escolhe, entre os cadastros que compartilham um ID Tupi, o que vale na
  // data informada.
  //
  // Prioridade: janela que contém a data > cadastro sem janela > null.
  // Um cadastro sem janela é o caso comum (estação que nunca mudou de mãos) e
  // funciona como rede de segurança para recargas sem data legível — melhor
  // atribuir ao dono atual do que perder a recarga.
  function escolherPorData(lista, data) {
    const candidatos = (lista || []).filter(Boolean);
    if (!candidatos.length) return null;
    if (candidatos.length === 1) return candidatos[0];

    const comJanela = candidatos.filter(temVigencia);
    const semJanela = candidatos.filter(e => !temVigencia(e));

    const d = soData(data);
    if (d) {
      const casa = comJanela.find(e => dentroDaVigencia(e, d));
      if (casa) return casa;
    }
    if (semJanela.length) return semJanela[0];

    // Todas têm janela e nenhuma casa (data ausente ou fora de todas):
    // fica com a mais recente, que é o dono atual do equipamento.
    return comJanela
      .slice()
      .sort((a, b) => soData(a.vigenciaInicio).localeCompare(soData(b.vigenciaInicio)))
      .pop() || null;
  }

  // Índice idTupi → cadastros, para resolver sem varrer a lista toda a cada
  // recarga. O ID é normalizado só para dígitos, como no resto do sistema.
  function indexarPorIdTupi(estacoes) {
    const idx = new Map();
    (estacoes || []).forEach(e => {
      if (!e) return;
      const id = String(e.idTupi || '').replace(/\D/g, '');
      if (!id) return;
      if (!idx.has(id)) idx.set(id, []);
      idx.get(id).push(e);
    });
    return idx;
  }

  window.EVEstacaoVigencia = { soData, dentroDaVigencia, temVigencia, escolherPorData, indexarPorIdTupi };
})();
