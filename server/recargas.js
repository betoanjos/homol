// ═══════════════════════════════════════════════════════════════════════════
//  RECARGAS EM TABELA PRÓPRIA
//
//  As recargas viviam dentro do documento JSONB do app_state. Como a lista só
//  cresce e o painel reenviava o estado inteiro a cada edição, o corpo do
//  POST /api/state caminhava para o limite de 2 MB do parser — e ao bater
//  nesse teto toda gravação passaria a falhar de uma vez, não aos poucos.
//
//  Aqui elas ganham tabela própria. O painel continua lendo a lista completa
//  pelo /api/state (a leitura não tem limite de tamanho e nada no front muda),
//  mas a gravação passa a mandar apenas as recargas que realmente mudaram.
//
//  Cada registro é guardado como JSONB inteiro, e não em colunas: os campos
//  de recarga são criados livremente pela lógica de faturamento (dezenas
//  deles, entre importados e derivados) e mudam com frequência. Colunas
//  fixas exigiriam migração a cada campo novo e é o passo seguinte, quando o
//  formato estabilizar. A chave é o `uid`, que já é a chave de deduplicação
//  usada entre a API Tupi e o CSV.
// ═══════════════════════════════════════════════════════════════════════════
import pool from './db.js';
import { lerEstado, mutarEstado } from './estado.js';

export async function initRecargasDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recargas (
      uid TEXT PRIMARY KEY,
      dados JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_por TEXT
    );
  `);
  // A tela de relatórios e o faturamento filtram por data e por fatura.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recargas_data ON recargas ((dados->>'data'));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recargas_fatura ON recargas ((dados->>'faturaId'));`);
}

export async function contarRecargas() {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM recargas');
  return r.rows[0]?.n || 0;
}

// Lista completa, no formato que o painel já espera.
export async function listarRecargas() {
  const r = await pool.query(`SELECT dados FROM recargas ORDER BY dados->>'data' DESC NULLS LAST`);
  return r.rows.map(row => row.dados);
}

// Grava (insere ou atualiza) um lote. O array inteiro vai como um único
// parâmetro JSONB — evita montar centenas de placeholders e esbarrar no
// limite de parâmetros do Postgres.
export async function salvarRecargas(lista = [], { usuario = null } = {}) {
  const validas = (Array.isArray(lista) ? lista : []).filter(r => r && r.uid != null && String(r.uid) !== '');
  if (!validas.length) return 0;

  // Um mesmo uid repetido no lote faria o ON CONFLICT tentar alterar a mesma
  // linha duas vezes na mesma instrução, o que o Postgres recusa. Mantemos a
  // última ocorrência, que é a mais recente em memória.
  const unicas = [...new Map(validas.map(r => [String(r.uid), r])).values()];

  const r = await pool.query(
    // O alias precisa nomear a COLUNA (t(rec)), não só a tabela: com "AS t"
    // um "t" solto no SELECT seria o registro composto, e o operador ->> não
    // se aplica a record.
    `INSERT INTO recargas (uid, dados, atualizado_em, atualizado_por)
     SELECT rec->>'uid', rec, now(), $2
       FROM jsonb_array_elements($1::jsonb) AS t(rec)
      WHERE rec->>'uid' IS NOT NULL AND rec->>'uid' <> ''
     ON CONFLICT (uid) DO UPDATE
        SET dados = EXCLUDED.dados,
            atualizado_em = now(),
            atualizado_por = EXCLUDED.atualizado_por`,
    [JSON.stringify(unicas), usuario]
  );
  return r.rowCount;
}

export async function excluirRecargas(uids = []) {
  const lista = (Array.isArray(uids) ? uids : []).map(String).filter(Boolean);
  if (!lista.length) return 0;
  const r = await pool.query('DELETE FROM recargas WHERE uid = ANY($1::text[])', [lista]);
  return r.rowCount;
}

// Move as recargas que ainda estiverem dentro do app_state para a tabela e
// remove a chave do documento. Idempotente: a gravação usa ON CONFLICT e a
// limpeza do estado só acontece depois; se o processo cair no meio, o boot
// seguinte repete sem duplicar nada.
export async function migrarRecargasDoEstado() {
  const { data } = await lerEstado();
  const doEstado = data?.recargas;
  if (!Array.isArray(doEstado) || !doEstado.length) return { migradas: 0 };

  const gravadas = await salvarRecargas(doEstado, { usuario: 'migracao' });

  await mutarEstado(estado => {
    if (!Array.isArray(estado.recargas)) return null;
    delete estado.recargas;
    return estado;
  }, { usuario: 'migracao', motivo: 'recargas-para-tabela-propria' });

  console.log(`Migração: ${gravadas} recargas movidas do app_state para a tabela própria.`);
  return { migradas: gravadas };
}
