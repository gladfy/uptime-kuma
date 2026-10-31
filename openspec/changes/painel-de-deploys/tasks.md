# Fase 1 — Página e monitores

Entra em produção sem nenhuma infraestrutura nova. As fontes de deploy aparecem como "não configurada".

## 1. Esqueleto do backend

- [x] 1.1 Criar `server/deploy-board/config.js`: lê o JSON de `DEPLOY_BOARD_CONFIG`, valida namespaces, projetos (`name`, `source` ∈ {bitbucket, github}, `repo`, `branch`, `releases` no formato `<namespace>/<release>`) e `amplify.region`, e devolve erro que nomeia arquivo e campo. Arquivo ausente ou inválido desliga todas as fontes de deploy, sem lançar.
- [x] 1.2 Criar `server/deploy-board/store.js` com a situação de cada fonte (`não configurada`, `ativa`, `sem leitura`, hora do último dado), a lista de deploys e o histórico (vazios nesta fase), `snapshot()` só com os campos que o navegador usa e `onChange` limitado a uma emissão por segundo.
- [x] 1.3 Criar `server/deploy-board/index.js`: monta config e store, `start()` idempotente, nenhuma fonte ligada nesta fase.
- [x] 1.4 Criar `server/socket-handlers/deploy-board-socket-handler.js`: `getDeployBoard` com `checkLogin(socket)`; difusão de `deployBoardUpdate` só para sockets com `socket.userID`.
- [x] 1.5 `server/server.js`, duas inserções de uma linha: registrar o socket handler na lista (~linha 1733, com o `require` junto dos outros) e chamar o `start()` no callback do `listen` depois de `startMonitors()`.
- [x] 1.6 Escrever `test/backend-test/deploy-board/test-config.js` (válido, ausente, JSON inválido, campo errado nomeado na mensagem), `test-store.js` (situação das fontes, campos do `snapshot()`, limite de emissão) e `test-socket-handler.js` (socket sem login recebe recusa e nenhum dado; com login recebe o estado; a difusão não alcança socket anônimo).

## 2. Página

- [x] 2.1 Registrar `/deploys/:slug` no nível de cima de `src/router.js` com import lazy de `src/pages/DeployBoard.vue`. Conferir que `src/mixins/socket.js` não precisa mudar.
- [x] 2.2 Criar `src/pages/DeployBoard.vue`: `<Login>` quando `!$root.loggedIn && $root.allowLoginDialog` e nenhum dado antes do login; com login, pede `getDeployBoard` e escuta `deployBoardUpdate`; lê a curadoria de `/api/status-page/:slug` (relida a cada 5 min) e mostra "página não encontrada" para slug inexistente ou despublicado.
- [x] 2.3 Layout em duas colunas (`minmax(26rem, 30%)` + resto), empilhando abaixo de 1.180 px, sem rolagem horizontal; fonte de `src/assets/fonts/plus-jakarta-sans.css`; tokens de cor no `:root` da página com tema escuro e claro; cor de marca `#B11E58`.
- [x] 2.4 Criar `src/components/deploy-board/MonitorGrid.vue` e `IncidentBlock.vue`: estado nos quatro estados do Kuma a partir de `$root.heartbeatList`, barras de heartbeat, `DOWN`/`PENDING` no destaque com o tempo no estado, `MAINTENANCE` na grade sem contar como queda. Sem fonte de deploy ativa, o destaque não tem linha de deploy.
- [x] 2.5 Dimensionar a grade medindo o DOM: menor número de colunas em que todos cabem com altura mínima legível; não cabendo, paginar a cada 15 s com "página X de Y".
- [x] 2.6 Coluna de deploys no estado sem fontes (texto que diz o que vai aparecer ali) e `src/components/deploy-board/SourcesFooter.vue` com a situação de cada fonte, incluindo o socket do Kuma.
- [x] 2.7 Extrair os textos para chaves novas em `src/lang/en.json` e `src/lang/pt-BR.json`, no MEIO do json, perto de chaves relacionadas.

