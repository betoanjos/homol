// ═══════════════════════════════════════════════════════════════════════════
//  FATURAS EM TABELA PRÓPRIA
//
//  Mesmo motivo das recargas: a coleção só cresce e o painel reenviava o
//  documento inteiro a cada edição. As faturas pesam ainda mais por registro,
//  porque cada uma embute as recargas que a compõem e o QR Code Pix em base64.
//
//  A chave é o `id` ('fat_...'), gerado no painel na criação da fatura.
// ═══════════════════════════════════════════════════════════════════════════
import pool from './db.js';
import { lerEstado, mutarEstado } from './estado.js';
import { faturaCorrespondeAoPagamento } from './faturasPagamento.js';

export { faturaCorrespondeAoPagamento };

export async function initFaturasDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faturas (
      id TEXT PRIMARY KEY,
      dados JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_por TEXT
    );
  `);
  // O webhook procura a fatura pelo pagamento; as telas filtram por competência.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_faturas_pix ON faturas ((dados->>'pixPaymentId'));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_faturas_competencia ON faturas ((dados->>'competencia'));`);
}

export async function contarFaturas() {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM faturas');
  return r.rows[0]?.n || 0;
}

export async function listarFaturas() {
  const r = await pool.query(`SELECT dados FROM faturas ORDER BY dados->>'emitidaEm' DESC NULLS LAST`);
  return r.rows.map(row => row.dados);
}

export async function salvarFaturas(lista = [], { usuario = null } = {}) {
  const validas = (Array.isArray(lista) ? lista : []).filter(f => f && f.id != null && String(f.id) !== '');
  if (!validas.length) return 0;

  // Um mesmo id repetido no lote faria o ON CONFLICT tentar alterar a mesma
  // linha duas vezes na mesma instrução, o que o Postgres recusa.
  const unicas = [...new Map(validas.map(f => [String(f.id), f])).values()];

  const r = await pool.query(
    // O alias precisa nomear a COLUNA (t(reg)): com apenas "AS t", um "t" solto
    // seria o registro composto e o operador ->> não se aplica a record.
    `INSERT INTO faturas (id, dados, atualizado_em, atualizado_por)
     SELECT reg->>'id', reg, now(), $2
       FROM jsonb_array_elements($1::jsonb) AS t(reg)
      WHERE reg->>'id' IS NOT NULL AND reg->>'id' <> ''
     ON CONFLICT (id) DO UPDATE
        SET dados = EXCLUDED.dados,
            atualizado_em = now(),
            atualizado_por = EXCLUDED.atualizado_por`,
    [JSON.stringify(unicas), usuario]
  );
  return r.rowCount;
}

export async function excluirFaturas(ids = []) {
  const lista = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!lista.length) return 0;
  const r = await pool.query('DELETE FROM faturas WHERE id = ANY($1::text[])', [lista]);
  return r.rowCount;
}

// Marca como paga a fatura correspondente ao pagamento. Roda no webhook do
// Mercado Pago, que antes fazia read-modify-write no app_state.
export async function marcarFaturaPaga(paymentId, status = {}) {
  const todas = await listarFaturas();
  const alvos = todas.filter(f => faturaCorrespondeAoPagamento(f, paymentId, status.externalReference));
  if (!alvos.length) return { alterado: false, faturas: [] };

  const atualizadas = alvos.map(f => ({
    ...f,
    status: 'pago',
    pago: true,
    paid: true,
    pixStatus: 'APPROVED',
    dataPagamento: status.dateApproved || new Date().toISOString()
  }));

  await salvarFaturas(atualizadas, { usuario: 'webhook-mercadopago' });
  return { alterado: true, faturas: atualizadas.map(f => f.id) };
}

// Move as faturas que ainda estiverem no app_state para a tabela. Idempotente,
// pelo mesmo desenho usado nas recargas: grava antes, limpa o documento depois.
export async function migrarFaturasDoEstado() {
  const { data } = await lerEstado();
  const doEstado = data?.faturas;
  if (!Array.isArray(doEstado) || !doEstado.length) return { migradas: 0 };

  const gravadas = await salvarFaturas(doEstado, { usuario: 'migracao' });

  await mutarEstado(estado => {
    if (!Array.isArray(estado.faturas)) return null;
    delete estado.faturas;
    return estado;
  }, { usuario: 'migracao', motivo: 'faturas-para-tabela-propria' });

  console.log(`Migração: ${gravadas} faturas movidas do app_state para a tabela própria.`);
  return { migradas: gravadas };
}
