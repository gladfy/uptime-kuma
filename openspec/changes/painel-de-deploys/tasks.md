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
- [x] 8.2 Deploy, marcar os monitores com a tag `deploy` e acompanhar o próximo merge de um projeto do Bitbucket no painel: a virada aparece por release, sem o rótulo "Sem pipeline", e conclui junto com o `kubectl rollout status`.
  - 31/10/2026: deploy feito (chart 0.2.0, imagem `2.5.3-winker.18`). Tag `deploy` posta pela API do Kuma em 8 monitores da status page `winker`: Web → `condominio/winker-prod`, Web integração → `condominio/winker-integration`, Gateway (API Geral) → `gateway/gateway-prod`, Gateway Integration → `gateway/gateway-integration`, Chat → `chat/chatwoot`, Connector Access/Consumer/Queue → `connector/connector-*`. Convite e Portaria Web ficam para a fase 7 (Amplify); os outros monitores da página dependem da fase 3; Connector Geral ficou sem tag até confirmar se aponta para o EB. Falta acompanhar o próximo merge.
  - 31/10/2026 20:18 UTC: virada do `winker-prod` (commit `9ee108f`) vista no painel pelo Erik, sem "Sem pipeline". O `winker-integration` do mesmo commit (19:50) se perdeu no reinício do Kuma das 20:04 — origem da fase 3.1. Falta só comparar o fim de uma virada com o `kubectl rollout status`.
  - Botão "Deploys" no cabeçalho do Kuma (branch `feat/botao-painel-de-deploys`), abre `/deploys/winker`.
  - 03/11/2026: conferido com o merge `e1763cc` do condominio, o primeiro depois de o Kuma subir com o chart 0.5.2. O histórico do painel (print do Erik, ~14:34 UTC) mostra o deploy com 15 min, terminado "há 3 h 02 min", ou seja ~11:32 UTC. No cluster, a condição `Progressing`/`NewReplicaSetAvailable` do `winker-prod` foi às 11:32:38 UTC: o "No ar" do painel coincide com o fim da virada dentro do minuto que a tela mostra.

# Fase 3 — Cobertura do EKS

Leva ao painel as outras aplicações que rodam no EKS. Inventário de 31/10/2026 (Deployments, StatefulSets, CronJobs e Ingress do `winkernetes`): além das 12 releases da fase 2, há 18 releases em 12 namespaces (16 de aplicação e 2 de infraestrutura com monitor). Parte delas vem de repositório no CodeCommit ou de chart de infraestrutura, sem pipeline no Bitbucket nem no GitHub, por isso o projeto passa a poder existir sem fonte de pipeline.

| Projeto | Releases (`<namespace>/<release>`) | Origem da pipeline | Monitor na página `winker` |
|---|---|---|---|
| agua-gas | `microservices-prod/agua-gas` | nenhuma (CodeCommit `agua_gas_server`) | Água/Gás |
| superlogica | `microservices-prod/ms` | nenhuma (CodeCommit `microservice_superlogica`) | Superlógica |
| status | `microservices-prod/status` | nenhuma (CodeCommit `status`, `buildspec.yml`) | Status |
| integration | `microservices-prod/integration-prod`, `microservices-prod/integration-worker` | nenhuma (CodeCommit `integration`) | — |
| observer | `observer/observer-prod`, `observer/observer-worker` | Bitbucket `winker/observer` | Observer |
| site | `site-prod/site-prod` | nenhuma (CodeCommit `site`, `buildspec.yml`) | Site |
| jambonz | `jambonz-prod/jambonz-worker`, `jambonz-prod/jambonz-vad` | GitHub `gladfy/jambonz-worker`, branch `main`; o `jambonz-vad` é projeto próprio, sem origem (a imagem `tiwinker/jambonz-vad` não sai desse repositório; a confirmar) | Jambonz Worker |
| wk-face-api | `facial/wk-face-api` | nenhuma (GitHub `gladfy/wk-face-api`, workflow só de testes) | — |
| land | `land/land` | Bitbucket `winker/land`, branch `master` | — |
| chat-api | `chat-api/chat-api` | Bitbucket `winker/chat-winker`, branch `main` (02/11/2026; chart 0.5.2 corrige o `master` do 0.5.1) | — |
| ai-agents | `ai-agents-prod/ai-agents-prod` | Bitbucket `winker/ia-agents`, branch `master` | — |
| winker-mcp | `mcp-prod/winker-mcp-prod` | Bitbucket `winker/mcp-winker`, branch `master` | — |
| audit-consumer | `audit-platform/audit-consumer` | Bitbucket `winker/audit-consumer`, branch `master` | — |
| temporal | `temporal/temporal` | nenhuma (chart de infraestrutura) | Temporal |
| prefect | `big-data/prefect-server` | nenhuma (chart de infraestrutura) | Prefect |

Fora desta fase, para a conferência da fase 8 decidir: as variantes de estágio (`*-dev`), a observabilidade (Loki, Tempo, Grafana, Prometheus, Victoria Metrics, OTel), Envoy, ProxySQL, Redis/Valkey, External Secrets, OpenCost, Metabase e GLPI (estes dois sem release do Helm).

## 9. Projeto sem fonte de pipeline

- [x] 9.1 `server/deploy-board/config.js`: `source`, `repo` e `branch` passam a ser opcionais **juntos** — os três ou nenhum. Presente só parte deles, a configuração é recusada com a mensagem nomeando o campo que falta. `releases` continua obrigatório.
- [x] 9.2 No store, projeto sem origem nunca tem fonte de pipeline configurada: o cartão mostra só a virada e nunca o rótulo "Sem pipeline", mesmo depois que os segredos dos webhooks existirem (fase 4).
  - Havia um defeito escondido: com `pipelineSource` nulo, `this.sources[null]?.state !== "unconfigured"` dava `true` e o projeto sem origem ganharia "Sem pipeline". Corrigido e preso por teste com controle (o condominio, na mesma situação, ganha o rótulo); a mutação que desfaz a guarda reprova.
- [x] 9.3 Ampliar `test-config.js` (projeto sem os três campos aceito; com só `repo`, recusado nomeando `source`) e `test-store.js` (projeto sem origem, com a fonte do Bitbucket ligada, não ganha "Sem pipeline").

## 10. Infraestrutura e entrega da fase 3

- [ ] 10.1 (não bloqueia a fase 3; precisa estar resolvida antes do cadastro de webhooks da fase 4) Confirmar com o Erik as origens marcadas "a confirmar" na tabela acima. Origem desconhecida entra sem origem; ela pode ser acrescentada depois sem mudar código.
  - 02/11/2026, pelos clones locais: `land` tem pipeline no Bitbucket (`winker/land`, `master`, `helm upgrade` no `bitbucket-pipelines.yml`) e ganha origem no chart da fase 4; Status e Site fazem deploy pelo CodeCommit (`buildspec.yml`) e ficam sem origem; `wk-face-api` está no GitHub (`gladfy/wk-face-api`), mas o workflow só roda testes, sem deploy, e fica sem origem. Faltam chat-api, ai-agents, winker-mcp e audit-consumer (sem clone local) e o endereço do monitor "Flow".
  - 02/11/2026, com o Erik: `ai-agents` é Bitbucket `winker/ia-agents` e `winker-mcp` é Bitbucket `winker/mcp-winker`, os dois com deploy a partir do `master` (o `ci-scripts/build-deploy.sh` publica `ai-agents-prod` e `winker-mcp-prod`); entram com origem no chart da fase 4, junto com o `land`. O monitor "Flow" checa `https://flow.winker.com.br`, domínio do app `pro` do Amplify (`d1ymgc35qf7bzb`): tag `amplify/pro` na fase 7, não do gateway. **Pendente:** `chat-api`.
  - 02/11/2026: `audit-consumer` é Bitbucket `winker/audit-consumer`, deploy a partir do `master` (`helm upgrade --install audit-consumer -n audit-platform`); entra com origem no chart da fase 4.
  - 03/11/2026: `chat-api` é Bitbucket `winker/chat-winker`, deploy a partir da `main` (o step `main` do `bitbucket-pipelines.yml`; a `master` é outra branch), no chart 0.5.2. Resta só o `jambonz-vad`: a imagem dele não sai do `gladfy/jambonz-worker`, e ele segue sem origem até alguém dizer de onde vem.
  - No chart 0.3.0 entraram com origem só as confirmadas por clone local: `observer` (Bitbucket `winker/observer`, `master`) e `jambonz-worker` (GitHub `gladfy/jambonz-worker`, branch **`main`**). O `jambonz-vad` virou projeto próprio, sem origem, para a fase 4 não esperar pipeline do repositório do worker na virada dele. Os demais entraram sem origem.
