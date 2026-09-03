// ═══════════════════════════════════════════════════════════════════════════
//  ESTADO DA APLICAÇÃO (app_state)
//  Dono único da tabela app_state. Nenhum outro módulo deve fazer
//  UPDATE app_state diretamente — use salvarEstado() ou mutarEstado().
//
//  O estado de negócio (clientes, faturas, recargas, parceiros, estações,
//  financeiro) ainda vive num único documento JSONB. Enquanto a normalização
//  em tabelas não acontece, este módulo resolve os três riscos reais do blob:
//
//    1. Lost update  — duas abas/usuários salvando ao mesmo tempo faziam o
//       último gravador apagar o trabalho do outro. Agora há trava otimista
//       por versão: quem gravar em cima de uma versão velha recebe 409.
//    2. Zeramento    — o servidor aceitava qualquer corpo, inclusive {}.
//       Agora um payload que apaga ou encolhe demais uma coleção existente é
//       recusado, salvo confirmação explícita.
//    3. Irreversível — cada versão anterior é arquivada em app_state_history,
//       então dá para inspecionar e restaurar sem depender do backup de 6h.
// ═══════════════════════════════════════════════════════════════════════════
import pool from './db.js';
import { avaliarPerdas } from './estadoValidacao.js';

export { avaliarPerdas };

// Quantas versões anteriores manter em app_state_history.
const HISTORICO_MANTER = Number(process.env.STATE_HISTORY_KEEP || 200);

export class ConflitoDeVersao extends Error {
  constructor(versaoAtual, estadoAtual) {
    super('O estado foi alterado por outra sessão desde que esta página carregou.');
    this.name = 'ConflitoDeVersao';
    this.status = 409;
    this.versaoAtual = versaoAtual;
    this.estadoAtual = estadoAtual;
  }
}

export class EstadoSuspeito extends Error {
  constructor(perdas) {
    super('A gravação foi recusada porque apagaria dados existentes.');
    this.name = 'EstadoSuspeito';
    this.status = 422;
    this.perdas = perdas;
  }
}