## 3. Entrega da fase 1

- [x] 3.1 `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes.
  - Rodada local de 31/10/2026: build ok, lint 0 erros (72 avisos, nenhum em arquivo desta mudança), langs ok, test-backend 302/303. O único vermelho é `monitors/test-mssql.js`, interrompido por esperar o download da imagem do MSSQL; o MSSQL não é usado na Winker e o teste não toca no painel.
- [x] 3.2 Localmente: sem login, a página mostra só o login e o socket não recebe dado do painel; com login, numa janela de 1920 × 1080 com a status page `winker`, os 34 monitores cabem sem paginar; com 400 px, as colunas empilham sem rolagem horizontal.
- [x] 3.3 Merge no master do fork, deploy pela pipeline e conferência na TV: `/deploys/winker` logado, monitores ao vivo, queda subindo para o destaque.
  - 31/10/2026: PR #4, pipeline 41166193128 verde, pod `2.5.3-winker.16` pronto, log com "DEPLOY_BOARD_CONFIG is not set; every deploy source is off.", `/deploys/winker` e `/status/winker/tv` respondendo 200. A olhada na TV ficou com o Erik.

# Fase 2 — Virada no cluster

Exige a ServiceAccount do Kuma com leitura em 5 namespaces e o ConfigMap com namespaces e projetos.

## 4. Estado da virada

- [x] 4.1 Criar `server/deploy-board/rollout-state.js` (puro): dado o retrato dos Deployments de uma release, devolve o estado (atualizando, sem progresso, travado, concluído) com o critério do `kubectl rollout status`, a soma de réplicas atualizadas sobre `spec.replicas`, réplicas 0 como concluído, e a extração dos campos permitidos do objeto (namespace, nome, release, revisão, tags de imagem, réplicas, condições).
  - O rastreio com estado (linha de base, quem se junta a qual virada, substituição) ficou em `server/deploy-board/cluster-tracker.js`, separado do I/O. Objetos da mesma release alterados até 2 min depois do início são a mesma virada (o helm aplica um a um; o `gateway-cron` são 95 CronJobs). Revisão nova com a anterior ainda virando encerra a anterior como "substituída". Exceção: a anterior TRAVADA não é substituída — continua travada até um deploy posterior do projeto concluir (cenário "Falha resolvida por deploy novo", que na prática é a mesma release). Deployment recém-criado (sem anotação de revisão, depois "1") é uma virada só.
- [x] 4.2 Escrever `test/backend-test/deploy-board/test-rollout-state.js`: virada do `winker-prod` com `maxSurge 1`, `ProgressDeadlineExceeded`, release de vários Deployments (`gateway-worker`), réplicas 0, mudança só de réplicas pelo HPA (não é virada), template novo com a mesma tag (é virada), e a asserção de que env e volumes de um Deployment com credencial plantada não sobrevivem à extração.

## 5. Coletor do cluster

- [x] 5.1 Criar `server/deploy-board/kubernetes-source.js`: token e CA da ServiceAccount, `https.Agent` com o CA, `list` + `watch` por namespace para `apps/v1 deployments` e `batch/v1 cronjobs`, leitura do stream linha a linha, `timeoutSeconds` de 5 min, reabertura com espera de 1 s a 60 s, relista no 410, 403 por namespace como erro nomeado. Sem token = fonte "não configurada".
  - Desvios do design: módulo `http`/`https` do Node em vez do axios (o watch é um stream lido linha a linha, que o `https` entrega direto), e `timeoutSeconds` de **60 s**, não 5 min: com 5 min um namespace quieto passaria de 2 min sem resposta e o painel o marcaria "sem leitura" sem motivo. Um watch mudo por 90 s é derrubado e a lista refeita (conexão meio aberta).
- [x] 5.2 Linha de base no boot (release concluída não vira deploy; release no meio da virada aparece em andamento), relógio de "sem progresso" de 2 min e marca "sem leitura" quando o cluster passa de 2 min sem resposta.
- [x] 5.3 CronJobs: contar os da release cujo template mudou junto ("N CronJobs na imagem nova"), sem bloquear o "concluído".
  - Entra na virada quando a TAG da imagem muda, não pela `generation`: suspender o CronJob ou trocar o horário à mão também sobe a geração e não é deploy.
- [x] 5.4 Escrever `test/backend-test/deploy-board/test-kubernetes-source.js` com servidor HTTP local no papel da API: eventos partidos no meio da linha, 410 seguido de relista sem virada falsa, 403 num namespace sem derrubar os outros, e ausência de token.

## 6. Deploys do cluster no painel

- [x] 6.1 No store: deploy a partir da virada (identidade `namespace/release` + revisão, agrupado por projeto pela configuração), rótulo derivado da virada, sem seção de pipeline e sem "Sem pipeline" enquanto a fonte de pipeline do projeto estiver desligada; ciclo de vida (concluído some após 10 min; travado sai quando um deploy posterior do projeto conclui) e histórico de 24 h com teto de 500.
  - Viradas de releases diferentes do mesmo projeto formam um deploy só quando a tag tem o mesmo SHA; sem SHA (chat `prod`), quando começam até 20 min depois do deploy aberto do projeto. Release que não está em nenhum projeto (render-chrome, metrics-server, xhprof...) não aparece, ainda que o namespace seja observado. A tag mostrada é a do primeiro container (o segundo costuma ser o nginx).
- [x] 6.2 Ampliar `test-store.js`: rótulos com a fonte de pipeline desligada, ciclo de vida, teto do histórico e campos do `snapshot()`.
- [x] 6.3 Criar `src/components/deploy-board/DeployCard.vue` (linhas de release com `<atualizados>/<réplicas>` e estado, linha de CronJobs, rótulos da spec), a ordem dos cartões (falha, travado, andamento, concluído) e a lista "Hoje".
- [x] 6.4 Marca "em deploy"/"virada travada" pela tag `deploy` dos monitores e a linha de correlação do destaque, só com a fonte da release ativa. Deploy nunca muda a cor do monitor.
- [x] 6.5 Chaves de i18n novas da fase, no meio dos dois json.

## 7. Infraestrutura da fase 2 (repositório `infrastructure`, chart `helm-packages/tools/uptimekuma`)

- [x] 7.1 ServiceAccount `uptime-kuma` e `serviceAccountName` no Deployment (hoje usa a `default`).
- [x] 7.2 ClusterRole `uptime-kuma-deploy-board` com `get`, `list` e `watch` em `apps/deployments` e `batch/cronjobs`, ligada por RoleBinding em `condominio`, `gateway`, `connector`, `chat` e `monitor-infra`. Conferir com `kubectl auth can-i --as=system:serviceaccount:monitor-infra:uptime-kuma` que ela lê Deployments nesses namespaces e não lê Secrets em nenhum.
  - 31/10/2026, depois do deploy do chart 0.2.0: nos cinco namespaces, `list`/`watch` de Deployments e CronJobs = yes; `get secrets`, `list pods`, `patch deployments`, `delete pods` e `create pods/exec` = no. Fora deles (`kube-system`, `ingress`, `-A`, nós, Secrets do cluster) = no. Log do pod: "Watching 5 namespaces for 12 releases", sem 403.
- [x] 7.3 ConfigMap com `namespaces` e `projects` (sem segredos) e `DEPLOY_BOARD_CONFIG` no Deployment. Publicar a versão nova do chart.
  - Chart 0.2.0 (branch `feat/uptimekuma-painel-de-deploys` do `infrastructure`): `serviceaccount.yaml`, `rbac-deploy-board.yaml` (recusa ligar o RBAC na ServiceAccount `default`), `configmap-deploy-board.yaml` gerado de `deployBoard.namespaces`/`projects` do values (uma lista só para RoleBinding e configuração), checksum da configuração no pod. `CHART_VERSION` da pipeline do fork em 0.2.0. `helm lint`, `helm template`, `kubectl apply --dry-run=server` e o `config.json` renderizado passando no validador do Kuma.

## 8. Entrega da fase 2

- [x] 8.1 `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes.
  - Rodada local de 31/10/2026: build ok, lint 0 erros (72 avisos, nenhum em arquivo do painel), langs ok, test-backend 347/348. O vermelho foi `monitors/test-rabbitmq.js` (o container não subiu em 60 s com a máquina carregada); isolado, 9/9.
  - Conferência no navegador com o estado gerado pelos módulos reais (rastreador + store) a partir de Deployments de exemplo: ordem dos cartões, rótulos sem "Sem pipeline", `9/17`, marcas "em deploy"/"virada travada" sem mudar a cor, linha do destaque ("Começou 45 min depois da virada de gateway-prod · 4c1d9e0" e "não tem deploy associado"), cluster sem leitura apagando marcas e linhas, 1920 × 1080 sem corte e 400 px sem rolagem horizontal.