- [x] 10.2 Chart `uptimekuma` 0.3.0: os namespaces `microservices-prod`, `observer`, `site-prod`, `jambonz-prod`, `facial`, `land`, `chat-api`, `ai-agents-prod`, `mcp-prod`, `audit-platform`, `temporal` e `big-data` em `deployBoard.namespaces` (RoleBinding e configuração da mesma lista) e os projetos da tabela em `deployBoard.projects`. `helm lint`, `helm template` e o `config.json` renderizado passando no validador da 9.1. Publicar no S3 só com o pedido do Erik.
  - Branch `feat/uptimekuma-painel-de-deploys-fase-3` do `infrastructure` (19a1140f). `helm lint` ok; `helm template` com 17 RoleBindings; `config.json` renderizado com 17 namespaces, 21 projetos e 30 releases, aceito pelo validador novo e **recusado** pelo do master (`projects[7].source`), o que confirma a ordem; as 30 releases existem no cluster. Pacote `uptimekuma-0.3.0.tgz` (sha256 `04058c8b…733fec26`) pronto, ainda não publicado. `CHART_VERSION` da pipeline do fork em 0.3.0, no mesmo PR do código.
- [x] 10.3 `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes; merge no fork e deploy (o código da 9.1 sobe **antes** do chart 0.3.0, senão a configuração nova é recusada e todas as fontes desligam).
  - 31/10/2026, local: test-backend 355/355, lint 0 erros (72 avisos, os de antes), langs ok, build ok. Falta merge e deploy.
  - 31/10/2026 20:04 UTC: deploy pela pipeline do fork com o chart 0.3.0 publicado no S3 (sha256 `04058c8b…733fec26`, `index.yaml` com 0.3.0, 0.2.0, 0.1.1 e 0.1.0) e a imagem `2.5.3-winker.20`. Log: "Watching 17 namespaces for 30 releases".
- [x] 10.4 `kubectl auth can-i --as=system:serviceaccount:monitor-infra:uptime-kuma` nos namespaces novos: lê Deployments e CronJobs; não lê Secrets nem Pods. Log do pod com o número novo de namespaces e releases, sem 403.
  - 31/10/2026: nos 12 namespaces novos e no `condominio`, `list`/`watch` de Deployments e CronJobs = yes; `get secrets`, `list pods`, `patch deployments` e `create pods/exec` = no. Fora deles (`kube-system`, `ingress`, `chat-dev`, `-A`, Secrets do cluster) = no. Nenhum 403 no log.
- [x] 10.5 Tag `deploy` pela API do Kuma nos monitores da tabela: Água/Gás → `microservices-prod/agua-gas`, Superlógica → `microservices-prod/ms`, Status → `microservices-prod/status`, Observer → `observer/observer-prod`, Site → `site-prod/site-prod`, Jambonz Worker → `jambonz-prod/jambonz-worker`, Temporal → `temporal/temporal`, Prefect → `big-data/prefect-server`. Confirmar com o Erik o endereço do monitor "Flow": se for em `api.winker.com.br`, ganha `gateway/gateway-prod`.
  - 02/11/2026: simulação do script pela API do Kuma (usuário `infra@winker.com.br`) com as 16 ligações das fases 2 e 3: 16 de 16 já com a tag `deploy` (id 61), nada a gravar. O "Flow" segue sem tag até a confirmação.
- [x] 10.6 Acompanhar a próxima virada de uma release nova no painel.
  - 02/11/2026 07:33 UTC: virada do `site-prod` (`site-winker` revisão 648, 2/2, e `site-winker-ondemand` revisão 79, 1/1, imagem `b588b70-b629`), concluída; o Kuma ficou de pé o tempo todo, sem erro do painel no log. Conferido na tela pelo Erik: "Últimas 24 horas" com `site` e a tag `b588b70-b629`, sem "Sem pipeline". O site vira todo dia nesse horário (também em 30/10 07:33 UTC), então aparece quase sempre na lista.

# Fase 3.1 — Histórico no banco

Achado de 02/11/2026: o deploy do condominio de 31/10 apareceu com uma linha só. O `winker-integration` virou às 19:50, o Kuma reiniciou às 20:04 (deploy da fase 3) e apagou o histórico em memória, e o `winker-prod` virou às 20:18. Mesmo sem o reinício seriam duas entradas: o deploy concluído sai da tela em 10 min e o agrupamento por SHA só olhava os cartões.

## 11. Gravação e carga

- [x] 11.1 Migration `db/knex_migrations/2026-11-02-1500-create-deploy-board-deploy.js` (knex, SQLite e MariaDB): `deploy_board_deploy` com `id`, `deploy_id` único, `project`, `sha`, `started_at`, `ended_at` (ms) e `data` (JSON); índice em `ended_at`.
  - `deploy_id` com 128 caracteres: índice único em utf8mb4 abaixo do limite de 767 bytes de MariaDB com formato de linha antigo. Rollback pela imagem anterior é seguro: o `server/database.js` trata migration a mais no banco ("the following files are missing") com aviso, sem derrubar o boot.
- [x] 11.2 `server/deploy-board/history-repository.js`: `load(desde)`, `save(registro)` (upsert por `deploy_id`), `prune(antes)`; gravações numa fila só; erro vira log sem o conteúdo; sem banco disponível, tudo é no-op.
- [x] 11.3 Store: o registro de histórico guarda as viradas (namespace, release, estado, réplicas, tags) sem sair pelo `snapshot()`; `onPersist` chamado quando o deploy encerra (concluído, substituído) e ao sair para o histórico; `restore(registros)` monta o histórico; identificador com o instante de criação.
- [x] 11.4 Agrupamento: virada com SHA junta ao deploy do mesmo projeto e SHA que esteja no histórico, que volta a ser cartão; mesma release no mesmo SHA abre outro deploy.
  - O deploy reaberto volta com `endedAt` nulo: sem isso, uma virada que o reabre já concluída num evento só não regravava o registro (achado pelo teste de boot com SQLite; a mutação que desfaz reprova). Ids de virada carregados ganham o sufixo `@<deploy>`, porque o contador do rastreador recomeça com o processo.
- [x] 11.5 `DeployBoard`: carga das últimas 24 h antes de ligar o cluster; limpeza de 7 dias no boot e a cada hora.
- [x] 11.6 Testes: `test-store.js` (integration e prod do mesmo commit com 26 min de intervalo viram um registro; mesma release no mesmo SHA abre outro; o registro gravado não tem campo além dos permitidos; `restore` e id sem colisão), `test-history-repository.js` com SQLite de verdade pela migration (save/upsert, load por janela, prune de 7 dias, falha de escrita sem derrubar) e o boot do `DeployBoard` com repositório.
  - 85/85 no painel. Mutações que reprovam: sem reabrir pelo histórico (2), sem renomear id de virada carregada (1), gravar só ao sair da tela (1), reaberto com o `endedAt` antigo (1).

## 12. Entrega da fase 3.1

- [x] 12.1 `npm run build`, `npm run test-backend` (inclui `test-migration.js`, que roda todas as migrations em SQLite e MariaDB), `npm run lint`, `node extra/check-lang-json.js` e `node extra/check-knex-filenames.mjs` verdes.
  - 02/11/2026, local: test-backend 367/367 (migrations ok em SQLite e em MariaDB 12), lint 0 erros (72 avisos, os de antes), langs ok, nomes de migration ok, build ok.
- [x] 12.2 Merge, deploy e conferência: o log mostra a carga do histórico; a lista "Hoje" sobrevive a um reinício; o próximo deploy do condominio aparece como uma entrada só. Conferido em 02/11/2026 com o merge `45ba525`: `winker-prod` e `winker-integration` viraram com 3 s de diferença (ReplicaSets de 19:23:32 e 19:23:35 UTC) e o cartão foi um só; o pod do Kuma reiniciou às 19:35 UTC com a `winker.28` e o boot carregou o histórico ("History loaded: 9 deploys of the last 24 hours, last version of 170 objects"); a lista continuou na tela, confirmada pelo Erik.
  - 02/11/2026 13:16 UTC: PR #8 no master, imagem `2.5.3-winker.21` no ar, migration aplicada e log "History loaded: 0 deploys of the last 24 hours" (a tabela nasceu vazia). Nenhuma virada desde então; falta ver um reinício preservar a lista e o próximo deploy do condominio sair como uma entrada só.
  - 02/11/2026: o `ai-agents-prod` virou às 13:33 UTC, foi gravado, e o reinício do Kuma às 15:09 (deploy da 3.2) o trouxe de volta: "History loaded: 1 deploys of the last 24 hours". Falta só o condominio sair como uma entrada só.

# Fase 3.2 — Indicadores e tema

Pedido do Erik em 02/11/2026. Usa o histórico que a fase 3.1 já grava; nenhuma infraestrutura nova.

## 13. Indicadores das últimas 24 horas

- [x] 13.1 Store: `stats` no `snapshot()` com a contagem das últimas 24 h por desfecho — concluídos, travados, com falha (a partir da fase 4), substituídos e em andamento — e `successRate` = concluídos ÷ (concluídos + travados + com falha), em inteiro de 0 a 100, ou `null` sem nenhum encerrado. Conta por deploy (um commit com integration e prod é um), e o deploy reaberto conta uma vez. Substituído fica fora da taxa: não deu certo nem errado, outro tomou o lugar.
- [x] 13.2 Cabeçalho do painel: "Deploys 24 h: N" e "Sucesso: 92% (11 de 12)", com o detalhe por desfecho no `title`. Sem encerrados, "Sucesso: —". O número não muda cor de nada: é contagem, não alarme.
- [x] 13.3 Testes em `test-store.js`: contagem por deploy e não por release, reaberto contado uma vez, substituído fora da taxa, janela de 24 h, `null` sem encerrados, e `stats` só com os campos permitidos.

## 14. Tema e entrega da fase 3.2

- [x] 14.1 Botão pequeno no canto do cabeçalho que alterna claro e escuro, gravando na mesma preferência do Kuma (`$root.userTheme`, a de Configurações → Aparência), então a escolha vale para aquele navegador. Rótulo acessível que diz o tema de destino; ícone de sol/lua; funciona no modo de parede.
- [x] 14.2 Chaves de i18n novas no meio dos dois json.
- [x] 14.3 `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes; conferência no navegador nos dois temas em 1920 × 1080 e em 400 px; merge e deploy.
- [x] 14.4 Revisão de wallboard (pedido do Erik em 02/11/2026): monitor no ar sem a palavra "Normal"; azul próprio para deploy em andamento nos dois lados (o magenta fica para a marca); "Sem pipeline" como etiqueta neutra ao lado do estado; triângulo além da cor no que é falha; pontos do rodapé com um significado só; "Últimas 24 horas" com ✓/✕ e os tempos numa coluna; um título no cabeçalho. Conferido no navegador nos dois temas e em 400 px.
- [x] 14.5 Painel de TV calmo (pedido do Erik em 02/11/2026, nove tarefas, uma por commit): grade de serviços numa superfície só, status como pílula dentro da linha, faixa de alerta acima da grade, cabeçalho numa barra, coluna só com o que roda e com falha, histórico em quatro colunas, botões que somem, legenda no rodapé e acabamento tipográfico. Validado em 1920 × 1080 com 34 monitores nos três estados (tudo normal, deploy rodando, serviço fora do ar), sem rolagem.
- [x] 14.6 Densidade da coluna de deploys (pedido do Erik em 03/11/2026, sete tarefas, uma por commit): com três deploys a coluna já saía da tela. `?mock=deploys&n=N` desenha N deploys fictícios (virada com réplicas parciais, pipeline com job rodando, falha, pipeline verde aguardando a virada), com selo no título; três níveis de cartão (completo, médio, compacto de 74 px) escolhidos medindo a coluna, com "+N em andamento" quando nem compactos cabem; progresso dentro da etapa atual na trilha; ordem pelo início; cabeçalho com a contagem por etapa e sem nomes; coluna em `minmax(340px, 29%)`; "em deploy" só na virada ou no passo `deploy` do Amplify. Validado em 1920 × 1080 de 0 a 6 deploys: sem rolagem, a linha do segmento Deploys numa linha só e sem corte, a falha no topo, o histórico com 4 a 8 linhas, e com 5 ou 6 a falha e as viradas no médio e o resto no compacto; em 1920 × 700, três cartões e "+3 em andamento". Em 1366 × 768 a linha do cabeçalho corta com reticências, sem quebrar.
  - 02/11/2026, local: test-backend 371/371, lint 0 erros, langs ok, build ok. Navegador (Kuma descartável com 14 deploys plantados no banco e carregados no boot): "Últimas 24 h · 14 deploys · Sucesso: 92% (11 de 12)", detalhe por desfecho no `title`, o botão alterna escuro → claro, a escolha fica em `localStorage.theme` e sobrevive ao recarregar, 400 px sem rolagem horizontal. Falta merge e deploy.

