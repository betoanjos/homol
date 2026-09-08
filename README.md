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

## Estação que muda de local e de parceiro

Um equipamento pode sair de um ponto e entrar em outro, mantendo o mesmo ID Tupi. Como a atribuição
de recargas é feita pela estação, simplesmente apontar o cadastro para o novo parceiro arrastaria
**todo o histórico junto**: as recargas antigas, ocorridas no local anterior, passariam a contar no
repasse do novo parceiro, e fechamentos já pagos mudariam sozinhos.

Para isso existe a **vigência** do vínculo, em [`public/estacao-vigencia.js`](public/estacao-vigencia.js).
Cadastre o equipamento **duas vezes**, com o mesmo ID Tupi e nomes diferentes, informando o período
de cada um no formulário da estação:

| Cadastro | ID Tupi | Parceiro | Vigência início | Vigência fim |
|---|---|---|---|---|
| Nome no local antigo | 1125790813 | Parceiro antigo | *(em branco)* | último dia no local |
| Nome no local novo | 1125790813 | Parceiro novo | primeiro dia no novo local | *(em branco)* |

Cada recarga é atribuída ao cadastro que valia **na data dela**. A janela é inclusiva nos dois
extremos, então não existe dia órfão nem dia disputado na virada. Cadastro sem vigência vale para
todo o histórico — é o caso normal, e nada muda para as estações que nunca trocaram de mãos.

Isso vale tanto no relatório do parceiro quanto no Payback, que casa por ID Tupi e passou a
respeitar a mesma janela. A rotina de reparo automático também reconhece cadastros que dividem um
ID Tupi e não os trata como duplicata — sem isso ela renomearia um com o nome do outro e apagaria
a separação.

## Backup

O backup automático roda a cada `BACKUP_INTERVAL_HOURS` (padrão 6) e grava em
`BACKUP_DIR` um JSON do `app_state` + contratos e, quando o `pg_dump` está disponível, um dump
completo do banco.

**`BACKUP_DIR` fica dentro do container, e o sistema de arquivos do Railway é efêmero: cada
deploy ou restart apaga tudo.** Sem armazenamento remoto configurado, o backup existe apenas até
o próximo deploy — por isso o servidor avisa no boot, o `/api/backup/status` devolve
`armazenamentoEfemero: true`, e um e-mail de alerta é disparado (no máximo um a cada 12h) se
`BACKUP_ALERTA_EMAIL` estiver definido.

Para ter backup recuperável de verdade, configure um bucket S3-compatível (AWS S3, Cloudflare R2,
Backblaze B2, MinIO, Wasabi):

```env
BACKUP_S3_ENDPOINT=https://<conta>.r2.cloudflarestorage.com
BACKUP_S3_BUCKET=evcore-backups
BACKUP_S3_REGION=auto            # us-east-1 na AWS; "auto" no R2
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
BACKUP_S3_PREFIX=evparking/      # opcional
BACKUP_ALERTA_EMAIL=voce@dominio.com.br
```

A assinatura AWS SigV4 é implementada em [`server/backupRemoto.js`](server/backupRemoto.js) com
`crypto`, sem adicionar dependência ao projeto — o SDK da AWS pesa mais que a aplicação inteira.
Os testes validam a assinatura contra o vetor oficial `get-vanilla` da suíte `aws4_testsuite`.

## Estado da aplicação (`app_state`)

Os dados de negócio (clientes, faturas, recargas, parceiros, estações, financeiro) ficam
num único documento JSONB na tabela `app_state`. O módulo [`server/estado.js`](server/estado.js)
é o **dono exclusivo** dessa tabela — nenhum outro arquivo deve fazer `UPDATE app_state`
direto; use `salvarEstado()` (gravação vinda do cliente) ou `mutarEstado()` (mutação interna,
como a baixa de pagamento no webhook).

Três proteções cobrem os riscos de manter tudo num documento só:

**1. Trava otimista por versão.** `GET /api/state` devolve `__version`. O cliente reenvia esse
número no `POST /api/state`. Se outra aba ou outro usuário gravou nesse intervalo, o servidor
responde **409** com o estado atual em vez de deixar o último gravador apagar o trabalho do
primeiro. O painel recarrega e avisa o usuário. No servidor a leitura usa `SELECT ... FOR UPDATE`,
então gravações simultâneas são serializadas e o conflito é sempre detectado.

**2. Guarda contra apagamento.** Um payload que remove mais de 30% dos itens de qualquer
coleção protegida — ou que simplesmente omite a coleção — é recusado com **422** e a lista do
que seria perdido. O painel pede confirmação explícita e só então reenvia com `__forcar`.
Ajuste o limite com `STATE_SHRINK_MAX` (padrão `0.3`).

