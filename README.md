# EV Parking — Sistema de Gestão + Pix Mercado Pago

Sistema web da EV Parking para importação de recargas, separação por tipo de operação, faturamento Pix, baixa automática, parceiros e relatórios.

## Rodar localmente

```bash
npm install
cp .env.example .env
npm start
```

Abra no navegador:

```text
http://localhost:3001
```

## Variáveis de ambiente

Crie um arquivo `.env` localmente com:

```env
PORT=3001
PIX_PROVIDER=mercadopago
MERCADOPAGO_ACCESS_TOKEN=APP_USR_SEU_TOKEN_DE_PRODUCAO
```

No Railway, cadastre estas variáveis em **Variables**. Não suba o arquivo `.env` para o GitHub.

## Deploy no Railway

1. Suba este projeto para um repositório no GitHub.
2. No Railway, clique em **New Project**.
3. Escolha **Deploy from GitHub repo**.
4. Selecione o repositório.
5. Em **Variables**, adicione:
   - `PIX_PROVIDER=mercadopago`
   - `MERCADOPAGO_ACCESS_TOKEN=APP_USR_...`
6. O Railway executará `npm install` e `npm start` automaticamente.

## Webhook Mercado Pago

Depois de publicado, configure no painel do Mercado Pago:

```text
https://SEU-DOMINIO/api/webhooks/mercadopago
```

Tópico: pagamentos / payments.

## Integração Tupi (OCPI 2.2.1)

O sistema sincroniza automaticamente as recargas direto da plataforma Tupi via API,
substituindo a importação manual de XML. A cada intervalo configurado, o servidor busca
as sessões atualizadas (endpoint OCPI `sessions`) e, para cada uma, os dados do usuário
(endpoint Tupi Extra `user-data`), gravando tudo no Postgres com deduplicação por `id`.

Variáveis de ambiente (ver `.env.example`):

```env
TUPI_TOKEN=SEU_TOKEN_TUPI
TUPI_PARTY_ID=XYZ            # party de 3 letras da empresa (obrigatório p/ user-data)
TUPI_COUNTRY_CODE=BR
TUPI_SYNC_INTERVAL_MIN=60    # intervalo do sync automático (min)
```

Endpoints internos (autenticados):

```text
POST /api/tupi/sync            # dispara sync manual (use ?full=1 para reprocessar histórico)
GET  /api/tupi/sync/status     # situação da última sincronização + totais
GET  /api/tupi/recargas        # recargas sincronizadas (normalizadas) — filtros: date_from, date_to, status
GET  /api/tupi/sessions/:id/user-data  # dados do usuário de uma sessão (consulta ao vivo)
```

Observação: a API Tupi **não fornece placa** do veículo. A chave para vincular a recarga ao
cliente/parceiro no faturamento é o `document` (CPF/CNPJ) retornado no user-data.

## Observação importante

Esta versão ainda salva dados principalmente no navegador/localStorage. Para uso multiusuário/produção final, o próximo passo recomendado é migrar dados para banco persistente, como PostgreSQL.