# Fase 3.3 — Deploy com o painel fora do ar

Achado de 02/11/2026: o Kuma roda com `strategy: Recreate` (volume EBS e SQLite únicos), então o pod antigo morre antes de o novo subir, e o painel nunca vê o próprio deploy. O deploy da fase 3.2 (revisão 40, `2.5.3-winker.22`, 15:09 UTC) não apareceu. O mesmo vale para qualquer deploy feito enquanto o Kuma está fora do ar.

## 15. Assinatura por objeto e virada perdida

- [x] 15.1 Migration `db/knex_migrations/2026-11-02-1700-create-deploy-board-object.js`: `deploy_board_object` com `id`, `object_key` único (`<kind>/<namespace>/<nome>`), `signature` (texto) e `seen_at` (ms).
- [x] 15.2 Repositório: `loadObjects()` e `saveObject(chave, assinatura, quando)` (upsert na mesma fila das gravações de deploy; erro vira log sem derrubar).
- [x] 15.3 Rastreador: recebe as assinaturas gravadas e avisa as novas (revisão do Deployment; tags do CronJob), sem repetir aviso da mesma assinatura. Na linha de base, objeto com assinatura diferente da gravada abre virada `missed`, que fecha na hora; revisão anterior vazia não conta.
- [x] 15.4 Store e tela: `missed` no deploy e no histórico (campo público); o cartão e a lista "Hoje" trocam a duração por "virou com o painel fora do ar".
- [x] 15.5 `DeployBoard`: carrega as assinaturas junto do histórico, antes do cluster, e grava as novas pelo repositório.
- [x] 15.6 Testes: Kuma de revisão 40 para 41 com o painel fora vira deploy concluído `missed`; mesma revisão não vira nada; primeiro boot sem gravação não vira nada; CronJob com tag nova; revisão anterior vazia; aviso sem repetição; virada `missed` com o SHA de um deploy do histórico junta a ele; repositório com SQLite de verdade.
  - 99/99 no painel. Achado no teste: na linha de base, uma virada já encerrada não republicava quando outro objeto da release se juntava (o segundo CronJob perdido não contava; a marca `missed` não saía quando outro Deployment estava virando ao vivo) — a linha de base agora recalcula como mudança o que ela tocou. Mutações que reprovam: recalcular sem mudança (2), revisão anterior vazia contando (1), `missed` não sair ao juntar ao vivo (1), sem detectar a perdida (3), aviso repetido (2).