- [ ] 8.2 Deploy, marcar os monitores com a tag `deploy` e acompanhar o próximo merge de um projeto do Bitbucket no painel: a virada aparece por release, sem o rótulo "Sem pipeline", e conclui junto com o `kubectl rollout status`.
  - 31/10/2026: deploy feito (chart 0.2.0, imagem `2.5.3-winker.18`). Tag `deploy` posta pela API do Kuma em 8 monitores da status page `winker`: Web → `condominio/winker-prod`, Web integração → `condominio/winker-integration`, Gateway (API Geral) → `gateway/gateway-prod`, Gateway Integration → `gateway/gateway-integration`, Chat → `chat/chatwoot`, Connector Access/Consumer/Queue → `connector/connector-*`. Convite e Portaria Web ficam para a fase 5 (Amplify); os outros monitores da página dependem da fase 3; Connector Geral ficou sem tag até confirmar se aponta para o EB. Falta acompanhar o próximo merge.
  - Botão "Deploys" no cabeçalho do Kuma (branch `feat/botao-painel-de-deploys`), abre `/deploys/winker`.

# Fase 3 — Cobertura do EKS

Leva ao painel as outras aplicações que rodam no EKS. Inventário de 31/10/2026 (Deployments, StatefulSets, CronJobs e Ingress do `winkernetes`): além das 12 releases da fase 2, há 18 releases em 12 namespaces (16 de aplicação e 2 de infraestrutura com monitor). Parte delas vem de repositório no CodeCommit ou de chart de infraestrutura, sem pipeline no Bitbucket nem no GitHub, por isso o projeto passa a poder existir sem fonte de pipeline.