export async function initEstadoDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  // Colunas adicionadas depois da criação original da tabela.
  await pool.query(`ALTER TABLE app_state ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;`);
  await pool.query(`ALTER TABLE app_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
  await pool.query(`ALTER TABLE app_state ADD COLUMN IF NOT EXISTS updated_by TEXT;`);

  await pool.query(`
    INSERT INTO app_state (id, data)
    VALUES (1, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state_history (
      version BIGINT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      motivo TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS app_state_history_updated_at_idx ON app_state_history (updated_at DESC);`);
}

// ─── Leitura ────────────────────────────────────────────────────────────────

// Retorna { data, version, updatedAt, updatedBy }.
export async function lerEstado() {
  const r = await pool.query('SELECT data, version, updated_at, updated_by FROM app_state WHERE id = 1');
  const row = r.rows[0];
  return {
    data: row?.data || {},
    version: Number(row?.version || 0),
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || null
  };
}

// Atalho para quem só precisa do conteúdo (backup, contratos, aniversários).
export async function lerEstadoData() {
  return (await lerEstado()).data;
}

async function arquivar(client, { version, data, updatedAt, updatedBy }, motivo) {
  if (!version) return;
  await client.query(
    `INSERT INTO app_state_history (version, data, updated_at, updated_by, motivo)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (version) DO NOTHING`,
    [version, data, updatedAt || new Date(), updatedBy, motivo]
  );
  await client.query(
    `DELETE FROM app_state_history
      WHERE version <= (
        SELECT version FROM app_state_history ORDER BY version DESC OFFSET $1 LIMIT 1
      )`,
    [HISTORICO_MANTER]
  );
}

// ─── Gravação ───────────────────────────────────────────────────────────────

// Grava o estado completo enviado pelo cliente.
//   baseVersion — versão que o cliente leu. null pula a trava otimista
//                 (só para chamadas internas que já leram sob transação).
//   forcar      — ignora a guarda de sanidade (confirmação explícita do usuário).
// Retorna { version, updatedAt }. Lança ConflitoDeVersao ou EstadoSuspeito.
export async function salvarEstado(novo, { baseVersion = null, usuario = null, motivo = 'api', forcar = false } = {}) {
  if (!novo || typeof novo !== 'object' || Array.isArray(novo)) {
    throw Object.assign(new Error('Estado inválido: esperado um objeto.'), { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE serializa gravações concorrentes: a segunda espera a primeira
    // e só então compara a versão, então o conflito é sempre detectado.
    const r = await client.query('SELECT data, version, updated_at, updated_by FROM app_state WHERE id = 1 FOR UPDATE');
    const atual = {
      data: r.rows[0]?.data || {},
      version: Number(r.rows[0]?.version || 0),
      updatedAt: r.rows[0]?.updated_at || null,
      updatedBy: r.rows[0]?.updated_by || null
    };

    if (baseVersion != null && Number(baseVersion) !== atual.version) {
      await client.query('ROLLBACK');
      throw new ConflitoDeVersao(atual.version, atual.data);
    }

    if (!forcar) {
      const perdas = avaliarPerdas(atual.data, novo);
      if (perdas.length) {
        await client.query('ROLLBACK');
        throw new EstadoSuspeito(perdas);
      }
    }

    await arquivar(client, atual, motivo);

    const prox = atual.version + 1;
    const upd = await client.query(
      `UPDATE app_state SET data = $1, version = $2, updated_at = now(), updated_by = $3
        WHERE id = 1 RETURNING version, updated_at`,
      [novo, prox, usuario]
    );
    await client.query('COMMIT');
    return { version: Number(upd.rows[0].version), updatedAt: upd.rows[0].updated_at };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Read-modify-write atômico para mutações do próprio servidor (webhook de
// pagamento, jobs). alterar(data) recebe o estado sob lock e devolve o novo
// estado, ou null/undefined para não gravar nada.
export async function mutarEstado(alterar, { usuario = 'sistema', motivo = 'interno' } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT data, version, updated_at, updated_by FROM app_state WHERE id = 1 FOR UPDATE');
    const atual = {
      data: r.rows[0]?.data || {},
      version: Number(r.rows[0]?.version || 0),
      updatedAt: r.rows[0]?.updated_at || null,
      updatedBy: r.rows[0]?.updated_by || null
    };

    const novo = await alterar(atual.data);
    if (!novo) {
      await client.query('ROLLBACK');
      return { alterado: false, version: atual.version };
    }

    await arquivar(client, atual, motivo);
    const prox = atual.version + 1;
    await client.query(
      `UPDATE app_state SET data = $1, version = $2, updated_at = now(), updated_by = $3 WHERE id = 1`,
      [novo, prox, usuario]
    );
    await client.query('COMMIT');
    return { alterado: true, version: prox };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── Histórico ──────────────────────────────────────────────────────────────

export async function listarHistorico(limite = 50) {
  const r = await pool.query(
    `SELECT version, updated_at, updated_by, motivo,
            jsonb_array_length(COALESCE(data->'clientes', '[]'::jsonb)) AS clientes,
            jsonb_array_length(COALESCE(data->'faturas',  '[]'::jsonb)) AS faturas,
            jsonb_array_length(COALESCE(data->'recargas', '[]'::jsonb)) AS recargas
       FROM app_state_history ORDER BY version DESC LIMIT $1`,
    [Math.min(Number(limite) || 50, 200)]
  );
  return r.rows.map(row => ({
    version: Number(row.version),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    motivo: row.motivo,
    totais: { clientes: row.clientes, faturas: row.faturas, recargas: row.recargas }
  }));
}

export async function lerVersaoHistorico(version) {
  const r = await pool.query('SELECT version, data, updated_at, updated_by, motivo FROM app_state_history WHERE version = $1', [Number(version)]);
  if (!r.rows[0]) return null;
  return { version: Number(r.rows[0].version), data: r.rows[0].data, updatedAt: r.rows[0].updated_at, updatedBy: r.rows[0].updated_by, motivo: r.rows[0].motivo };
}

// Restaura uma versão arquivada. A versão atual vai para o histórico antes,
// então restaurar também é reversível. Pula a guarda de sanidade: reverter
// para um estado menor é justamente o objetivo aqui.
export async function restaurarVersao(version, { usuario = null } = {}) {
  const alvo = await lerVersaoHistorico(version);
  if (!alvo) throw Object.assign(new Error('Versão não encontrada no histórico.'), { status: 404 });
  const r = await mutarEstado(() => alvo.data, { usuario, motivo: `restauracao-da-versao-${version}` });
  return { ...r, restauradaDe: Number(version) };
}