## 16. Entrega da fase 3.3

- [x] 16.1 `npm run build`, `npm run test-backend` (com as migrations em SQLite e MariaDB), `npm run lint`, `node extra/check-lang-json.js` e `node extra/check-knex-filenames.mjs` verdes.
  - 02/11/2026, local: test-backend 381/381 (migrations ok em SQLite e MariaDB 12), lint 0 erros, langs e nomes de migration ok, build ok.
- [x] 16.2 Merge e deploy. O deploy da própria 3.3 não aparece (a tabela nasce vazia); conferir no log que as assinaturas foram gravadas e, no deploy seguinte do Kuma, que ele aparece concluído com "virou com o painel fora do ar". Conferido em 02/11/2026: o boot da `2.5.3-winker.24` carregou "last version of 170 objects" (as releases acompanhadas; 0 no boot anterior) e o cartão `uptime-kuma` apareceu com "virou com o painel fora do ar" (Erik).

# Fase 4 — Pipelines

Exige o Secret com os dois segredos e o cadastro dos webhooks: os cinco da fase 2 (três no Bitbucket, dois no GitHub) e os dos projetos da fase 3 que tiverem origem no Bitbucket ou no GitHub.

## 17. Assinatura e leitura dos eventos

- [x] 17.1 Criar `server/deploy-board/signature.js`: HMAC-SHA256 sobre o `Buffer` recebido, formato `sha256=<hex>`, `crypto.timingSafeEqual` com guarda de tamanho.
- [x] 17.2 Criar `server/deploy-board/bitbucket-events.js` e `github-events.js` (puros): `repo:push`/`push` → merge (hora, SHA, primeira linha da mensagem truncada em 120); `repo:commit_status_*` → estado da pipeline; `workflow_run` → execução; `workflow_job` → job. Filtro por repositório e branch configurados (projeto sem origem nunca casa). Só os campos da spec saem da função. Também: o SHA do Bitbucket sai de `commit.hash` ou do fim de `links.commit.href`; status sem `refname` só entra em commit já visto na branch; no GitHub, com `workflow` configurado, só esse workflow conta (o Kuma e o chat rodam testes e CodeQL na mesma master); link que não é do remetente não sai.
- [x] 17.3 Escrever `test/backend-test/deploy-board/test-signature.js` e `test-webhook-events.js`: assinatura correta, errada, ausente, de tamanho diferente e calculada sobre o JSON reserializado (tem de falhar); payloads de exemplo reais de cada evento, branch de feature e repositório fora da configuração descartados.

## 18. Roteador de webhook

- [x] 18.1 Criar `server/routers/deploy-board-webhook-router.js`: `express.raw({ type: "application/json", limit: "1mb" })` no próprio roteador, só em `/api/deploy-board/webhook/:source`; 404 sem segredo, 401 sem assinatura válida, 413 acima do teto, 2xx para evento descartado; limite por IP (o `RateLimiter` do pacote `limiter`, que está por trás do `KumaRateLimiter`, que o Kuma não exporta) antes de calcular a assinatura; 415 para conteúdo que não é JSON (o padrão de formulário do GitHub); log só com fonte, evento, repositório e desfecho.
- [x] 18.2 `server/server.js`: montar o roteador **antes** do `app.use(express.json())` da linha 213 (uma linha aditiva).
- [x] 18.3 Escrever `test/backend-test/deploy-board/test-webhook-router.js` com o app Express e o roteador montado antes de `express.json()`: os desfechos 404/401/413/2xx, um pedido JSON comum a outra rota continua chegando parseado, e o log capturado não contém trecho do corpo nem do segredo.

## 19. Correlação e cartão completo

- [x] 19.1 No store, a correlação da spec "Pipeline e virada viram um deploy só": SHA na tag (inteiro ou prefixo ≥ 7), janela de 20 min para tag sem SHA, "sem pipeline" só com a fonte do projeto configurada, "pipeline verde, nenhuma virada vista" só com o cluster ativo. Também nas duas direções: a pipeline que termina depois da virada sem SHA entra nela (a do Kuma, que é sempre vista depois do fato, e o `helm --wait` do chat); virada perdida não recebe "sem pipeline"; merge com `[skip ci]` não abre deploy, e merge cuja pipeline nunca chega some em 15 min; pipeline verde sem virada vai para o histórico depois de 1 h, como "sem virada", fora da taxa de sucesso; pipeline que falha vai como "com falha".
- [x] 19.2 Ampliar `test-store.js`: o chat com tag `prod`, o condominio com SHA completo, dois deploys do mesmo projeto sobrepostos, fonte de pipeline desligada, projeto sem origem e cluster desligado. Em `test-pipeline.js`, mais o Kuma, falha, reexecução, `[skip ci]`, status sem branch, jobs e a pipeline voltando do banco depois de um reinício.
- [x] 19.4 Correções da revisão independente (02/11/2026, antes do primeiro webhook real): evento fora de ordem não desfaz o fim, re-run por tentativa, "Cancelada" fora da taxa e sem som de falha, execução sem notícia por 2 h dada como perdida, hora do merge pela chegada, cluster sem leitura não vira "No ar", limite de 600 por minuto por IP, mais marcadores de pular a pipeline. Cada correção com teste, conferido desfazendo a correção.
- [x] 19.3 Seção de pipeline no `DeployCard.vue` (estado, jobs do GitHub, SHA e primeira linha do commit, tempo desde o merge, "pipeline verde há N min" e o texto de que a virada continua no cluster), último evento de cada webhook no rodapé e as chaves de i18n da fase. Em `sound-events.mjs`, os sons da pipeline: "iniciado" quando ela começa (hoje sai da virada), "build concluído" quando termina verde e "falhou" quando falha, com os testes em `test-sound-events.js`.
- [x] 19.5 Etapas no cartão (pedido do Erik ao ver o primeiro merge real, 02/11/2026): "Merge", "Pipeline", "Build pronto", "Virada" e "No ar", com "etapa N de M" e uma faixa por etapa, calculadas no servidor (`deploySteps`); só as etapas que as fontes do projeto veem; as anteriores puladas quando o deploy veio sem pipeline. Testes em `test-pipeline.js`; conferido no navegador com webhooks assinados e cluster simulado. No ar com a `2.5.3-winker.28`.

## 20. Infraestrutura e entrega da fase 4

