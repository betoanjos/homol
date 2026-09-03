// Guarda de sanidade do estado — lógica pura, sem banco, para ser testável
// isoladamente (mesmo padrão de contratos/validacao.js).

// Coleções de negócio protegidas contra apagamento acidental.
export const COLECOES = ['clientes', 'faturas', 'recargas', 'parceiros', 'estacoes', 'contasReceber', 'recebiveisManuais', 'fluxoCaixa'];

// Encolhimento máximo tolerado sem confirmação: perder mais que esta fração
// dos itens de uma coleção é quase sempre bug de cliente, não intenção.
export const ENCOLHIMENTO_MAX = Number(process.env.STATE_SHRINK_MAX || 0.3);

const tamanho = v => (Array.isArray(v) ? v.length : 0);

// Compara o estado novo com o atual e lista as coleções que perderiam itens
// além do tolerado. Coleção ausente no payload conta como perda total: o
// cliente sempre envia o estado completo, então a omissão é sinal de bug.
export function avaliarPerdas(atual = {}, novo = {}) {
  const perdas = [];
  for (const chave of COLECOES) {
    const antes = tamanho(atual[chave]);
    if (antes === 0) continue;
    const ausente = !(chave in novo) || novo[chave] == null;
    const depois = ausente ? 0 : tamanho(novo[chave]);
    const removidos = antes - depois;
    if (removidos <= 0) continue;
    // Tolerância mínima de 1 item cobre a exclusão avulsa em listas pequenas.
    const limite = Math.max(1, Math.floor(antes * ENCOLHIMENTO_MAX));
    if (removidos > limite) perdas.push({ colecao: chave, antes, depois, removidos, limite, ausente });
  }
  return perdas;
}