| Projeto | Releases (`<namespace>/<release>`) | Origem da pipeline | Monitor na página `winker` |
|---|---|---|---|
| agua-gas | `microservices-prod/agua-gas` | nenhuma (CodeCommit `agua_gas_server`) | Água/Gás |
| superlogica | `microservices-prod/ms` | nenhuma (CodeCommit `microservice_superlogica`) | Superlógica |
| status | `microservices-prod/status` | a confirmar (Bitbucket `winker/status` ou CodeCommit `status`) | Status |
| integration | `microservices-prod/integration-prod`, `microservices-prod/integration-worker` | nenhuma (CodeCommit `integration`) | — |
| observer | `observer/observer-prod`, `observer/observer-worker` | Bitbucket `winker/observer` | Observer |
| site | `site-prod/site-prod` | a confirmar (CodeCommit `site`) | Site |
| jambonz | `jambonz-prod/jambonz-worker`, `jambonz-prod/jambonz-vad` | GitHub `gladfy/jambonz-worker` (o do vad a confirmar) | Jambonz Worker |
| wk-face-api | `facial/wk-face-api` | a confirmar | — |
| land | `land/land` | a confirmar | — |
| chat-api | `chat-api/chat-api` | a confirmar | — |
| ai-agents | `ai-agents-prod/ai-agents-prod` | a confirmar | — |
| winker-mcp | `mcp-prod/winker-mcp-prod` | a confirmar | — |
| audit-consumer | `audit-platform/audit-consumer` | a confirmar | — |
| temporal | `temporal/temporal` | nenhuma (chart de infraestrutura) | Temporal |
| prefect | `big-data/prefect-server` | nenhuma (chart de infraestrutura) | Prefect |

