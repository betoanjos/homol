// E-mails automáticos de aniversário — EV Parking
// Todo dia, no horário configurado, verifica os clientes com data de
// nascimento cadastrada e envia um e-mail HTML de parabéns com um botão
// "Resgatar recarga grátis" que abre o WhatsApp da rede com mensagem pronta.
//
// Variáveis de ambiente:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS  → servidor de e-mail
//   SMTP_SECURE=true|false (padrão: true se porta 465)
//   SMTP_FROM              → remetente (padrão: SMTP_USER)
//   WHATSAPP_NUMERO        → número com DDI, só dígitos (ex.: 5547999998888)
//   ANIVERSARIO_HORA       → hora local de envio, 0-23 (padrão: 9)
//
// O controle de envio fica na tabela aniversario_envios (1 envio por cliente/ano).

import pool from './db.js';

const TZ = 'America/Sao_Paulo';

function smtpConfig() {
  const host = process.env.SMTP_HOST || '';
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const from = process.env.SMTP_FROM || user;
  const secure = process.env.SMTP_SECURE != null
    ? String(process.env.SMTP_SECURE) === 'true'
    : port === 465;
  return { host, port, user, pass, from, secure };
}

export function aniversariosConfigurado() {
  const { host, user, pass } = smtpConfig();
  return Boolean(host && user && pass);
}

export async function initAniversariosDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS aniversario_envios (
      cliente_id TEXT NOT NULL,
      ano INTEGER NOT NULL,
      email TEXT,
      enviado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (cliente_id, ano)
    );
  `);
}

// Data local (São Paulo) como { dia, mes, ano }
function hojeLocal() {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(new Date());
  const get = t => Number(parts.find(p => p.type === t)?.value);
  return { dia: get('day'), mes: get('month'), ano: get('year') };
}

function horaLocal() {
  return Number(new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()));
}

// Aceita "YYYY-MM-DD" (input date) ou "DD/MM/YYYY"
function parseNascimento(str) {
  const s = String(str || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { dia: Number(m[3]), mes: Number(m[2]) };
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return { dia: Number(m[1]), mes: Number(m[2]) };
  return null;
}

function montarLinkWhatsApp(nomeCliente) {
  const numero = String(process.env.WHATSAPP_NUMERO || '').replace(/\D/g, '');
  if (!numero) return null;
  const hoje = hojeLocal();
  const dataTxt = `${String(hoje.dia).padStart(2, '0')}/${String(hoje.mes).padStart(2, '0')}/${hoje.ano}`;
  const msg = `Olá! Hoje é meu aniversário 🎂 (${dataTxt}) e recebi o e-mail da recarga grátis de presente. Meu nome é ${nomeCliente}. Como faço para resgatar?`;
  return `https://wa.me/${numero}?text=${encodeURIComponent(msg)}`;
}

