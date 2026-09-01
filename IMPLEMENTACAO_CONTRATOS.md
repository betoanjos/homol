# EVCore - Módulo de Contratos e ZapSign

## Escopo desta versão

- Novo menu `Gestão > Contratos`.
- Atalho `Contrato` em cada parceiro cadastrado.
- Preenchimento com dados de parceiros e estações existentes.
- Tabelas PostgreSQL exclusivas para contratos, signatários, eventos e webhooks.
- Geração do contrato completo em PDF com cálculo automático.
- Bloqueio do PDF aprovado por hash SHA-256.
- Perfis: administrador cria/envia; usuário de leitura consulta e baixa.
- Integração ZapSign e modo simulador para homologação.
- Webhook com segredo, idempotência e confirmação do status diretamente na API ZapSign.
- PDF assinado e trilha de auditoria armazenados no EVCore.
- Inclusão dos contratos no backup JSON existente.

## Implantação segura

1. Fazer backup do banco de homologação.
2. Publicar esta versão no ambiente de homologação.
3. Configurar inicialmente:

```env
CONTRACTS_SIGNATURE_MODE=simulator
EVPARKING_SIGNER_NAME=Roberto Nascimento Anjos
EVPARKING_SIGNER_CPF=046.463.569-10
EVPARKING_SIGNER_EMAIL=EMAIL_QUE_ASSINARA_PELA_EV_PARKING
EVPARKING_SIGNER_PHONE=DDDNUMERO
ZAPSIGN_WEBHOOK_SECRET=SEGREDO_LONGO_E_ALEATORIO
```

4. Criar um contrato de teste e executar o fluxo até `Simular conclusão`.
5. Conferir o PDF original, o status final e o download do assinado.
6. Obter o token da API ZapSign e cadastrar o webhook com o header `Authorization` igual ao segredo configurado.
7. Alterar as variáveis:

```env
CONTRACTS_SIGNATURE_MODE=zapsign
ZAPSIGN_API_TOKEN=TOKEN_REAL_DA_ZAPSIGN
ZAPSIGN_AUTH_MODE=assinaturaTela-tokenEmail
```

8. Enviar primeiro um contrato de teste real, com signatários internos.
9. Somente depois promover a versão para produção.

## Arquivos existentes alterados

- `server/index.js`: inicialização e montagem das rotas do módulo.
- `public/index.html`: item de menu.
- `public/app.js`: atalho no cadastro do parceiro.
- `README.md`: configuração da integração.
- `package.json`: comando de testes.

Os cálculos, relatórios, Pix, sincronização Tupi, faturamento e estrutura do `app_state` não foram modificados.

## Arquivos novos

- `server/contratos/index.js`
- `server/contratos/validacao.js`
- `server/contratos/zapsign.js`
- `public/contratos.html`
- `public/contratos.js`
- `public/contratos-template.js`
- `test/contratos.test.js`
- `test/template.test.js`

## Validação

Execute:

```bash
npm install
npm test
npm start
```

Depois acesse o EVCore e abra `Gestão > Contratos`.
