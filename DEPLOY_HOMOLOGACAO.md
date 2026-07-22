# Publicar em HOMOLOGAÇÃO (ambiente de teste separado da produção)

Objetivo: rodar a versão nova (com integração Tupi) em um ambiente **totalmente
isolado**, testar tudo, e só depois promover para produção. A produção atual
continua funcionando normalmente enquanto você testa.

> Regra de ouro: homologação **não compartilha nada** com a produção — banco
> próprio, URL própria, login próprio e Pix em modo de teste. O único item que
> pode ser reaproveitado é o token da Tupi, porque é somente leitura.

---

## Passo 1 — Colocar o código novo no GitHub

Escolha **uma** das opções:

- **Opção A (mais simples): uma branch nova.** No repositório atual, crie uma
  branch chamada `homologacao` com esta versão do código. A produção continua na
  branch principal (`main`), intacta.
- **Opção B: um repositório novo.** Crie um repositório separado (ex.:
  `evparking-homologacao`) e suba este código nele. Isolamento total.

A Opção A é suficiente e mantém tudo em um só lugar.

## Passo 2 — Criar um projeto novo no Railway

1. No Railway, clique em **New Project → Deploy from GitHub repo**.
2. Selecione o repositório e, se usou a Opção A, aponte para a branch
   **`homologacao`** (em Settings → Source → Branch).
3. Dê um nome claro ao projeto, ex.: **EVP — Homologação**.

## Passo 3 — Adicionar um Postgres NOVO (banco separado)

1. Dentro do projeto de homologação, clique em **New → Database → PostgreSQL**.
2. O Railway cria o banco e preenche a variável `DATABASE_URL` automaticamente.
3. **Confirme que é um banco novo, vazio** — nunca aponte para o banco da
   produção. É isso que garante que os testes não tocam nos dados reais.

## Passo 4 — Configurar as variáveis (Variables)

Use como base o arquivo `.env.staging.example`. Os pontos críticos:

- `DATABASE_URL` → do Postgres novo (automático).
- `EVCORE_ADMIN_USER` / `EVCORE_ADMIN_PASSWORD` → login **diferente** da produção.
- `PIX_PROVIDER=mock` → Pix simulado, **sem cobrança real** durante os testes.
- `TUPI_TOKEN` → o token novo da Tupi (somente leitura, seguro).
- `TUPI_PARTY_ID=EVP`, `TUPI_COUNTRY_CODE=BR`.
- `TUPI_SYNC_INTERVAL_MIN=15` para validar mais rápido.

Para o e-mail automático de aniversário (opcional — sem essas variáveis o
recurso fica desligado, sem afetar o resto do sistema):

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` → servidor de e-mail
  (ex.: Gmail com senha de app, Brevo, Resend SMTP, etc.).
- `SMTP_FROM` → remetente exibido (padrão: o próprio SMTP_USER).
- `WHATSAPP_NUMERO` → número do WhatsApp da rede com DDI, só dígitos
  (ex.: `5547999998888`) — destino do botão "Resgatar recarga grátis".
- `ANIVERSARIO_HORA` → hora local (0-23) do envio diário (padrão: 9).

## Passo 5 — Publicar e pegar a URL de teste

O Railway roda `npm install` e `npm start` sozinho. Ao terminar, ele gera uma
**URL pública própria** (algo como `evp-homologacao.up.railway.app`). É nela que
você faz todos os testes — separada da produção.

---

## Checklist de testes antes de promover

- [ ] Login funciona com o usuário de homologação.
- [ ] A tela abre e carrega os dados do servidor (não do navegador).
- [ ] O sync da Tupi rodou: verifique em `/api/tupi/sync/status` (logado).
- [ ] As recargas da API apareceram automaticamente na lista de recargas.
- [ ] A **estação nova** apareceu como pendente no módulo Estações.
- [ ] **Duplicidade:** importe o CSV de um mês que já tenha vindo pela API —
      devem aparecer **0 novas / N duplicadas**. Depois reimporte o mesmo CSV:
      de novo **0 novas**.
- [ ] Faturamento/Pix em modo mock: gere uma cobrança de teste e confirme que
      **não** houve cobrança real.
- [ ] Relatórios e valores batem com o mês de referência.

## Testar com dados reais (opcional, mais fiel)

Se quiser testar a dedup contra os dados que já existem na produção, dá para
copiar uma cópia do banco de produção para o de homologação (o sistema já gera
backup com `pg_dump` em `/api/backup/run`). Isso é opcional e mais técnico —
posso te guiar nesse passo separadamente se quiser.

## Promover para produção (depois de aprovado)

- Se usou **branch**: faça o merge de `homologacao` → `main`. O Railway da
  produção detecta e publica sozinho. Configure na produção as variáveis novas
  da Tupi (`TUPI_TOKEN`, `TUPI_PARTY_ID=EVP`, `TUPI_COUNTRY_CODE=BR`) e mantenha
  o Pix **de produção** lá.
- Se usou **repositório novo**: aponte o serviço de produção para o código novo,
  ou copie os arquivos alterados para o repositório de produção.

> Dica: faça um backup do banco de produção **antes** de promover, por garantia.