function montarEmailHTML({ nome, nomeRede, linkWhats }) {
  const primeiroNome = String(nome || '').trim().split(/\s+/)[0] || 'Cliente';
  const botao = linkWhats
    ? `<a href="${linkWhats}" style="display:inline-block;background:#00e5a0;color:#04150f;font-weight:700;font-size:16px;padding:14px 28px;border-radius:10px;text-decoration:none">🎁 Resgatar minha recarga grátis</a>
       <p style="margin:14px 0 0;font-size:12px;color:#8a94a6">Válida somente hoje, no dia do seu aniversário. Ao clicar, você fala direto com a nossa equipe no WhatsApp.</p>`
    : `<p style="font-size:14px;color:#334">Entre em contato com a nossa equipe hoje para resgatar sua <strong>recarga grátis de aniversário</strong> — válida somente hoje!</p>`;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f2f5f9;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f5f9;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(20,40,60,0.08)">
        <tr><td style="background:#04150f;padding:26px 32px" align="center">
          <div style="font-size:26px">⚡🎉</div>
          <div style="color:#00e5a0;font-size:20px;font-weight:800;margin-top:6px">${nomeRede}</div>
        </td></tr>
        <tr><td style="padding:34px 36px" align="center">
          <h1 style="margin:0 0 8px;font-size:24px;color:#101820">Feliz aniversário, ${primeiroNome}! 🎂</h1>
          <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#4a5568">
            Hoje o dia é seu — e a energia é por nossa conta!<br>
            Preparamos um presente especial: <strong>uma recarga grátis</strong> para o seu veículo,
            válida <strong>somente hoje</strong>, em qualquer estação da nossa rede.
          </p>
          ${botao}
        </td></tr>
        <tr><td style="background:#f7fafc;padding:18px 32px;border-top:1px solid #e7ecf2" align="center">
          <p style="margin:0;font-size:11px;color:#8a94a6">Você recebeu este e-mail porque é cliente da ${nomeRede}.<br>Este benefício é pessoal, intransferível e válido apenas na data do seu aniversário.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function criarTransporter() {
  const nodemailer = (await import('nodemailer')).default;
  const { host, port, user, pass, secure } = smtpConfig();
  return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
}

async function enviarEmail({ para, nome, nomeRede }) {
  const transporter = await criarTransporter();
  const { from } = smtpConfig();
  const linkWhats = montarLinkWhatsApp(nome);
  await transporter.sendMail({
    from: `"${nomeRede}" <${from}>`,
    to: para,
    subject: `🎂 Feliz aniversário, ${String(nome || '').split(/\s+/)[0]}! Sua recarga grátis chegou`,
    html: montarEmailHTML({ nome, nomeRede, linkWhats })
  });
}

async function carregarClientes() {
  const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
  const data = r.rows[0]?.data || {};
  const nomeRede = data?.configuracoesRede?.nomeRede || 'EV Parking';
  return { clientes: Array.isArray(data.clientes) ? data.clientes : [], nomeRede };
}

// Verifica e envia os e-mails do dia. Retorna um resumo.
export async function processarAniversarios({ force = false } = {}) {
  if (!aniversariosConfigurado()) {
    return { ok: false, motivo: 'SMTP não configurado (defina SMTP_HOST, SMTP_USER e SMTP_PASS).' };
  }
  const hoje = hojeLocal();
  const { clientes, nomeRede } = await carregarClientes();
  const aniversariantes = clientes.filter(c => {
    if (!c?.email) return false;
    const n = parseNascimento(c.dataNascimento);
    return n && n.dia === hoje.dia && n.mes === hoje.mes;
  });

  const enviados = [];
  const pulados = [];
  const erros = [];
  for (const c of aniversariantes) {
    try {
      if (!force) {
        const ja = await pool.query(
          'SELECT 1 FROM aniversario_envios WHERE cliente_id = $1 AND ano = $2',
          [String(c.id), hoje.ano]
        );
        if (ja.rowCount) { pulados.push(c.email); continue; }
      }
      await enviarEmail({ para: c.email, nome: c.nome || c.email, nomeRede });
      await pool.query(
        `INSERT INTO aniversario_envios (cliente_id, ano, email) VALUES ($1, $2, $3)
         ON CONFLICT (cliente_id, ano) DO UPDATE SET email = EXCLUDED.email, enviado_em = NOW()`,
        [String(c.id), hoje.ano, c.email]
      );
      enviados.push(c.email);
    } catch (err) {
      console.error(`Aniversário: falha ao enviar para ${c.email}:`, err.message);
      erros.push({ email: c.email, erro: err.message });
    }
  }
  return { ok: true, data: `${hoje.dia}/${hoje.mes}/${hoje.ano}`, aniversariantes: aniversariantes.length, enviados, pulados, erros };
}

// Envio de teste para validar o SMTP e o layout do e-mail.
export async function enviarTesteAniversario(emailDestino, nome = 'Cliente Teste') {
  if (!aniversariosConfigurado()) throw new Error('SMTP não configurado (defina SMTP_HOST, SMTP_USER e SMTP_PASS).');
  const { nomeRede } = await carregarClientes();
  await enviarEmail({ para: emailDestino, nome, nomeRede });
  return { ok: true, para: emailDestino };
}

export async function statusAniversarios() {
  const hoje = hojeLocal();
  const { clientes } = await carregarClientes();
  const comNascimento = clientes.filter(c => parseNascimento(c.dataNascimento)).length;
  const hojeAniv = clientes.filter(c => {
    const n = parseNascimento(c.dataNascimento);
    return n && n.dia === hoje.dia && n.mes === hoje.mes;
  }).length;
  const envios = await pool.query(
    'SELECT COUNT(*)::int AS n FROM aniversario_envios WHERE ano = $1', [hoje.ano]
  );
  return {
    smtpConfigurado: aniversariosConfigurado(),
    whatsappConfigurado: Boolean(String(process.env.WHATSAPP_NUMERO || '').replace(/\D/g, '')),
    horaEnvio: Number(process.env.ANIVERSARIO_HORA || 9),
    clientesComNascimento: comNascimento,
    aniversariantesHoje: hojeAniv,
    enviadosEsteAno: envios.rows[0]?.n || 0
  };
}

export function iniciarAgendadorAniversarios() {
  if (!aniversariosConfigurado()) {
    console.warn('Agendador de aniversários não iniciado: SMTP não configurado.');
    return;
  }
  const horaAlvo = Math.min(23, Math.max(0, Number(process.env.ANIVERSARIO_HORA || 9)));
  // Checagem horária: dispara quando a hora local >= hora alvo.
  // A tabela aniversario_envios garante que cada cliente recebe 1 e-mail por ano.
  const tick = () => {
    if (horaLocal() < horaAlvo) return;
    processarAniversarios().then(r => {
      if (r.ok && (r.enviados?.length || r.erros?.length)) {
        console.log(`Aniversários: ${r.enviados.length} enviado(s), ${r.erros.length} erro(s).`);
      }
    }).catch(err => console.error('Erro no agendador de aniversários:', err.message));
  };
  setTimeout(tick, 30000); // primeira checagem logo após o boot
  setInterval(tick, 60 * 60 * 1000);
  console.log(`Agendador de aniversários ativo (envio a partir das ${horaAlvo}h, horário de São Paulo).`);
}
