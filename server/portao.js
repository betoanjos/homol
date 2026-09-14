// ═══════════════════════════════════════════════════════════════════════════
//  LIBERAÇÃO DA GRADE DE PROTEÇÃO DA ESTAÇÃO
//
//  Os cabos e conectores da estação de Curitiba foram furtados. A proteção é
//  uma grade em volta do equipamento (não da vaga — o carro fica fora), que
//  fica trancada quando ninguém está carregando.
//
//  O posto funciona das 6h às 23h30, então de dia há gente para abrir. O
//  problema é a madrugada e o domingo, quando o posto fecha o dia inteiro e
//  hoje se perde o cliente por não ter quem atenda.
//
//  Fluxo: o motorista toca no QR da grade, o WhatsApp abre com o texto já
//  digitado e ele aperta enviar. A plataforma de mensagens chama o endpoint
//  do EV Core, que registra a liberação. O controlador no portão consulta a
//  cada poucos segundos e aciona o trinco.
//
//  A mensagem parte do usuário de propósito: não exige template aprovado pela
//  Meta, não custa por envio, não depende de entrega rápida às 3 da manhã, e
//  o número chega verificado — veio da conta real dele.
//
//  Por que o gatilho não é a recarga: verificado sobre 1750 sessões, a API da
//  Tupi só publica sessão depois de encerrada. Não existe "carregando" para
//  observar, então o início da recarga não serve para abrir nada.
//
//  Configuração (Variables do Railway):
//    PORTAO_WEBHOOK_SECRET  → segredo que a plataforma de mensagens envia
//    PORTAO_TOKEN           → segredo do controlador no portão
//    PORTAO_PALAVRA         → palavra que libera (padrão: "abrir")
//    PORTAO_JANELA_SEG      → validade da liberação (padrão: 90s)
//    PORTAO_LIMITE_HORA     → máximo de aberturas por telefone/hora (padrão: 6)
//    PORTAO_EXIGIR_FOTO     → 'true' exige a foto da placa para liberar
// ═══════════════════════════════════════════════════════════════════════════
import crypto from 'crypto';
import pool from './db.js';
import { PALAVRA_PADRAO } from './portaoMensagem.js';
import { segredoConfere } from './segredo.js';

export { segredoConfere };

export function portaoConfig() {
  return {
    webhookSecret: process.env.PORTAO_WEBHOOK_SECRET || '',
    token: process.env.PORTAO_TOKEN || '',
    palavra: process.env.PORTAO_PALAVRA || PALAVRA_PADRAO,
    janelaSeg: Math.max(10, Number(process.env.PORTAO_JANELA_SEG || 90)),
    limiteHora: Math.max(1, Number(process.env.PORTAO_LIMITE_HORA || 6)),
    // Exigir a foto da placa para liberar. Começa desligado de propósito: se a
    // plataforma não estiver passando a URL da imagem, ligar isso de cara
    // deixaria o motorista trancado do lado de fora às 3 da manhã. Ligue
    // depois de confirmar, no histórico, que a foto está chegando.
    exigirMidia: String(process.env.PORTAO_EXIGIR_FOTO || '') === 'true'
  };
}

export function portaoConfigurado(cfg = portaoConfig()) {
  return Boolean(cfg.webhookSecret && cfg.token);
}

export async function initPortaoDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portao_liberacoes (
      id SERIAL PRIMARY KEY,
      telefone TEXT,
      telefone_mascarado TEXT,
      origem TEXT NOT NULL DEFAULT 'whatsapp',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      expira_em TIMESTAMPTZ NOT NULL,
      consumido_em TIMESTAMPTZ,
      observacao TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_portao_pendente ON portao_liberacoes (consumido_em, expira_em);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_portao_criado ON portao_liberacoes (criado_em DESC);`);
  // Foto da placa enviada antes da liberação. Coluna adicionada depois da
  // criação original da tabela.
  await pool.query(`ALTER TABLE portao_liberacoes ADD COLUMN IF NOT EXISTS midia_url TEXT;`);
  // Estação a que a liberação se refere. Nulo = portão padrão, o configurado
  // por variável de ambiente antes de existir roteamento por estação.
  await pool.query(`ALTER TABLE portao_liberacoes ADD COLUMN IF NOT EXISTS estacao_id TEXT;`);
  await pool.query(`ALTER TABLE portao_liberacoes ADD COLUMN IF NOT EXISTS estacao_nome TEXT;`);
}

// Quantas aberturas esse telefone pediu na última hora. Evita que alguém fique
// acionando o trinco repetidamente, e limita o estrago de um QR vazado.
export async function aberturasNaUltimaHora(telefone) {
  if (!telefone) return 0;
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM portao_liberacoes
      WHERE telefone = $1 AND criado_em > now() - INTERVAL '1 hour'`,
    [telefone]
  );
  return r.rows[0]?.n || 0;
}

