const texto = (valor, limite = 500) => String(valor ?? '').trim().slice(0, limite);
const numero = (valor, padrao = 0) => {
  const n = Number(valor);
  return Number.isFinite(n) ? n : padrao;
};

export function somenteDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

export function documentoValido(valor) {
  const s = somenteDigitos(valor);
  if (!s || /^(\d)\1+$/.test(s)) return false;
  if (s.length === 11) {
    let soma = 0;
    for (let i = 0; i < 9; i++) soma += Number(s[i]) * (10 - i);
    let digito = (soma * 10) % 11;
    if (digito === 10) digito = 0;
    if (digito !== Number(s[9])) return false;
    soma = 0;
    for (let i = 0; i < 10; i++) soma += Number(s[i]) * (11 - i);
    digito = (soma * 10) % 11;
    if (digito === 10) digito = 0;
    return digito === Number(s[10]);
  }
  if (s.length === 14) {
    const calcular = (tamanho, pesos) => {
      let soma = 0;
      for (let i = 0; i < tamanho; i++) soma += Number(s[i]) * pesos[i];
      const resto = soma % 11;
      return resto < 2 ? 0 : 11 - resto;
    };
    const d1 = calcular(12, [5,4,3,2,9,8,7,6,5,4,3,2]);
    const d2 = calcular(13, [6,5,4,3,2,9,8,7,6,5,4,3,2]);
    return d1 === Number(s[12]) && d2 === Number(s[13]);
  }
  return false;
}

export function emailValido(valor) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto(valor, 254));
}

export function normalizarDadosContrato(entrada = {}) {
  const d = entrada || {};
  return {
    parceiroId: texto(d.parceiroId, 120),
    estacaoId: texto(d.estacaoId, 120),
    razaoSocial: texto(d.razaoSocial, 300),
    nomeFantasia: texto(d.nomeFantasia, 300),
    cnpj: texto(d.cnpj, 30),
    inscricaoEstadual: texto(d.inscricaoEstadual, 40),
    enderecoParceiro: texto(d.enderecoParceiro, 500),
    representanteNome: texto(d.representanteNome, 250),
    representanteCpf: texto(d.representanteCpf, 30),
    representanteEmail: texto(d.representanteEmail, 254).toLowerCase(),
    representanteTelefone: texto(d.representanteTelefone, 40),
    enderecoEstacao: texto(d.enderecoEstacao, 500),
    cidadeForo: texto(d.cidadeForo || 'São Bento do Sul - SC', 160),
    fabricante: texto(d.fabricante || 'WEG', 120),
    modelo: texto(d.modelo || 'WEMOB Station', 160),
    potenciaKw: numero(d.potenciaKw, 40),
    potenciaOperacionalKw: numero(d.potenciaOperacionalKw, numero(d.potenciaKw, 40)),
    conectores: texto(d.conectores || 'CCS2', 120),
    quantidadeSaidas: Math.max(1, Math.trunc(numero(d.quantidadeSaidas, 1))),
    quantidadeVagas: Math.max(1, Math.trunc(numero(d.quantidadeVagas, 1))),
    tensaoV: numero(d.tensaoV, 380),
    disjuntorA: numero(d.disjuntorA, 0),
    internetMbps: numero(d.internetMbps, 20),
    operacao24h: d.operacao24h !== false,
    prazoMeses: Math.max(1, Math.trunc(numero(d.prazoMeses, 48))),
    avisoPrevioDias: Math.max(1, Math.trunc(numero(d.avisoPrevioDias, 90))),
    investimento: numero(d.investimento, 0),
    custoEnergia: numero(d.custoEnergia, 0),
    precoKwh: numero(d.precoKwh, 1.99),
    taxaOperacionalPct: numero(d.taxaOperacionalPct, 22),
    comissaoPct: numero(d.comissaoPct, 12),
    recargasMensais: Math.max(0, Math.trunc(numero(d.recargasMensais, 160))),
    consumoMedioKwh: numero(d.consumoMedioKwh, 25),
    dataContrato: texto(d.dataContrato, 10),
    observacoes: texto(d.observacoes, 2000),
  };
}

export function calcularPremissas(dados) {
  const d = normalizarDadosContrato(dados);
  const energiaMensalKwh = d.recargasMensais * d.consumoMedioKwh;
  const receitaBruta = energiaMensalKwh * d.precoKwh;
  const custoEnergiaMensal = energiaMensalKwh * d.custoEnergia;
  const taxaOperacional = receitaBruta * (d.taxaOperacionalPct / 100);
  const receitaLiquida = receitaBruta - custoEnergiaMensal - taxaOperacional;
  const comissao = Math.max(0, receitaLiquida) * (d.comissaoPct / 100);
  return {
    energiaMensalKwh,
    receitaBruta,
    custoEnergiaMensal,
    taxaOperacional,
    receitaLiquida,
    comissao,
    repasseTotal: custoEnergiaMensal + comissao,
  };
}

export function validarDadosContrato(entrada) {
  const d = normalizarDadosContrato(entrada);
  const erros = [];
  if (!d.parceiroId) erros.push('Selecione o parceiro.');
  if (!d.razaoSocial) erros.push('Informe a razão social.');
  if (!documentoValido(d.cnpj)) erros.push('Informe um CPF/CNPJ válido do parceiro.');
  if (!d.enderecoParceiro) erros.push('Informe o endereço do parceiro.');
  if (!d.representanteNome) erros.push('Informe o representante legal.');
  if (!documentoValido(d.representanteCpf) || somenteDigitos(d.representanteCpf).length !== 11) erros.push('Informe o CPF do representante legal.');
  if (!emailValido(d.representanteEmail)) erros.push('Informe um e-mail válido do signatário.');
  if (!d.enderecoEstacao) erros.push('Informe o endereço da estação.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dataContrato)) erros.push('Informe a data do contrato.');
  if (!d.cidadeForo) erros.push('Informe o foro do contrato.');
  if (!(d.potenciaKw > 0)) erros.push('A potência da estação deve ser maior que zero.');
  if (!(d.investimento >= 0)) erros.push('O investimento informado é inválido.');
  if (!(d.custoEnergia >= 0)) erros.push('O custo da energia é inválido.');
  if (!(d.precoKwh > 0)) erros.push('O preço por kWh deve ser maior que zero.');
  if (d.taxaOperacionalPct < 0 || d.taxaOperacionalPct > 100) erros.push('A taxa operacional deve estar entre 0% e 100%.');
  if (d.comissaoPct < 0 || d.comissaoPct > 100) erros.push('A comissão deve estar entre 0% e 100%.');
  return { ok: erros.length === 0, erros, dados: d };
}
