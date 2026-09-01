(function () {
  const brl = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const num = (v, casas = 2) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const dataBR = iso => {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
  };
  const numeroExtensoBasico = n => {
    const valor = Math.trunc(Number(n || 0));
    const unidades = ['zero','um','dois','três','quatro','cinco','seis','sete','oito','nove'];
    const especiais = ['dez','onze','doze','treze','quatorze','quinze','dezesseis','dezessete','dezoito','dezenove'];
    const dezenas = ['','','vinte','trinta','quarenta','cinquenta','sessenta','setenta','oitenta','noventa'];
    if (valor < 10 && valor >= 0) return unidades[valor];
    if (valor < 20 && valor >= 10) return especiais[valor - 10];
    if (valor < 100 && valor >= 20) {
      const dezena = Math.floor(valor / 10);
      const unidade = valor % 10;
      return dezenas[dezena] + (unidade ? ` e ${unidades[unidade]}` : '');
    }
    return String(valor);
  };

  function gerarConteudoContrato(d, c, meta = {}) {
    const integrador = meta.integrador || {};
    const disjuntor = Number(d.disjuntorA || 0) > 0
      ? `${num(d.disjuntorA, 0)} A, conforme projeto elétrico e especificação do fabricante`
      : 'a dimensionar conforme projeto elétrico e especificação do fabricante';
    const operacao = d.operacao24h ? '24 horas por dia, 7 dias por semana' : 'conforme horário operacional definido para o local';
    return [
      { type: 'title', text: 'CONTRATO DE PARCERIA PARA INSTALAÇÃO, OPERAÇÃO E EXPLORAÇÃO DE ESTAÇÃO DE RECARGA DE VEÍCULOS ELÉTRICOS' },
      { type: 'p', text: `Pelo presente instrumento particular, de um lado, EV PARKING LTDA, inscrita no CNPJ nº ${integrador.cnpj || '67.097.035/0001-61'}, com sede na Rua Augusto Wunderwald, nº 2980, Sala 1, Cond. Sol Poente, Centenário, São Bento do Sul/SC, CEP 89283-192, representada por ${integrador.representante || 'Roberto Nascimento Anjos'}, CPF nº ${integrador.cpf || '046.463.569-10'}, doravante denominada INTEGRADOR;` },
      { type: 'p', text: `e, de outro lado, ${d.razaoSocial}, ${d.nomeFantasia ? `nome fantasia ${d.nomeFantasia}, ` : ''}inscrita no CPF/CNPJ nº ${d.cnpj}${d.inscricaoEstadual ? `, Inscrição Estadual nº ${d.inscricaoEstadual}` : ''}, com endereço em ${d.enderecoParceiro}, representada por ${d.representanteNome}, CPF nº ${d.representanteCpf}, doravante denominada PARCEIRO; têm entre si justo e contratado o que segue:` },

      { type: 'h1', text: 'CLÁUSULA 1 – OBJETO' },
      { type: 'p', text: `1.1. O presente contrato tem por objeto a instalação, operação, exploração comercial, gestão, manutenção e retirada, quando aplicável, de estação de recarga para veículos elétricos e híbridos plug-in, de propriedade exclusiva do INTEGRADOR, no imóvel localizado em ${d.enderecoEstacao}.` },
      { type: 'p', text: '1.2. A operação será realizada sob a marca EV Parking, que deverá constar nas publicações, comunicações e materiais publicitários relacionados à atividade.' },
      { type: 'p', text: '1.3. A operação será realizada por plataforma de gestão indicada pelo INTEGRADOR, atualmente TUPI, integrada aos equipamentos WEG/WEMOB, ou outra que venha a substituí-la.' },

      { type: 'h1', text: 'CLÁUSULA 2 – NATUREZA JURÍDICA DA OPERAÇÃO' },
      { type: 'p', text: '2.1. As partes reconhecem que a atividade objeto deste contrato caracteriza-se como prestação de serviço de recarga de veículos elétricos, nos termos da regulamentação aplicável.' },
      { type: 'p', text: '2.2. A operação não se confunde com venda de energia elétrica, sendo permitido ao INTEGRADOR realizar recargas inclusive para usuários não titulares da unidade consumidora, com preços livremente definidos.' },

      { type: 'h1', text: 'CLÁUSULA 3 – PROPRIEDADE DOS EQUIPAMENTOS (COMODATO)' },
      { type: 'p', text: '3.1. Todos os equipamentos instalados, incluindo carregadores, softwares, quadros, estruturas, cabos, acessórios e sistemas, são e permanecerão de propriedade exclusiva do INTEGRADOR, não se incorporando ao imóvel.' },
      { type: 'p', text: '3.2. Os equipamentos são concedidos ao PARCEIRO em regime de comodato, inexistindo direito de retenção, indenização ou aquisição.' },

      { type: 'h1', text: 'CLÁUSULA 4 – CESSÃO DE ESPAÇO' },
      { type: 'p', text: `4.1. O PARCEIRO cede espaço físico suficiente para instalação dos carregadores, no mínimo ${d.quantidadeVagas} vaga(s) dedicada(s), infraestrutura elétrica e de dados e sinalização vertical e horizontal.` },
      { type: 'p', text: '4.2. Esta cessão não caracteriza locação nem gera direitos possessórios ao INTEGRADOR, tratando-se de disponibilização de espaço vinculada ao presente contrato.' },

      { type: 'h1', text: 'CLÁUSULA 5 – EXCLUSIVIDADE E NÃO CONCORRÊNCIA' },
      { type: 'p', text: '5.1. Durante a vigência, não poderá existir outra estação pública de recarga em raio de 10 km do local contratado quando ela for de responsabilidade direta ou indireta do PARCEIRO.' },
      { type: 'p', text: '5.2. O PARCEIRO destina ao INTEGRADOR a exploração exclusiva do serviço de recarga no local objeto deste contrato.' },
      { type: 'p', text: '5.3. Havendo aumento comprovado da demanda, caberá ao INTEGRADOR avaliar e, existindo viabilidade técnica e comercial, implantar novas estações às suas expensas.' },
      { type: 'p', text: '5.4. Se o INTEGRADOR manifestar desinteresse ou não apresentar plano de ampliação ou justificativa técnica em até 60 dias da comunicação formal, o PARCEIRO poderá negociar estações adicionais com terceiros exclusivamente para a demanda não atendida.' },

      { type: 'h1', text: 'CLÁUSULA 6 – DEFINIÇÃO DE POTÊNCIA E CONFIGURAÇÃO' },
      { type: 'p', text: '6.1. A potência, ampliação ou limitação da estação será definida pelo INTEGRADOR conforme viabilidade técnica, fluxo, perfil do local e infraestrutura disponível.' },

      { type: 'h1', text: 'CLÁUSULA 7 – CONTRAPARTIDAS DO PARCEIRO' },
      { type: 'p', text: `7.1. O PARCEIRO fornecerá e manterá: ao menos ${d.quantidadeVagas} vaga(s) adequada(s), pavimentada(s) e preferencialmente coberta(s); energia elétrica trifásica; internet estável de no mínimo ${num(d.internetMbps, 0)} Mbps; infraestrutura física, segurança, limpeza, acesso e zelo pelo local.` },

      { type: 'h1', text: 'CLÁUSULA 8 – PREÇOS E GESTÃO COMERCIAL' },
      { type: 'p', text: '8.1. A definição de preços, tarifas, promoções e formas de cobrança será exclusiva do INTEGRADOR, por meio da plataforma de gestão.' },
      { type: 'p', text: '8.2. Compõem os custos da operação energia, manutenção, depreciação, tributos, custos financeiros, licenças, autorizações e comissionamentos.' },

      { type: 'h1', text: 'CLÁUSULA 9 – REAJUSTES' },
      { type: 'p', text: '9.1. Os valores poderão ser reajustados anualmente pelo IPCA, pelo custo de energia ou por outro índice oficial aplicável.' },
      { type: 'p', text: '9.2. Reajustes extraordinários poderão ocorrer para preservar o equilíbrio econômico-financeiro da operação, sem alteração unilateral do percentual fixo da taxa operacional, que dependerá de termo aditivo.' },

      { type: 'h1', text: 'CLÁUSULA 10 – ENERGIA ELÉTRICA' },
      { type: 'p', text: '10.1. A energia será fornecida pelo PARCEIRO e reembolsada conforme o consumo efetivamente medido, sem caracterizar comercialização de energia.' },
      { type: 'p', text: `10.2. O custo unitário de referência é ${brl(d.custoEnergia)}/kWh e será atualizado quando houver alteração tarifária comprovada por fatura apresentada pelo PARCEIRO.` },

      { type: 'h1', text: 'CLÁUSULA 11 – FLUXO DE REPASSES AO PARCEIRO' },
      { type: 'p', text: '11.1. Até o 10º dia útil de cada mês, o INTEGRADOR enviará relatório contendo energia consumida nas recargas, número de recargas, tempo médio, clientes atendidos, receita bruta e valor líquido a repassar.' },
      { type: 'p', text: '11.2. O PARCEIRO emitirá o documento fiscal legalmente aplicável ao comissionamento. Quando legalmente dispensado, poderá apresentar recibo, aceite formal ou documento equivalente.' },
      { type: 'p', text: '11.3. O pagamento ocorrerá em até 7 dias corridos após o recebimento do documento válido.' },

      { type: 'h1', text: 'CLÁUSULA 12 – COMISSIONAMENTO' },
      { type: 'p', text: `12.1. O PARCEIRO receberá comissão de ${num(d.comissaoPct)}% sobre a receita líquida efetivamente recebida pelo INTEGRADOR, conforme o Anexo Financeiro.` },
      { type: 'p', text: '12.2. Receita líquida é o valor recebido, deduzidos custo da energia consumida, taxa operacional fixa, impostos, taxas de plataforma e meios de pagamento, encargos, estornos e demais valores não incorporados ao resultado.' },
      { type: 'p', text: '12.3. A comissão tem natureza remuneratória e não forma sociedade, participação societária, vínculo empregatício ou ingerência do PARCEIRO na gestão.' },

      { type: 'h1', text: 'CLÁUSULA 13 – TRIBUTAÇÃO' },
      { type: 'p', text: '13.1. O INTEGRADOR definirá o enquadramento tributário da operação como prestação de serviço. O PARCEIRO responde por seus tributos e documentos fiscais.' },

      { type: 'h1', text: 'CLÁUSULA 14 – SEGURO' },
      { type: 'p', text: '14.1. O INTEGRADOR contratará e manterá seguro para os equipamentos, arcando com os custos.' },
      { type: 'p', text: '14.2. A apólice contemplará, quando disponíveis e aplicáveis, furto, roubo, incêndio, vandalismo, danos elétricos, riscos compatíveis e danos a terceiros.' },
      { type: 'p', text: '14.3. O PARCEIRO não terá obrigação relativa ao seguro, salvo sinistros comprovadamente causados por seu dolo ou culpa grave, de empregados, prepostos ou terceiros por ele autorizados.' },

      { type: 'h1', text: 'CLÁUSULA 15 – SLA E DISPONIBILIDADE' },
      { type: 'p', text: `15.1. O INTEGRADOR manterá a estação em operação durante o período de funcionamento previsto (${operacao}), observadas manutenções e condições técnicas.` },
      { type: 'p', text: '15.2. Não constituem descumprimento indisponibilidades por falha de energia, internet, atos de terceiros, caso fortuito, força maior ou eventos externos.' },

      { type: 'h1', text: 'CLÁUSULA 16 – DANOS E VANDALISMO' },
      { type: 'p', text: '16.1. Danos causados por terceiros não geram responsabilidade automática do PARCEIRO, salvo negligência, omissão ou falha direta comprovada na adoção de medidas razoáveis de segurança.' },

      { type: 'h1', text: 'CLÁUSULA 17 – PRAZO CONTRATUAL' },
      { type: 'p', text: `17.1. O contrato terá prazo mínimo de ${d.prazoMeses} (${numeroExtensoBasico(d.prazoMeses)}) meses a partir do início da operação e será renovado automaticamente por iguais períodos, salvo aviso escrito com antecedência mínima de ${d.avisoPrevioDias} dias.` },
      { type: 'p', text: `17.2. O investimento total estimado do projeto é de ${brl(d.investimento)}, de caráter estimativo e por conta do INTEGRADOR.` },

      { type: 'h1', text: 'CLÁUSULA 18 – RESCISÃO ANTECIPADA' },
      { type: 'p', text: `18.1. Na rescisão antecipada pelo PARCEIRO, sem justa causa, antes do prazo mínimo de ${d.prazoMeses} meses, será devida multa compensatória de 30% do investimento efetivamente realizado, reduzida linearmente pelos meses cumpridos.` },
      { type: 'p', text: `18.2. O investimento será o valor comprovadamente desembolsado com equipamentos, transporte, instalação, obras civis, infraestrutura elétrica, projetos, homologações, licenças e custos diretamente relacionados. A redução considerará o prazo de ${d.prazoMeses} meses.` },
      { type: 'p', text: '18.3. A multa não afasta perdas e danos adicionais comprovados, especialmente por intervenção não autorizada ou paralisação indevida.' },
      { type: 'p', text: '18.4. O PARCEIRO poderá rescindir sem multa por descumprimento grave não sanado em 30 dias; indisponibilidade superior a 30 dias consecutivos ou 60 intercalados em 12 meses; impedimento legal definitivo; ou risco comprovado à atividade principal.' },
      { type: 'p', text: '18.5. Após 24 meses, o PARCEIRO poderá rescindir sem multa se, por 12 meses contínuos, o faturamento ficar abaixo de 50% da estimativa do Anexo Financeiro, após notificação e prazo de 90 dias para medidas de recuperação.' },
      { type: 'p', text: `18.6. Nas demais hipóteses, a rescisão por conveniência exige aviso prévio de ${d.avisoPrevioDias} dias e pagamento da multa quando aplicável.` },

      { type: 'h1', text: 'CLÁUSULA 19 – RETIRADA DOS EQUIPAMENTOS' },
      { type: 'p', text: '19.1. Encerrado ou rescindido o contrato, o INTEGRADOR deverá retirar os equipamentos de sua propriedade em até 30 dias corridos, e o PARCEIRO garantirá acesso para desmontagem e retirada. A permanência após o prazo dependerá de acordo escrito. O INTEGRADOR reparará danos diretamente causados pela retirada, não sendo obrigado a remover ou restaurar obras civis e instalações elétricas incorporadas permanentemente, salvo ajuste escrito.' },

      { type: 'h1', text: 'CLÁUSULA 20 – RESPONSABILIDADE POR DANOS A TERCEIROS' },
      { type: 'p', text: '20.1. O INTEGRADOR responderá por danos comprovadamente decorrentes de falha técnica do equipamento, mediante laudo que estabeleça o nexo causal.' },
      { type: 'p', text: '20.2. Excluem-se danos decorrentes de mau uso, instalações elétricas ou modificações do veículo e força maior.' },

      { type: 'h1', text: 'CLÁUSULA 21 – LGPD' },
      { type: 'p', text: '21.1. As partes cumprirão a Lei Geral de Proteção de Dados, Lei nº 13.709/2018, utilizando dados pessoais somente para execução e comprovação da relação contratual.' },

      { type: 'h1', text: 'CLÁUSULA 22 – NÃO VÍNCULO' },
      { type: 'p', text: '22.1. O contrato não gera vínculo societário, trabalhista ou de representação.' },

      { type: 'h1', text: 'CLÁUSULA 23 – FORO' },
      { type: 'p', text: `23.1. Fica eleito o foro da comarca de ${d.cidadeForo}, com renúncia a qualquer outro.` },

      { type: 'h1', text: 'CLÁUSULA 24 – ASSINATURA ELETRÔNICA' },
      { type: 'p', text: '24.1. As partes reconhecem como válida a assinatura eletrônica realizada por plataforma especializada, ainda que sem certificado ICP-Brasil, desde que permita comprovar autoria, manifestação de vontade, integridade e trilha de auditoria, nos termos da legislação.' },
      { type: 'p', text: '24.2. Data, horário, endereço IP, métodos de autenticação, identificadores dos signatários, histórico de eventos e código de integridade constituem meios válidos de comprovação.' },
      { type: 'p', text: '24.3. O instrumento produzirá efeitos após a conclusão das assinaturas de todas as partes, sendo a via eletrônica assinada considerada original.' },

      { type: 'p', text: `${d.cidadeForo}, ${dataBR(d.dataContrato)}.` },
      { type: 'signature', left: `${d.razaoSocial}\n${d.representanteNome}\nCPF: ${d.representanteCpf}`, right: `EV PARKING LTDA\n${integrador.representante || 'Roberto Nascimento Anjos'}\nCPF: ${integrador.cpf || '046.463.569-10'}` },

      { type: 'h1', text: 'ANEXO I – CONFIGURAÇÃO TÉCNICA' },
      { type: 'p', text: `Carregador DC ${d.fabricante} ${d.modelo}, potência nominal de ${num(d.potenciaKw, 0)} kW e potência operacional de até ${num(d.potenciaOperacionalKw, 0)} kW, com ${d.quantidadeSaidas} saída(s) ${d.conectores}.` },
      { type: 'p', text: `Infraestrutura: alimentação trifásica ${num(d.tensaoV, 0)} V; proteção/disjuntor ${disjuntor}; cabos e proteções dimensionados conforme projeto; ${d.quantidadeVagas} vaga(s); internet mínima ${num(d.internetMbps, 0)} Mbps; operação ${operacao}.` },

      { type: 'h1', text: 'ANEXO II – PREMISSAS FINANCEIRAS E COMISSIONAMENTO' },
      { type: 'p', text: `Premissas: ${d.recargasMensais} recargas mensais; consumo médio ${num(d.consumoMedioKwh)} kWh; energia mensal estimada ${num(c.energiaMensalKwh)} kWh.` },
      { type: 'p', text: `Preço de cobrança: ${brl(d.precoKwh)}/kWh. Receita bruta estimada: ${brl(c.receitaBruta)}.` },
      { type: 'p', text: `Custo de energia: ${brl(d.custoEnergia)}/kWh. Repasse estimado da energia: ${brl(c.custoEnergiaMensal)}.` },
      { type: 'p', text: `Taxa operacional contratual fixa: ${num(d.taxaOperacionalPct)}% sobre a receita bruta efetivamente recebida, excluídos cancelamentos e estornos. Valor estimado: ${brl(c.taxaOperacional)}. O percentual somente poderá ser alterado por termo aditivo.` },
      { type: 'p', text: `Receita líquida estimada: ${brl(c.receitaLiquida)}. Comissão do PARCEIRO: ${num(d.comissaoPct)}%, estimada em ${brl(c.comissao)}. Repasse total estimado, incluindo energia: ${brl(c.repasseTotal)}.` },
      { type: 'p', text: 'Os valores são estimativas e variam com o volume real, tarifas, regulação e demanda. Não há garantia mínima de faturamento.' },

      { type: 'h1', text: 'ANEXO III – OPERAÇÃO E GOVERNANÇA' },
      { type: 'p', text: 'A plataforma de gestão indicada pelo INTEGRADOR será a fonte para medições, receitas, comissões, relatórios e auditoria operacional. Divergências serão resolvidas com base em seus registros e nos logs da estação.' },
      { type: 'p', text: 'O relatório mensal conterá energia consumida, consumo médio, tempo médio, total de recargas, clientes atendidos, receita bruta, custos e valor líquido a receber.' },
      ...(d.observacoes ? [{ type: 'h1', text: 'OBSERVAÇÕES ESPECÍFICAS' }, { type: 'p', text: d.observacoes }] : []),
    ];
  }

  window.EVContratoTemplate = { gerarConteudoContrato, brl, num };
})();