**3. Histórico versionado.** Toda gravação arquiva a versão anterior em `app_state_history`,
mantendo as últimas 200 (`STATE_HISTORY_KEEP`). Dá para auditar e desfazer sem depender do
backup de 6 horas:

```text
GET  /api/state/historico           # versões, autor, motivo e totais por coleção
GET  /api/state/historico/:version  # conteúdo completo de uma versão
POST /api/state/restaurar/:version  # restaura (também reversível) — admin
```

No cliente, as 41 chamadas de `saveState()` passam por uma fila: uma gravação por vez, com
as pendentes agrupadas na próxima — o corpo é sempre o retrato completo, então basta a última.

### Recargas e faturas em tabelas próprias

`recargas` era a maior coleção do documento e a única que só cresce. Como o painel reenviava o
estado inteiro a cada edição, o corpo do `POST /api/state` caminhava para o teto de 2 MB do
parser — e ao bater nesse limite **toda** gravação passaria a falhar de uma vez.

Agora as recargas vivem na tabela `recargas` (chave `uid`, registro em JSONB), gravadas por
[`server/recargas.js`](server/recargas.js):

- **Leitura inalterada.** O `GET /api/state` devolve a lista completa junto com o estado, como
  sempre devolveu — nada mudou nas telas.
- **Escrita por diferença.** O painel compara as recargas em memória com o retrato recebido do
  servidor e envia ao `POST /api/recargas/lote` apenas as que mudaram, em lotes de 300. O corpo
  passa a ser proporcional ao que foi alterado, não ao tamanho do histórico.

O diff existe porque as recargas são alteradas *in-place* em dezenas de pontos da lógica de
faturamento (classificação por cliente, carimbo de `faturaId`, correção manual, exclusão, cálculo
de tarifa). Persistir registro a registro exigiria mapear cada um desses pontos, e esquecer um
faria uma alteração sumir sem aviso. A comparação em [`public/recargas-diff.js`](public/recargas-diff.js)
descobre sozinha o que mudou, sem que nenhum ponto de mutação precise saber que existe persistência.

A migração roda no boot, é idempotente e move o que ainda estiver no `app_state`. Enquanto ela não
completa, o `GET` serve a lista do documento e o `POST` se recusa a gravar um estado sem elas —
nunca há uma janela em que a lista possa ser apagada do documento sem existir na tabela.

**Faturas** ([`server/faturas.js`](server/faturas.js)) seguem exatamente o mesmo desenho, com a
chave `id` em vez de `uid` e o endpoint `POST /api/faturas/lote`. Pesam ainda mais por registro,
porque cada fatura embute as recargas que a compõem e o QR Code Pix em base64. O webhook do
Mercado Pago passou a dar baixa direto na linha da fatura, em vez de fazer read-modify-write no
documento inteiro — a regra que decide qual cobrança é baixada está isolada em
[`server/faturasPagamento.js`](server/faturasPagamento.js) e é coberta por testes.

O diff é o mesmo módulo para as duas coleções ([`public/colecao-diff.js`](public/colecao-diff.js)),
parametrizado pela chave.

### Próximo passo

Quando o formato do registro estabilizar, vale trocar o JSONB por colunas reais, com paginação no
painel — hoje as listas inteiras ainda são carregadas de uma vez na leitura. As faturas também
guardam as recargas duplicadas dentro de si (`recargas` além de `recargaUIDs`), redundância que
pode sair agora que as recargas têm tabela própria.

## Módulo de Contratos e ZapSign

O menu **Gestão > Contratos** utiliza os parceiros e estações já cadastrados apenas para preenchimento. Contratos, signatários, PDFs e eventos são armazenados em tabelas próprias no PostgreSQL e não alteram o `app_state`.

Para homologar sem enviar documentos reais:

```env
CONTRACTS_SIGNATURE_MODE=simulator
EVPARKING_SIGNER_NAME=Roberto Nascimento Anjos
EVPARKING_SIGNER_CPF=046.463.569-10
EVPARKING_SIGNER_EMAIL=assinatura@seudominio.com.br
EVPARKING_SIGNER_PHONE=47999999999
ZAPSIGN_WEBHOOK_SECRET=gere-um-segredo-longo-e-aleatorio
```

Para ativar a ZapSign depois de validar o fluxo:

```env
CONTRACTS_SIGNATURE_MODE=zapsign
ZAPSIGN_API_TOKEN=seu-token-da-api-zapsign
ZAPSIGN_AUTH_MODE=assinaturaTela-tokenEmail
ZAPSIGN_WEBHOOK_SECRET=mesmo-segredo-configurado-no-header-do-webhook
```

Cadastre na ZapSign o webhook:

```text
https://SEU-DOMINIO/api/webhooks/zapsign
```

Configure o header `Authorization` do webhook com o valor exato de `ZAPSIGN_WEBHOOK_SECRET`.