Fora desta fase, para a conferência da fase 6 decidir: as variantes de estágio (`*-dev`), a observabilidade (Loki, Tempo, Grafana, Prometheus, Victoria Metrics, OTel), Envoy, ProxySQL, Redis/Valkey, External Secrets, OpenCost, Metabase e GLPI (estes dois sem release do Helm).

## 9. Projeto sem fonte de pipeline

- [ ] 9.1 `server/deploy-board/config.js`: `source`, `repo` e `branch` passam a ser opcionais **juntos** — os três ou nenhum. Presente só parte deles, a configuração é recusada com a mensagem nomeando o campo que falta. `releases` continua obrigatório.
- [ ] 9.2 No store, projeto sem origem nunca tem fonte de pipeline configurada: o cartão mostra só a virada e nunca o rótulo "Sem pipeline", mesmo depois que os segredos dos webhooks existirem (fase 4).
- [ ] 9.3 Ampliar `test-config.js` (projeto sem os três campos aceito; com só `repo`, recusado nomeando `source`) e `test-store.js` (projeto sem origem, com a fonte do Bitbucket ligada, não ganha "Sem pipeline").

## 10. Infraestrutura e entrega da fase 3

- [ ] 10.1 Confirmar com o Erik as origens marcadas "a confirmar" na tabela acima. Origem desconhecida entra sem origem; ela pode ser acrescentada depois sem mudar código.
- [ ] 10.2 Chart `uptimekuma` 0.3.0: os namespaces `microservices-prod`, `observer`, `site-prod`, `jambonz-prod`, `facial`, `land`, `chat-api`, `ai-agents-prod`, `mcp-prod`, `audit-platform`, `temporal` e `big-data` em `deployBoard.namespaces` (RoleBinding e configuração da mesma lista) e os projetos da tabela em `deployBoard.projects`. `helm lint`, `helm template` e o `config.json` renderizado passando no validador da 9.1. Publicar no S3 só com o pedido do Erik.
- [ ] 10.3 `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes; merge no fork e deploy (o código da 9.1 sobe **antes** do chart 0.3.0, senão a configuração nova é recusada e todas as fontes desligam).
- [ ] 10.4 `kubectl auth can-i --as=system:serviceaccount:monitor-infra:uptime-kuma` nos namespaces novos: lê Deployments e CronJobs; não lê Secrets nem Pods. Log do pod com o número novo de namespaces e releases, sem 403.
- [ ] 10.5 Tag `deploy` pela API do Kuma nos monitores da tabela: Água/Gás → `microservices-prod/agua-gas`, Superlógica → `microservices-prod/ms`, Status → `microservices-prod/status`, Observer → `observer/observer-prod`, Site → `site-prod/site-prod`, Jambonz Worker → `jambonz-prod/jambonz-worker`, Temporal → `temporal/temporal`, Prefect → `big-data/prefect-server`. Confirmar com o Erik o endereço do monitor "Flow": se for em `api.winker.com.br`, ganha `gateway/gateway-prod`.
- [ ] 10.6 Acompanhar a próxima virada de uma release nova no painel.

# Fase 4 — Pipelines

Exige o Secret com os dois segredos e o cadastro dos webhooks: os cinco da fase 2 (três no Bitbucket, dois no GitHub) e os dos projetos da fase 3 que tiverem origem no Bitbucket ou no GitHub.

## 11. Assinatura e leitura dos eventos

- [ ] 11.1 Criar `server/deploy-board/signature.js`: HMAC-SHA256 sobre o `Buffer` recebido, formato `sha256=<hex>`, `crypto.timingSafeEqual` com guarda de tamanho.
- [ ] 11.2 Criar `server/deploy-board/bitbucket-events.js` e `github-events.js` (puros): `repo:push`/`push` → merge (hora, SHA, primeira linha da mensagem truncada em 120); `repo:commit_status_*` → estado da pipeline; `workflow_run` → execução; `workflow_job` → job. Filtro por repositório e branch configurados (projeto sem origem nunca casa). Só os campos da spec saem da função.
- [ ] 11.3 Escrever `test/backend-test/deploy-board/test-signature.js` e `test-webhook-events.js`: assinatura correta, errada, ausente, de tamanho diferente e calculada sobre o JSON reserializado (tem de falhar); payloads de exemplo reais de cada evento, branch de feature e repositório fora da configuração descartados.

## 12. Roteador de webhook

- [ ] 12.1 Criar `server/routers/deploy-board-webhook-router.js`: `express.raw({ type: "application/json", limit: "1mb" })` no próprio roteador, só em `/api/deploy-board/webhook/:source`; 404 sem segredo, 401 sem assinatura válida, 413 acima do teto, 2xx para evento descartado; instância própria de `KumaRateLimiter`; log só com fonte, evento, repositório e desfecho.
- [ ] 12.2 `server/server.js`: montar o roteador **antes** do `app.use(express.json())` da linha 213 (uma linha aditiva).
- [ ] 12.3 Escrever `test/backend-test/deploy-board/test-webhook-router.js` com o app Express e o roteador montado antes de `express.json()`: os desfechos 404/401/413/2xx, um pedido JSON comum a outra rota continua chegando parseado, e o log capturado não contém trecho do corpo nem do segredo.

## 13. Correlação e cartão completo

- [ ] 13.1 No store, a correlação da spec "Pipeline e virada viram um deploy só": SHA na tag (inteiro ou prefixo ≥ 7), janela de 20 min para tag sem SHA, "sem pipeline" só com a fonte do projeto configurada, "pipeline verde, nenhuma virada vista" só com o cluster ativo.
- [ ] 13.2 Ampliar `test-store.js`: o chat com tag `prod`, o condominio com SHA completo, dois deploys do mesmo projeto sobrepostos, fonte de pipeline desligada, projeto sem origem e cluster desligado.
- [ ] 13.3 Seção de pipeline no `DeployCard.vue` (estado, jobs do GitHub, SHA e primeira linha do commit, tempo desde o merge, "pipeline verde há N min" e o texto de que a virada continua no cluster), último evento de cada webhook no rodapé e as chaves de i18n da fase.

## 14. Infraestrutura e entrega da fase 4

- [ ] 14.1 Secret com `DEPLOY_BOARD_BITBUCKET_SECRET` e `DEPLOY_BOARD_GITHUB_SECRET`, referenciado no Deployment. Publicar a versão nova do chart.
- [ ] 14.2 `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes; deploy.
- [ ] 14.3 Cadastrar os webhooks com o segredo (os cinco da fase 2 e os dos projetos da fase 3 com origem) e conferir a primeira entrega de cada um no histórico do remetente, incluindo o formato do cabeçalho de assinatura do Bitbucket.
- [ ] 14.4 Acompanhar um merge real do condominio, do push à virada concluída, e registrar os tempos observados no change.

