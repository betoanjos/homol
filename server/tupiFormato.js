// Normalização da linha do banco para o formato "recarga" do EVP — lógica pura,
// sem banco, para ser testável isoladamente (mesmo padrão de
// contratos/validacao.js e estadoValidacao.js).
//
// Observação: a API Tupi NÃO fornece placa; a chave de vínculo com
// cliente/parceiro é o `document` (CPF/CNPJ).

export function toRecarga(row) {
  return {
    id: row.id,
    // uid = chave de deduplicação unificada CSV<->API.
    // Confirmado com dados reais: API `id` == coluna "ID da Transação" do CSV.
    uid: String(row.id),
    stationId: row.location_id,
    evseUid: row.evse_uid,
    connectorId: row.connector_id,
    autorizacao: row.authorization_reference,
    authMethod: row.auth_method,
    status: row.status,
    dataInicio: row.start_date_time,
    dataFim: row.end_date_time,
    kwh: row.kwh != null ? Number(row.kwh) : null,
    moeda: row.currency,
    custoApiSemImposto: row.total_cost_excl_vat != null ? Number(row.total_cost_excl_vat) : null,
    custoApiComImposto: row.total_cost_incl_vat != null ? Number(row.total_cost_incl_vat) : null,
    cliente: {
      nome: row.name || null,
      documento: row.document || null,
      email: row.email || null,
      endereco: row.name || row.city ? {
        logradouro: row.street_name || null,
        numero: row.number || null,
        bairro: row.district || null,
        cidade: row.city || null,
        uf: row.state || null,
        cep: row.zip_code || null
      } : null,
      veiculos: row.cars || null,
      encontrado: Boolean(row.user_found)
    },
    lastUpdated: row.last_updated
  };
}