- [x] 20.1 Secret com `DEPLOY_BOARD_BITBUCKET_SECRET` e `DEPLOY_BOARD_GITHUB_SECRET`, referenciado no Deployment. Publicar a versão nova do chart. Chart 0.4.0 na branch `feat/uptimekuma-painel-de-deploys-fase-4` do infrastructure: o Secret `uptime-kuma-deploy-board-webhooks` é referenciado com `optional: true` e criado à mão pelo Erik (o chart não o cria); um Ingress próprio para os dois caminhos exatos do webhook, com a lista de faixas de saída do Bitbucket e do GitHub (o Ingress principal só aceita o connector e a sede); `workflow` do chat, do Kuma e do jambonz; origem do land, ai-agents, winker-mcp e audit-consumer. Feito em 02/11/2026: Secret criado pelo Erik, chart 0.4.0 na `main` do infrastructure e publicado no S3, no ar com a `2.5.3-winker.25`; o caminho do webhook responde 403 da sede e o resto do Kuma continua com a lista de antes.
- [x] 20.2 `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes; deploy.
- [x] 20.3 Cadastrar os webhooks com o segredo (os cinco da fase 2 e os dos projetos da fase 3 com origem) e conferir a primeira entrega de cada um no histórico do remetente, incluindo o formato do cabeçalho de assinatura do Bitbucket. Cadastrados em 02/11/2026 (8 no Bitbucket, 3 no GitHub). O `ping` dos 3 do GitHub chegou com assinatura válida; a primeira entrega do Bitbucket chegou com o merge do condominio de 02/11 (push e status da pipeline, cartão "Na pipeline" com a mensagem do merge), o que confirma o cabeçalho de assinatura do Bitbucket. Falta a primeira entrega dos outros 7 repositórios do Bitbucket e conferir o `refname` do status de pipeline de pull request do condominio.
  - 03/11/2026: o webhook do `winker/chat-winker` (o nono do Bitbucket, cadastrado pelo Erik) entregou o merge de `e45dd76` às 10:17 UTC, com assinatura válida, e o painel o descartou: a configuração esperava `master`, e a produção sai da `main`. Corrigido no chart 0.5.2, no ar desde 11:20 UTC. Ainda sem entrega: connector-server, observer, land, ia-agents, mcp-winker e audit-consumer. Só o `ia-agents` teve merge na branch de deploy depois do dia do cadastro (02/11 16:02 UTC, `9ed13cf`); os outros cinco não tiveram nenhum, então esperam o próximo merge. A entrega do `ia-agents` se confere no "View requests" do webhook, porque o log do Kuma recomeça a cada deploy dele.
  - 03/11/2026 (tarde), pelo log do Kuma (pod no ar desde 15:11 UTC), sem nenhuma recusa de assinatura: `mcp-winker` (18:33 UTC), `audit-consumer` (18:33 e 18:35), `observer` (18:34) e `ia-agents` (18:35) entregaram o status da pipeline rodada pelo Erik, e o painel guardou os quatro; o `connector-server` entregou dois pushes (16:54 e 17:32 UTC), descartados por não serem da branch de deploy (a assinatura é conferida antes). Falta só o `land`, sem nenhuma entrega desde o cadastro. Do `refname` de PR do condominio há só indício: 14 status de pipeline do condominio chegaram e foram descartados, sem cartão falso, mas o log não grava o `refname`, então ele se confere no "View requests" de um status de PR.
  - 03/11/2026, 18:45 UTC: o `land` entregou o status da pipeline e o painel o guardou — os 9 do Bitbucket e os 3 do GitHub entregaram. O `refname` de PR do condominio deixa de ser pendência: a dúvida era se um status de pipeline de PR chegaria com a branch de destino e viraria cartão falso de deploy. Os 14 status do condominio de hoje foram descartados sem cartão, e o deploy real do condominio aparece certo (Erik validou), então o comportamento que importa está visto sem precisar do campo.
- [x] 20.4 Acompanhar um merge real do condominio, do push à virada concluída, e registrar os tempos observados no change.
  - 03/11/2026, merge `e1763cc` ("Merged develop into master"), horários do cluster e do histórico do painel:

    | Etapa | Hora (UTC) | Desde o merge |
    |---|---|---|
    | Merge na master | 11:16:57 | — |
    | Virada começa (ReplicaSet novo do `winker-prod`; `winker-integration` 3 s depois) | 11:23:53 | 6 min 56 s |
    | `winker-integration` concluído | 11:25:43 | 8 min 46 s |
    | `winker-prod` concluído ("No ar" no painel, ~11:32) | 11:32:38 | 15 min 41 s |

    O painel registrou 15 min de duração. A divisão entre pipeline e envio da imagem, dentro dos 6 min 56 s, fica no cartão do painel e não aparece no histórico. Os outros quatro merges do dia (`d274677` 27 min, `cd3f0ce` 17 min; `dc680b9` e `c4a465a` substituídos pelo seguinte) também estão no histórico.

# Fase 5 — Sons

Pedido do Erik em 02/11/2026: o contêiner no navio, com sons realistas, nada eletrônico nem de jogo. Feita antes da fase 4, também a pedido dele: "deploy iniciado" sai da virada enquanto não há pipeline, e "build concluído" fica pronto para quando a fase 4 trouxer a pipeline.

| Evento | Quando toca | Som |
|---|---|---|
| Deploy iniciado | a pipeline do projeto começou (fase 4); projeto sem origem de pipeline: a virada começou | toque longo de buzina de navio |
| Build concluído | a pipeline terminou verde | apito de trem a vapor (escolha do Erik) |
| Deploy em andamento | a virada começou no cluster | dois toques curtos da buzina |
| Deploy concluído | o deploy chegou a "No ar" | sino de bordo, dois toques |
| Deploy falhou | a pipeline falhou ou a virada travou | buzina mais grave e cinco toques curtos (sinal de perigo do RIPEAM) |

## 21. Eventos e síntese

- [x] 21.1 Função pura `soundEvents(anterior, atual)` (arquivo próprio em `src/components/deploy-board/`): compara dois snapshots e devolve os eventos da tabela, um por deploy e por transição. Snapshot da carga da página, da reconexão do socket ou do histórico carregado do banco **não** toca nada: só transição vista ao vivo. "Sem progresso" não toca. Projeto sem origem de pipeline: a virada que começa dispara "iniciado" e "em andamento", nessa ordem.
- [x] 21.2 Os cinco sons a partir de três gravações reais do Freesound (buzina de navio e sino CC0, apito de trem CC BY 4.0), cortadas e com volume igualado, em `src/assets/deploy-board-sounds/` com os créditos em `CREDITS.md` e o da CC BY no botão. Até ~2,6 s cada; o de falha tem 3,4 s, por causa dos cinco toques. Uma fila toca um de cada vez, e o mesmo evento do mesmo deploy na mesma etapa não repete. Os arquivos só são baixados quando o som é ativado.
- [x] 21.3 Botão "Ativar som" / "Silenciar" ao lado do de tema. O navegador só toca áudio depois de um clique na página, então o som começa desligado e a escolha fica gravada naquele navegador; na TV, ativar uma vez basta enquanto a aba estiver aberta.
- [x] 21.4 Testes da função pura (cada linha da tabela, carga e reconexão sem som, projeto sem origem, nada repetido) e conferência de ouvido de cada som com o Erik antes do merge (página de audição, 02/11: buzina h2, sino b1 e o apito de trem 170848). Os eventos da pipeline ("build concluído" e "falhou" pela pipeline) entram com a fase 4, que traz a pipeline ao snapshot: a 19.3 liga os dois e os testa.

## 22. Entrega da fase 5

- [x] 22.1 `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes; merge e deploy; acompanhar um deploy real com o som ligado. Merge e deploy feitos em 02/11/2026 (`2.5.3-winker.24`); falta ouvir um deploy real. Ouvido pelo Erik no merge do condominio de 02/11/2026.
- [x] 22.2 Som ligado por padrão (pedido do Erik em 02/11/2026): só fica desligado no navegador em que alguém silenciou. Até o primeiro clique na página, o navegador não deixa tocar, e o painel avisa ao lado do botão.
- [x] 22.3 Som que não para (relato do Erik em 02/11/2026: às vezes o som parava). As gravações ficam na memória da página, porque o nome dos arquivos muda a cada build e uma aba aberta antes de um deploy do Kuma recebia 404. Um som pausado de fora, com erro ou que passa do tempo-limite libera a fila, e o mesmo som duas vezes seguidas não se atropela. A página segura um Web Lock compartilhado para o Chrome não congelar a aba. Reproduzido no navegador antes da correção: uma pausa de fora deixou a fila parada, e nada tocou nos 50 s seguintes. Testes em `test-sound-player.js`, com um `Audio` falso que manda os eventos na ordem do navegador; cada guarda conferida desfazendo-a. Falta acompanhar a TV por alguns dias com a aba em segundo plano.