# Fase 5 — Amplify

Exige a role IAM por IRSA e a dependência nova. Apps com branch de produção em 31/10/2026: `gatekeeper-dashboard`, `ia-frontend-document`, `pro`, `winker-app2`, `products`, `intercom-ui`, `site-novidades` e `guest-link`.

## 15. Coletor do Amplify

- [ ] 15.1 Acrescentar `@aws-sdk/client-amplify` ao `package.json` e atualizar o `package-lock.json`. Anotar o tamanho da imagem `docker/winker.dockerfile` antes e depois.
- [ ] 15.2 Criar `server/deploy-board/amplify-source.js`: descoberta de apps e branch `PRODUCTION` a cada 30 min, `ListJobs` (`maxResults: 3`) a cada 60 s ou 15 s com job em andamento, `GetJob` para os passos do job em andamento, "sem leitura" após 3 ciclos com erro, "não configurada" sem credencial ou sem `amplify.region`.
- [ ] 15.3 Escrever `test/backend-test/deploy-board/test-amplify-source.js` com o cliente do SDK substituído por dublê: branch de estágio `NONE` ignorada, troca de ritmo 60 s ↔ 15 s, passos do `GetJob`, três erros seguidos levando a "sem leitura".
- [ ] 15.4 Deploys do Amplify no store e no cartão (passos `BUILD`, `DEPLOY`, `VERIFY`), ligação de monitor pela tag `amplify/<app>` e as chaves de i18n da fase.

