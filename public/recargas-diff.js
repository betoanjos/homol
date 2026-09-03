// Diferença entre as recargas em memória e as que vieram do servidor.
//
// As recargas são alteradas in-place em dezenas de pontos da lógica de
// faturamento (classificação por cliente, carimbo de faturaId, correção
// manual, exclusão, cálculo de tarifa...). Rastrear cada um desses pontos
// para persistir registro a registro seria frágil: esquecer um significa
// alteração que some sem aviso — em faturamento.
//
// Em vez disso, comparamos o estado atual com o retrato recebido do servidor
// e deixamos o diff descobrir o que mudou. Nenhum ponto de mutação precisa
// saber que existe persistência.
(function () {
  // Retrato para comparação: uid -> JSON do registro.
  // JSON.stringify preserva a ordem de inserção das chaves, e os objetos são
  // sempre construídos pelos mesmos caminhos de código, então a comparação é
  // estável na prática. Um falso positivo custa reenviar um registro; um
  // falso negativo perderia a alteração — por isso a comparação é textual e
  // não campo a campo.
  function criarRetrato(lista) {
    const mapa = new Map();
    (lista || []).forEach(r => {
      if (!r || r.uid == null || String(r.uid) === '') return;
      mapa.set(String(r.uid), JSON.stringify(r));
    });
    return mapa;
  }

  // Compara e devolve { alteradas, removidas, semUid }.
  //   alteradas — novas ou modificadas desde o retrato
  //   removidas — estavam no retrato e sumiram da lista
  //   semUid    — registros sem uid, que não podem ser persistidos por chave
  function calcularDiff(retrato, lista) {
    const anterior = retrato instanceof Map ? retrato : new Map();
    const alteradas = [];
    const semUid = [];
    const vistos = new Set();

    (lista || []).forEach(r => {
      if (!r) return;
      const uid = r.uid == null ? '' : String(r.uid);
      if (!uid) { semUid.push(r); return; }
      vistos.add(uid);
      const serializado = JSON.stringify(r);
      if (anterior.get(uid) !== serializado) alteradas.push(r);
    });

    const removidas = [];
    anterior.forEach((_, uid) => { if (!vistos.has(uid)) removidas.push(uid); });

    return { alteradas, removidas, semUid };
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
  function confirmarNoRetrato(retrato, alteradas, removidas) {
    (alteradas || []).forEach(r => {
      if (!r || r.uid == null || String(r.uid) === '') return;
      retrato.set(String(r.uid), JSON.stringify(r));
    });
    (removidas || []).forEach(uid => retrato.delete(String(uid)));
    return retrato;
  }

  window.EVRecargasDiff = { criarRetrato, calcularDiff, emLotes, confirmarNoRetrato };
})();