## 22b. Pipeline rodada de novo e cores do cabeçalho

Pedido do Erik em 03/11/2026, ao ver no painel o observer "levou 198 h", o audit-consumer "começou há 263 h" e em "Nenhuma virada", e o ai-agents com 26 h 39 min: as pipelines desses commits antigos foram rodadas de novo para conferir os webhooks.

- [x] 22b.1 Início da pipeline rodada de novo: o status em andamento do Bitbucket começa no `updated_on` (o `created_on` é o da primeira execução); dentro de uma execução o início não muda com o fim tardio; uma pipeline que começa depois de o deploy do commit ir ao ar é um deploy próprio (não reabre o antigo, na tela ou no histórico), e a rodada de novo depois de falha segue no cartão da falha.
- [x] 22b.2 Commit já no ar: pipeline verde de um commit que todas as releases do projeto já rodam (`ClusterTracker.commitsOf`, com o cluster ativo) conclui "No ar" na hora, sem "Nenhuma virada". Release com um objeto noutro commit, ou sem objeto lido, continua esperando a virada.
- [x] 22b.3 Decisões do Erik (03/11): a linha "Deploy de <projeto> em andamento" da faixa de queda usa a mesma regra da marca "em deploy" (só virada ou publicação do Amplify); "N em andamento" fica âmbar quando algum cartão em andamento está em âmbar; virada travada continua contando como falha na taxa. E, pedido dele, o total e a taxa das 24 h ficam âmbar abaixo de 100%.
- [x] 22b.5 Som depois da atualização do Kuma (visto pelo Erik em 03/11, 16:36): o Kuma recarrega a página quando a versão do servidor muda (`info.version` em `src/mixins/socket.js`), e depois disso o navegador só toca com um clique — na TV, ninguém clica. O aviso passa a perguntar ao navegador (`navigator.getAutoplayPolicy`, Firefox) e some quando o site pode tocar sozinho; o texto de ajuda do aviso diz como permitir. O conserto de verdade é no navegador da TV: permitir reprodução automática de áudio para o site.
- [ ] 22b.4 Deploy e conferir na TV: a próxima pipeline rodada de novo num commit em produção entra como concluída com a duração da execução, e o cabeçalho segue as cores acima.

## 22a. Sirene de serviço fora

Pedido do Erik em 03/11/2026: um som quando um serviço cai, alerta de ambulância ou bombeiro, gravação real. Das três sirenes ouvidas (ambulância, bombeiro com buzina, bombeiro alemão de dois tons), ele escolheu a terceira.

- [x] 22a.1 Função pura `servicesGoneDown(anterior, monitores)` em `src/components/deploy-board/service-alert.mjs`: toca quando um monitor passa de no ar, pendente ou manutenção para fora do ar. Sem estado anterior (carga, reconexão, novo login), de "sem batida" (o Kuma esvazia as batidas ao reconectar) e de pausado: não toca. Vários de uma vez: uma sirene. Testes em `test-service-alert.js`.
- [x] 22a.2 `service-down.mp3` (Freesound 465700, Breviceps, CC0), com o volume dos outros sons; crédito em `CREDITS.md`. O tocador ganhou `alert()`: a sirene passa na frente da fila, não corta o som que toca, entra uma vez só e não é a descartada quando a fila enche (testes em `test-sound-player.js`, conferidos por mutação).
- [x] 22a.3 Deploy e ouvir a sirene numa queda real, ou num monitor de teste apontado para um endereço que não responde, com a TV. 03/11/2026: no ar com o merge do #24; a sirene tocou na TV numa queda real do "Winker Pro" (relato do Erik).

# Fase 6 — Como voltar à versão anterior

Pedido do Erik em 02/11/2026. Decisão final (02/11): o painel **não** volta a versão; ele **mostra o comando** para quem tem acesso ao cluster copiar e rodar com a própria credencial. O Kuma continua só leitura, sem permissão nova, sem 2FA e sem ADR de exceção. O comando volta **só a imagem**, também por decisão do Erik: `kubectl set image` para a tag do deploy anterior, e não `kubectl rollout undo`, que volta o template inteiro e pode cair numa revisão que foi só um restart.

## 22c. Projeto só de pipeline (Prefect)

Pedido do Erik em 13/11/2026: o deploy do Prefect não aparecia. O deploy dos fluxos é o workflow `.github/workflows/deploy.yaml` do `gladfy/dwh` (push na `main`): ele publica a imagem `tiwinker/dwh:latest` e registra os deployments na API do Prefect, e nada vira no cluster (os CronJobs `external-flows-*` e o `prefect-work-pool` usam tag móvel). O projeto `prefect` da configuração é o chart do `prefect-server`, sem origem, e o `gladfy/dwh` não tinha webhook.

- [x] 22c.1 Projeto com origem e sem release: a pipeline verde é o fim do deploy (antes ele esperava a virada no cluster do pod e acusava "Nenhuma virada vista"). Teste em `test-pipeline.js`, que reprova sem a correção.
- [ ] 22c.2 Configuração: projeto `dwh` (github, `gladfy/dwh`, `main`, workflow `.github/workflows/deploy.yaml`, `releases: []`) no chart; publicar depois do deploy do Kuma com a 22c.1, senão a pipeline verde fica esperando virada.
- [ ] 22c.3 Webhook do `gladfy/dwh` para `/api/deploy-board/webhook/github`, com o mesmo segredo e os mesmos eventos dos outros repositórios do GitHub (`push`, `workflow_run`, `workflow_job`); conferir o próximo push na `main` no painel.

## 23. Comando para copiar

- [x] 23.1 Extração do Deployment: guardar também o nome de cada container e o repositório da imagem (sem env, volume nem nada mais do template), para montar o comando. Ampliar a asserção de `test-rollout-state.js` de que env e volumes não sobrevivem.
- [x] 23.2 Versão anterior: do histórico do painel (banco, 7 dias), o último deploy concluído da mesma release com imagem diferente; sem ele, o que estava no ar quando a virada começou (guardado pela revisão, porque o Helm troca a imagem antes de o controlador subir a revisão). Sem nenhum dos dois, o cartão diz "versão anterior desconhecida" e não mostra comando; virada que não trocou imagem diz que não há o que voltar.
- [x] 23.3 Montagem (função pura no servidor, exposta no snapshot só para quem está logado): uma linha `kubectl -n <ns> set image deployment/<nome> <container>=<repositório>:<tag anterior>` por Deployment das releases do deploy, só com os containers cuja tag mudou (o `nginx` não entra), seguida de `kubectl -n <ns> rollout status deployment/<nome>` de cada um.
- [x] 23.4 Cartão: botão "Como voltar" em deploy concluído ou travado do cluster, abrindo o comando com botão de copiar e os avisos: os CronJobs da release (o `gateway-cron` são 95) não estão no comando e ficam na versão nova; o próximo deploy pela pipeline sobrescreve a volta; quem não quiser voltar uma release apaga a linha dela.
- [x] 23.5 Testes da montagem: só containers que mudaram, release com vários Deployments (`gateway-worker`, 14), deploy sem anterior conhecido, e o comando sem nenhum campo além de namespace, nome do Deployment, container, repositório e tag. Também: restart, release só de CronJobs, histórico vencendo o que estava no ar, deploy perdido depois de reinício e valor com caractere de shell (`test-rollback.js`).