## 16. Infraestrutura e entrega da fase 5

- [ ] 16.1 Role IAM em `terraform/` (padrão de `terraform/iam-cost-exporter`) com `amplify:ListApps`, `amplify:ListBranches`, `amplify:ListJobs` e `amplify:GetJob`, confiando no OIDC do cluster para `monitor-infra:uptime-kuma`.
- [ ] 16.2 Anotação `eks.amazonaws.com/role-arn` na ServiceAccount e `amplify.region` no ConfigMap. Publicar a versão nova do chart.
- [ ] 16.3 `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes; deploy; conferir um build da branch de produção do `pro` no painel em até 60 s e ligar os monitores dos apps do Amplify (confirmar guest-link → "Convite" e gatekeeper-dashboard → "Portaria Web").

# Fase 6 — Conferência de cobertura

Objetivo: tudo o que roda no EKS e no Amplify está no monitoramento, ou está de fora com um motivo escrito. Um item está **coberto** quando (a) a release está na configuração do painel (EKS) ou o app tem branch de produção descoberta pelo painel (Amplify), e (b) ao menos um monitor do Kuma que confere o serviço tem a tag `deploy` apontando para o item. Tag `deploy` que aponta para algo que não roda mais é "tag órfã" e também conta como lacuna. Worker e CronJob sem endereço próprio ficam cobertos pelo monitor do projeto, com uma tag `deploy` a mais (um monitor pode ter várias).

## 17. Relatório de cobertura

- [ ] 17.1 Criar `extra/deploy-board-coverage.js`, só leitura: lê do cluster (contexto atual do `kubectl`) os Deployments, StatefulSets e CronJobs agrupados por release e o ConfigMap do painel; do Amplify (`aws amplify list-apps` e `list-branches`) os apps com branch `PRODUCTION`; e do Kuma, pela API de socket com login pedido no terminal, os monitores e as tags `deploy`. Imprime uma linha por item com os dois critérios e o monitor que o cobre, os excluídos com o motivo e as tags órfãs,, e sai com código 1 quando há lacuna fora da lista de exclusões.
- [ ] 17.2 Lista de exclusões versionada (`extra/deploy-board-coverage-exclusions.json`): cada entrada com o item (namespace inteiro ou release) e o motivo. Ponto de partida: namespaces de sistema, variantes `*-dev` e a infraestrutura listada no fim da fase 3 — cada uma revisada com o Erik antes de entrar.
- [ ] 17.3 A classificação é função pura, com teste em `test/backend-test/deploy-board/test-coverage.js`: release na config sem monitor, monitor com tag para release inexistente (tag órfã), app do Amplify sem monitor, worker coberto pela tag a mais no monitor do projeto, item excluído com e sem motivo (sem motivo não vale), e a saída sem nenhum campo de env, volume ou segredo.

## 18. Fechamento

- [ ] 18.1 Rodar contra produção e registrar a tabela neste change, com data.
- [ ] 18.2 Para cada lacuna, uma de quatro saídas, decidida com o Erik: criar o monitor no Kuma, pôr a tag `deploy`, acrescentar a release à configuração (chart novo) ou registrar a exclusão com motivo. Tags órfãs são corrigidas ou removidas.
- [ ] 18.3 Rodar de novo: zero lacunas. Registrar a data e o resultado.
