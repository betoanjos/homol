// Diferença entre uma coleção em memória e a que veio do servidor.
//
// Usado por recargas (chave `uid`) e faturas (chave `id`) — as duas coleções
// que saíram do documento de estado por só crescerem.
//
// Os registros são alterados in-place em dezenas de pontos da lógica de
// faturamento (classificação por cliente, carimbo de faturaId, baixa de Pix,
// cancelamento, estorno, correção manual...). Rastrear cada um desses pontos
// para persistir registro a registro seria frágil: esquecer um significa
// alteração que some sem aviso — em faturamento.
//
// Em vez disso, comparamos o estado atual com o retrato recebido do servidor
// e deixamos o diff descobrir o que mudou. Nenhum ponto de mutação precisa
// saber que existe persistência.
(function () {
  // Retrato para comparação: chave -> JSON do registro.
  // JSON.stringify preserva a ordem de inserção das chaves, e os objetos são
  // sempre construídos pelos mesmos caminhos de código, então a comparação é
  // estável na prática. Um falso positivo custa reenviar um registro; um
  // falso negativo perderia a alteração — por isso a comparação é textual e
  // não campo a campo.
  function criarRetrato(lista, chave) {
    const k = chave || 'uid';
    const mapa = new Map();
    (lista || []).forEach(r => {
      if (!r || r[k] == null || String(r[k]) === '') return;
      mapa.set(String(r[k]), JSON.stringify(r));
    });
    return mapa;
  }

  // Compara e devolve { alteradas, removidas, semChave }.
  //   alteradas — novas ou modificadas desde o retrato
  //   removidas — estavam no retrato e sumiram da lista
  //   semChave  — registros sem chave, que não podem ser persistidos
  function calcularDiff(retrato, lista, chave) {
    const k = chave || 'uid';
    const anterior = retrato instanceof Map ? retrato : new Map();
    const alteradas = [];
    const semChave = [];
    const vistos = new Set();

    (lista || []).forEach(r => {
      if (!r) return;
      const id = r[k] == null ? '' : String(r[k]);
      if (!id) { semChave.push(r); return; }
      vistos.add(id);
      const serializado = JSON.stringify(r);
      if (anterior.get(id) !== serializado) alteradas.push(r);
    });

    const removidas = [];
    anterior.forEach((_, id) => { if (!vistos.has(id)) removidas.push(id); });

    return { alteradas, removidas, semChave };
  }

  // Divide em lotes para que nenhuma requisição fique perto do limite do
  // parser — o problema que motivou toda esta mudança.
  function emLotes(itens, tamanho) {
    const lotes = [];
    const n = Math.max(1, tamanho || 300);
    for (let i = 0; i < (itens || []).length; i += n) lotes.push(itens.slice(i, i + n));
    return lotes;
  }

  // Aplica ao retrato o que foi confirmado pelo servidor, para que a próxima
  // comparação parta do que está de fato gravado. Só é chamado após sucesso.
  function confirmarNoRetrato(retrato, alteradas, removidas, chave) {
    const k = chave || 'uid';
    (alteradas || []).forEach(r => {
      if (!r || r[k] == null || String(r[k]) === '') return;
      retrato.set(String(r[k]), JSON.stringify(r));
    });
    (removidas || []).forEach(id => retrato.delete(String(id)));
    return retrato;
  }

  window.EVColecaoDiff = { criarRetrato, calcularDiff, emLotes, confirmarNoRetrato };
})();