## 24. Entrega da fase 6

- [x] 24.1 Chaves de i18n; `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes; conferência no navegador (copiar funciona; 400 px sem rolagem horizontal no bloco do comando); merge e deploy.
- [x] 24.2 Conferir, com o Erik, o comando gerado para o próximo deploy do condominio contra o que ele rodaria à mão. Conferido pelo Erik no merge do condominio de 02/11/2026.

# Fase 7 — Amplify

Exige a role IAM por IRSA e a dependência nova. Apps com branch de produção em 31/10/2026: `gatekeeper-dashboard`, `ia-frontend-document`, `pro`, `winker-app2`, `products`, `intercom-ui`, `site-novidades` e `guest-link`.

## 25. Coletor do Amplify

- [x] 25.1 Acrescentar `@aws-sdk/client-amplify` ao `package.json` e atualizar o `package-lock.json`. Anotar o tamanho da imagem `docker/winker.dockerfile` antes e depois. Versão 3.1106.0, a que usa os mesmos pacotes base que o lock já tinha (a 3.1152 subia 22 deles); nenhuma versão do lock mudou, só 21 pacotes base da AWS deixaram de ser opcionais. Somam 4,9 MB antes da poda do Dockerfile; a imagem comprimida (amd64) foi de 116,6 MB na `winker.28` para 117,2 MB na `winker.30`.
- [x] 25.2 Criar `server/deploy-board/amplify-source.js`: descoberta de apps e branch `PRODUCTION` a cada 30 min, `ListJobs` (`maxResults: 3`) a cada 60 s ou 15 s com job em andamento, `GetJob` para os passos do job em andamento, "sem leitura" após 3 ciclos com erro, "não configurada" sem credencial ou sem `amplify.region`.
- [x] 25.3 Escrever `test/backend-test/deploy-board/test-amplify-source.js` com o cliente do SDK substituído por dublê: branch de estágio `NONE` ignorada, troca de ritmo 60 s ↔ 15 s, passos do `GetJob`, três erros seguidos levando a "sem leitura". São 10 testes; cada guarda conferida desfazendo-a (10 mutações, todas reprovadas, com controle sem mutação e controle com defeito grosseiro).
- [x] 25.4 Deploys do Amplify no store e no cartão (passos `BUILD`, `DEPLOY`, `VERIFY`), ligação de monitor pela tag `amplify/<app>` e as chaves de i18n da fase. Conferido no navegador com o Amplify simulado: "etapa 2 de 3" com o build rodando, os passos andando e "No ar" com o tempo de cada passo.

## 26. Infraestrutura e entrega da fase 7

- [x] 26.1 Role IAM em `terraform/` (padrão de `terraform/iam-cost-exporter`) com `amplify:ListApps`, `amplify:ListBranches`, `amplify:ListJobs` e `amplify:GetJob`, confiando no OIDC do cluster para `monitor-infra:uptime-kuma`. Escrita em `terraform/iam-uptime-kuma/main.tf` (role `uptime-kuma-irsa-role`; `ListApps` em `*`, que não aceita recurso, e as outras três só em `apps/*` de us-east-1), na branch `feat/uptimekuma-painel-de-deploys-fase-7` do infrastructure; `fmt` e `validate` verdes. Aplicada pelo Erik em 02/11/2026 (2 recursos criados, state em `s3://winker-terraform/iam-uptime-kuma`).
- [x] 26.2 Anotação `eks.amazonaws.com/role-arn` na ServiceAccount e `amplify.region` no ConfigMap. Publicar a versão nova do chart. Chart 0.5.0 na mesma branch (`helm lint`, render comparado com o 0.4.0 e o `config.json` aceito pelo validador do Kuma) e `CHART_VERSION: "0.5.0"` no workflow do Kuma. Na `main` do infrastructure (`f2ccd418`) e publicado no S3 em 02/11/2026, empacotado a partir da `origin/main`; o pacote baixado do S3 renderiza igual à `main`.
- [ ] 26.3 `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes; deploy; conferir um build da branch de produção do `pro` no painel em até 60 s e ligar os monitores dos apps do Amplify (confirmar guest-link → "Convite" e gatekeeper-dashboard → "Portaria Web"; "Flow" → `amplify/pro`, confirmado: `flow.winker.com.br` é domínio do app `pro`). No ar em 02/11/2026 com a `2.5.3-winker.30`: o pod recebeu `AWS_ROLE_ARN` e `AWS_WEB_IDENTITY_TOKEN_FILE`, e o CloudTrail mostra `ListBranches` e `ListJobs` dos 8 apps a cada minuto pela `uptime-kuma-irsa-role`, sem nenhum erro. Monitores ligados em 03/11/2026 pelo script de tags (20 de 20 com a tag `deploy`): "Flow" → `amplify/pro`, "Convite" → `amplify/guest-link`, "Portaria Web" → `amplify/gatekeeper-dashboard` e "Phone (Frontend)" → `amplify/intercom-ui`, cada um pelo domínio cadastrado no app. Falta acompanhar um build real do `pro` no painel (e conferir o link "abrir" do console). 03/11/2026: o build 380 da `main` do `pro` (commit `bdb4169`, 10:22–10:28 UTC no Amplify) está no histórico do painel com 6 min, terminado ~10:28 — mesma duração e mesmo fim do Amplify; o `gatekeeper-dashboard` (`234bc92`, 1 min) também. Faltam os 60 s, que só se veem com o painel aberto durante um build, e o clique no "abrir".

# Fase 8 — Conferência de cobertura

Objetivo: tudo o que roda no EKS e no Amplify está no monitoramento, ou está de fora com um motivo escrito. Um item está **coberto** quando (a) a release está na configuração do painel (EKS) ou o app tem branch de produção descoberta pelo painel (Amplify), e (b) ao menos um monitor do Kuma que confere o serviço tem a tag `deploy` apontando para o item. Tag `deploy` que aponta para algo que não roda mais é "tag órfã" e também conta como lacuna. Worker e CronJob sem endereço próprio ficam cobertos pelo monitor do projeto, com uma tag `deploy` a mais (um monitor pode ter várias).

## 27. Relatório de cobertura

- [ ] 27.1 Criar `extra/deploy-board-coverage.js`, só leitura: lê do cluster (contexto atual do `kubectl`) os Deployments, StatefulSets e CronJobs agrupados por release e o ConfigMap do painel; do Amplify (`aws amplify list-apps` e `list-branches`) os apps com branch `PRODUCTION`; e do Kuma, pela API de socket com login pedido no terminal, os monitores e as tags `deploy`. Imprime uma linha por item com os dois critérios e o monitor que o cobre, os excluídos com o motivo e as tags órfãs, e sai com código 1 quando há lacuna fora da lista de exclusões.
- [ ] 27.2 Lista de exclusões versionada (`extra/deploy-board-coverage-exclusions.json`): cada entrada com o item (namespace inteiro ou release) e o motivo. Ponto de partida: namespaces de sistema, variantes `*-dev` e a infraestrutura listada no fim da fase 3 — cada uma revisada com o Erik antes de entrar.
- [ ] 27.3 A classificação é função pura, com teste em `test/backend-test/deploy-board/test-coverage.js`: release na config sem monitor, monitor com tag para release inexistente (tag órfã), app do Amplify sem monitor, worker coberto pela tag a mais no monitor do projeto, item excluído com e sem motivo (sem motivo não vale), e a saída sem nenhum campo de env, volume ou segredo.

## 28. Fechamento

- [ ] 28.1 Rodar contra produção e registrar a tabela neste change, com data.
- [ ] 28.2 Para cada lacuna, uma de quatro saídas, decidida com o Erik: criar o monitor no Kuma, pôr a tag `deploy`, acrescentar a release à configuração (chart novo) ou registrar a exclusão com motivo. Tags órfãs são corrigidas ou removidas.
- [ ] 28.3 Rodar de novo: zero lacunas. Registrar a data e o resultado.

# Fase 9 — Projetos da OCI

Pedido do Erik em 02/11/2026. O `ia-rag` e o `ia-process-document` fazem o deploy num cluster OKE da Oracle Cloud, e não no EKS; o painel passa a ler o OKE também (design, decisão 19). Vem por último por ser o único caminho com credencial e rede de outra nuvem.

## 29. Inventário e acesso

- [x] 29.1 Inventário do OKE, feito por quem tem acesso a ele (esta máquina só tem o contexto do EKS): namespaces, Deployments, StatefulSets e CronJobs por release, e a tag de imagem de cada um. Registrar neste change quais releases são de projetos com pipeline (por ora `ia-rag` e `ia-process-document`, Bitbucket, branch `main`) e quais ficam sem origem. 03/11/2026, conta Winker, lida pelo `oci` desta máquina (perfil `WINKER`, só leitura, kubeconfig gerado no scratchpad): cluster `oke-winker-cluster` (v1.34.1). Com pipeline: `ia-rag-prod/rag-prod` e `ia-process-document-prod/process-doc` (e as variantes `-dev`, fora do painel como as do EKS). Sem origem confirmada: n8n, evolution-api (v1 e v2), coturn, Loki, Tempo e Prometheus. A conta Condominizar fica na 29.3.
- [x] 29.2 Responder as perguntas abertas da decisão 19: a API do OKE é pública com lista de IPs ou privada, e onde o RBAC do OKE é versionado. Sem caminho de rede do EKS até a API, a fase para aqui. 03/11/2026: na conta Winker a API é pública (`64.181.165.202:6443`) e a lista de segurança aceita a porta 6443 de `0.0.0.0/0`, então o EKS chega a ela. Não há RBAC do OKE versionado em lugar nenhum; o da leitura do painel é o template `templates/deploy-board-reader-other-cluster.yaml` do chart do Kuma (repositório `infrastructure`), gerado dos mesmos namespaces de `deployBoard.clusters` com `--set deployBoard.readerFor=oci --show-only` e aplicado no OKE. À parte: a API aceitar qualquer IP é ponto de segurança independente do painel (dá para limitar aos IPs de saída do EKS e das pipelines).
- [ ] 29.3 Conta Condominizar: o cluster `cluster-vcn-native` (v1.34.2) tem API só privada (`10.0.205.234`), e o EKS não chega a ela. Falta o Erik dizer o que roda em produção nele e precisa aparecer no painel, como é o deploy lá, e escolher o caminho: (A) endpoint público com lista só para os IPs de saída do EKS, que reaproveita esta fase sem código novo (um segundo item em `clusters`); (B) um coletor dentro do cluster que manda as viradas ao Kuma por webhook; (C) só a pipeline, descartada para a Winker pela mesma razão da decisão 19.

## 30. Segundo cluster no painel

- [x] 30.1 `clusters` opcional na configuração (`name`, `namespaces`), com validação nomeando o campo; release `oci:<namespace>/<release>` (sem prefixo continua sendo do EKS, e a configuração de hoje vale sem mudança). Ampliar `test-config.js`.
- [x] 30.2 Um `KubernetesSource` por cluster, com endereço, token e CA lidos de arquivos montados do Secret; fonte "Cluster OCI" no store e no rodapé, com estado próprio; o cluster na chave da release, do objeto (inclusive na tabela `deploy_board_object`) e da virada.
- [x] 30.3 Cartão: o cluster ao lado da release de fora do EKS; "Como voltar" com o comentário de que o comando é no cluster da OCI. Tag `deploy` dos monitores aceitando `oci:<namespace>/<release>`.
- [x] 30.4 Testes: OCI sem resposta não mexe no EKS e deixa só as releases dela sem confirmação; release de mesmo nome nos dois clusters não se confunde (nem no boot, pela tabela de objetos); um merge do `ia-rag` junta pipeline e virada do OKE pelo SHA. Em `test-other-clusters.js` (18 testes), `test-config.js` e `test-kubernetes-source.js`, sem credencial nenhuma: o OKE é um servidor HTTP local. Conferidos por mutação (12 de 13 mortas; a sobrevivente, tirar a guarda de `DEPLOY_BOARD_CLUSTERS_DIR` ausente no `index.js`, só muda a linha de log, porque o coletor já fica sem credencial), entre elas a de namespaces sem leitura misturados entre os clusters, que só morreu depois de cada cluster ter um namespace sem leitura diferente. A revisão de 03/11/2026 acrescentou: endereço da API com caminho, marca do cluster nas falhas vindas do histórico, todos os clusters sem leitura no cabeçalho, o cluster no título e nos avisos do "Como voltar", limite do nome e o formato da referência num helper só da tela (`release-ref.mjs`), amarrado ao do servidor por teste.
- [x] 30.5 Cluster na configuração e sem credencial (o Secret ainda não criado): a fonte dele fica "não configurada" e o projeto dele segue a regra de quem não tem cluster, com a pipeline verde fechando como "No ar" sem esperar virada nem acusar "Nenhuma virada vista". O endereço da API só vale com `https`, para o token nunca sair em texto aberto. O Secret é lido no boot: criado depois, só vale no próximo restart do Kuma.

## 31. Infraestrutura e entrega da fase 9

- [ ] 31.1 No OKE: ServiceAccount só de leitura (get/list/watch em `apps/deployments` e `batch/cronjobs`) com RoleBinding só nos namespaces observados, e o Secret de token dela. Manifesto: o template `templates/deploy-board-reader-other-cluster.yaml` do chart do Kuma (repositório `infrastructure`), gerado dos mesmos namespaces de `deployBoard.clusters` com `--set deployBoard.readerFor=oci --show-only` e aplicado no OKE; falta alguém com acesso ao OKE aplicá-lo lá.
- [ ] 31.2 No EKS: Secret criado à mão com o endereço da API, a CA e o token (o chart só referencia e monta); `clusters` no ConfigMap; a origem do `ia-rag` e do `ia-process-document` nos projetos. Publicar a versão nova do chart. O chart (0.6.0) já tem `clusters`, a montagem opcional do Secret e os dois projetos; faltam publicar o pacote no S3 e, depois da 31.3, criar o Secret e reiniciar o Kuma.
- [ ] 31.3 Cadastrar os webhooks do `winker/ia-rag` e do `winker/ia-process-document` no Bitbucket (mesmo segredo e gatilhos dos outros). Antes do Secret do OKE (31.2): com o Bitbucket ligado para os outros repositórios e sem o webhook do `ia-rag`, uma virada lida no OKE sairia rotulada "Sem pipeline", que é falso.
- [ ] 31.4 `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js` verdes; deploy; acompanhar um merge do `ia-rag` do merge à virada concluída no OKE.
- [ ] 31.5 Rodar a conferência de cobertura da fase 8 com o OKE incluído (o relatório recebe o contexto do OKE) e fechar as lacunas novas como na 28.2.