// A URL da foto já foi usada em alguma liberação anterior?
//
// A plataforma de mensagens guarda a última foto no cadastro do contato. Se a
// pessoa responder com texto em vez de imagem, o campo não é atualizado e a
// automação reenvia a foto da vez passada — e o servidor recebe um endereço
// perfeitamente válido, indistinguível de uma foto nova. Foi assim que uma
// resposta "wedf" abriu a grade em teste.
//
// Rastro repetido não é rastro: se a foto não é desta abertura, é como se não
// houvesse foto.
export async function midiaJaUsada(midiaUrl) {
  if (!midiaUrl) return false;
  const r = await pool.query(
    'SELECT 1 FROM portao_liberacoes WHERE midia_url = $1 LIMIT 1',
    [midiaUrl]
  );
  return r.rowCount > 0;
}

export async function registrarLiberacao({ telefone, telefoneMascarado, origem = 'whatsapp', observacao = null, midiaUrl = null, estacaoId = null, estacaoNome = null }) {
  const { janelaSeg } = portaoConfig();
  const r = await pool.query(
    `INSERT INTO portao_liberacoes (telefone, telefone_mascarado, origem, expira_em, observacao, midia_url, estacao_id, estacao_nome)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval, $5, $6, $7, $8)
     RETURNING id, criado_em, expira_em`,
    [telefone || null, telefoneMascarado || null, origem, String(janelaSeg), observacao, midiaUrl || null, estacaoId || null, estacaoNome || null]
  );
  return r.rows[0];
}

// O controlador consulta e consome. A liberação é de uso único e expira
// sozinha: se ninguém buscar dentro da janela, o trinco não é acionado depois.
// O UPDATE ... RETURNING marca e devolve numa única instrução, então duas
// consultas simultâneas não acionam o trinco duas vezes.
// Cada controlador consulta apenas a fila da SUA estação. Sem esse filtro,
// com duas estações, uma mensagem em Curitiba faria o trinco de Mafra abrir —
// o primeiro controlador a consultar levaria a liberação.
//
// estacaoId nulo = portão padrão (o configurado por variável de ambiente,
// antes de existir roteamento por estação).
export async function consumirPendente(estacaoId = null) {
  const r = await pool.query(
    `UPDATE portao_liberacoes
        SET consumido_em = now()
      WHERE id = (
        SELECT id FROM portao_liberacoes
         WHERE consumido_em IS NULL AND expira_em > now()
           AND estacao_id IS NOT DISTINCT FROM $1
         ORDER BY criado_em
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, telefone_mascarado, criado_em, estacao_nome`,
    [estacaoId]
  );
  return r.rows[0] || null;
}

// Segredo do controlador de cada estação, derivado do PORTAO_TOKEN.
//
// Derivar em vez de cadastrar evita guardar mais um segredo — e evita
// guardá-lo no app_state, que qualquer usuário logado consegue ler. Cada
// controlador recebe um valor distinto, então um token vazado abre apenas
// aquela estação. Trocar o PORTAO_TOKEN rotaciona todos de uma vez.
export function tokenDaEstacao(estacaoId, cfg = portaoConfig()) {
  if (!cfg.token) return '';
  if (!estacaoId) return cfg.token;   // portão padrão usa o token raiz
  return crypto.createHmac('sha256', cfg.token).update(String(estacaoId)).digest('base64url');
}

// Devolve o telefone completo. Quem decide se ele chega ao usuário é a rota:
// o número inteiro é o que fecha o rastro numa ocorrência, mas não precisa
// ficar à vista de todo perfil que abre o painel.
export async function listarEventos(limite = 50) {
  const r = await pool.query(
    `SELECT id, telefone, telefone_mascarado, origem, criado_em, expira_em, consumido_em, observacao, midia_url, estacao_id, estacao_nome
       FROM portao_liberacoes
      ORDER BY criado_em DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limite) || 50, 1), 500)]
  );
  return r.rows;
}
