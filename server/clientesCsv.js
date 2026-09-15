// Exportação da base de clientes em CSV — lógica pura, sem banco, para ser
// testável isoladamente (mesmo padrão de contratos/validacao.js).
//
// Serve para importar a base em ferramenta de campanha (Brevo), onde o envio
// promocional deve acontecer — e não pelo caminho transacional do sistema, que
// é o mesmo do código 2FA e do alerta de login. Disparar centenas de e-mails
// promocionais por ali estraga a reputação do remetente e depois o código de
// acesso deixa de chegar na caixa de entrada.

// Validação deliberadamente frouxa: o objetivo é descartar lixo evidente
// (vazio, sem @, sem domínio), não julgar endereço exótico. Um endereço válido
// recusado aqui vira cliente que não recebe a campanha.
export function emailUtilizavel(valor) {
  const e = String(valor || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Escapa um campo para CSV: aspas duplicadas e o valor entre aspas quando
// contiver separador, aspas ou quebra de linha.
export function campoCsv(valor) {
  const s = String(valor ?? '').replace(/\r?\n/g, ' ').trim();
  return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const TIPOS = { pos: 'Pós-pago', pre: 'Pré-pago', avulso: 'Avulso' };

// Monta o CSV. Deduplica por e-mail: um mesmo endereço em dois cadastros
// viraria duas mensagens para a mesma pessoa, que é como se perde descadastro
// e reputação de remetente.
export function montarCsvClientes(clientes = [], grupos = []) {
  const nomeGrupo = id => (grupos || []).find(g => g && g.id === id)?.nome || '';
  const vistos = new Set();
  const linhas = [];
  let semEmail = 0;
  let duplicados = 0;

  (clientes || []).forEach(c => {
    if (!c) return;
    const email = String(c.email || '').trim().toLowerCase();
    if (!emailUtilizavel(email)) { semEmail++; return; }
    if (vistos.has(email)) { duplicados++; return; }
    vistos.add(email);
    linhas.push([
      campoCsv(email),
      campoCsv(c.nome || ''),
      campoCsv(c.telefone || ''),
      campoCsv(TIPOS[c.tipo] || ''),
      campoCsv(nomeGrupo(c.grupoId))
    ].join(','));
  });

  // EMAIL como primeira coluna e nesse nome é o que o Brevo reconhece sozinho
  // na importação.
  const cabecalho = 'EMAIL,NOME,TELEFONE,TIPO,GRUPO';
  return {
    csv: [cabecalho, ...linhas].join('\r\n') + '\r\n',
    total: linhas.length,
    semEmail,
    duplicados
  };
}
