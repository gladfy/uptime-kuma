## Why

Quando alguém faz merge no master, ninguém acompanha a virada no Kubernetes. Nos três repositórios
do Bitbucket (condominio, api_gateway, connector-server) e no chat, o `helm upgrade` roda **sem
`--wait`**: a pipeline fica verde assim que o Helm entrega os manifestos, e os pods trocam depois.
Medido em 29/10/2026 no condominio: merge 13:13 UTC, pipeline verde 13:20, último pod pronto 13:32.
Foram 12 minutos de virada sem ninguém olhando, e uma virada travada passaria verde do mesmo jeito.

O time quer uma tela de parede que junte as duas coisas: o que está sendo publicado (pipeline e
virada) e se os serviços estão de pé (Kuma). O protótipo validou a ideia e mostrou o limite: com
os deploys em cima, os 34 monitores ficaram pequenos e paginados. O painel de TV que já existe
(`/status/<slug>/tv`) tem outro propósito, e misturar os dois estragaria os dois.

## What Changes

- **Página logada nova `/deploys/<slug>`**, em tela cheia e separada da TV, em duas colunas:
  deploys numa coluna estreita à esquerda e os monitores da status page `<slug>` em cerca de 70% da
  largura à direita. Os 34 monitores da status page `winker` cabem numa TV 1080p sem paginar.
  A página só abre com login no Kuma. A coluna de deploys cabe na tela com vários deploys ao
  mesmo tempo: cada cartão tem três níveis (completo, médio e compacto), escolhidos medindo a
  coluna, e o cabeçalho resume quantos estão em cada etapa.
- **Virada lida do cluster.** O servidor do Kuma passa a observar os Deployments e os CronJobs dos
  namespaces configurados, com permissão **só de leitura**, e detecta a virada pela revisão do
  Deployment, não pela tag da imagem (o chat publica sempre `tiwinker/chatwoot:prod`). Estados:
  atualizando, sem progresso, travado (`ProgressDeadlineExceeded`) e concluído, por release do Helm.
- **Pipeline por webhook.** Rotas novas recebem webhooks do Bitbucket (`repo:push`,
  `repo:commit_status_*`) e do GitHub (`push`, `workflow_run`, `workflow_job`), conferidos por
  assinatura HMAC sobre o corpo cru. Sem segredo configurado, a rota não existe (404).
- **Jobs do Amplify por consulta.** O servidor consulta os jobs da branch de produção de cada app
  do Amplify (descoberta automática pelo estágio `PRODUCTION`), com permissão AWS só de leitura
  dada ao pod por IRSA.
- **Projeto sem pipeline.** Repositório no CodeCommit e chart de infraestrutura (Temporal, Prefect)
  também têm virada no EKS. O projeto pode ser configurado sem origem de pipeline: o cartão mostra
  só a virada e nunca o rótulo "Sem pipeline".
- **Histórico no banco do Kuma.** Os deploys encerrados ficam numa tabela própria do fork, por 7
  dias, e voltam à tela depois de um reinício; uma virada com o mesmo SHA de um deploy já encerrado
  junta a ele em vez de abrir outro.
- **Indicadores e tema.** O cabeçalho mostra quantos deploys houve nas últimas 24 h e a taxa de
  sucesso, e um botão pequeno alterna o tema claro e escuro.
- **Sons.** Cinco sons do tema "contêiner no navio" marcam o início, o build, a virada, a conclusão e
  a falha do deploy: gravações reais de buzina de navio, apito de trem e sino de bordo, ligadas por
  padrão, com um botão para silenciar.
- **Como voltar à versão anterior.** No cartão, um botão mostra o comando `kubectl set image` que
  volta a imagem do deploy anterior, pronto para copiar. O painel não executa nada.
- **Conferência de cobertura.** Um relatório só de leitura compara o que roda no EKS e no Amplify com
  a configuração do painel e as tags dos monitores do Kuma, e aponta o que está sem monitoramento.
- **Projetos da OCI.** O `ia-rag` e o `ia-process-document` (e o que mais o inventário achar) fazem
  o deploy num cluster Kubernetes da Oracle Cloud (OKE), não no EKS. O painel passa a ler também esse
  cluster, só leitura, para a virada deles aparecer como a do EKS; os webhooks dos repositórios deles
  ligam a pipeline ao cartão, e a conferência de cobertura passa a incluir o OKE.
- **Correlação** entre pipeline e virada pelo SHA do commit na tag da imagem; quando a tag não
  carrega SHA, pela janela de tempo da pipeline do mesmo repositório. Virada sem pipeline
  correspondente aparece como "sem pipeline" (deploy manual).
- **Ligação monitor ↔ release por tag do Kuma** (`deploy` = `<namespace>/<release>` ou
  `amplify/<app>`), editável na tela do monitor, sem deploy. É ela que faz o monitor mostrar
  "em deploy" e o destaque de queda dizer se a queda começou logo depois de uma virada.
- **A saúde do serviço vem só do Kuma.** Virada travada não pinta o monitor de vermelho, porque a
  versão anterior continua atendendo. Esse foi o erro do protótipo.

## Fases de entrega

A implementação sai em nove fases, mais três intermediárias (3.1, 3.2 e 3.3). Cada uma vai para produção sozinha, com só a infraestrutura
dela, e a seguinte não muda o que a anterior entregou.

| Fase | O que entra em produção | Infraestrutura e configuração |
|---|---|---|
| **1. Página e monitores** | `/deploys/<slug>` com login, duas colunas, monitores ao vivo e destaque de queda; a coluna de deploys mostra as fontes como "não configurada" | Nenhuma |
| **2. Virada no cluster** | A virada de cada release, ao vivo; a marca "em deploy" e a correlação de queda nos monitores com a tag `deploy` | ServiceAccount do Kuma, leitura em 5 namespaces, ConfigMap com namespaces e projetos; marcar os monitores |
| **3. Cobertura do EKS** | A virada das outras 18 releases do EKS (microsserviços, observer, site, jambonz, face-api, land, chat-api, ai-agents, mcp, audit-consumer, temporal, prefect); projeto sem origem de pipeline | Leitura em mais 12 namespaces e os projetos novos no ConfigMap; marcar os monitores |
| **3.1 Histórico no banco** | O histórico sobrevive ao reinício do Kuma (7 dias no banco, 24 h na tela); o integration e o prod do mesmo commit viram um registro só | Nenhuma; uma tabela nova do fork, por migration |
| **3.2 Indicadores e tema** | Deploys das últimas 24 h e taxa de sucesso no cabeçalho; botão de tema claro/escuro | Nenhuma |
| **3.3 Deploy com o painel fora do ar** | O deploy do próprio Kuma, e qualquer outro que aconteça com ele fora do ar, aparece depois do boot, concluído e sem duração | Nenhuma; uma tabela nova do fork |
| **4. Pipelines** | Merge, pipeline e virada num cartão só; jobs do GitHub | Secret com os segredos; cadastro dos webhooks (os 5 da fase 2 e os dos projetos da fase 3 com origem no Bitbucket ou no GitHub) |
| **5. Sons** | Gravações reais (buzina de navio, apito de trem, sino de bordo) nos eventos do deploy, ligadas por padrão, com botão de silenciar | Nenhuma |
| **6. Como voltar à versão anterior** | Botão no cartão com o comando que volta a imagem anterior, para copiar | Nenhuma |
| **7. Amplify** | Os 8 apps do Amplify, com passos do job | Role IAM por IRSA e anotação na ServiceAccount |
| **8. Conferência de cobertura** | Relatório que cruza EKS e Amplify com a configuração do painel e as tags do Kuma; lacunas fechadas ou excluídas com motivo | Nenhuma nova; criar monitores e tags que faltarem |
| **9. Projetos da OCI** | A virada do `ia-rag`, do `ia-process-document` e do que mais rodar no OKE, com a pipeline deles no mesmo cartão; o OKE na conferência de cobertura | ServiceAccount só de leitura no OKE, credencial dela num Secret do EKS, caminho de rede do EKS até a API do OKE; cadastrar os webhooks dos repositórios da OCI |

## Onde estamos (03/11/2026)

No ar a imagem `2.5.3-winker.36` e o chart `uptimekuma` 0.5.2. As fases 1 a 7 estão em produção,
e a tela de parede ganhou dois refinamentos fora das fases: o painel calmo (14.5) e a coluna de
deploys que cabe com até seis deploys em 1920 × 1080 (14.6). A 8 é a próxima; a 9 está bloqueada.
Uma fase só se fecha quando a conferência com deploy real também foi feita (as tarefas com o número
entre parênteses).

| Fase | Situação | O que falta |
|---|---|---|
| 1. Página e monitores | Em produção | Nada |
| 2. Virada no cluster | Em produção; 20 monitores da `winker` com a tag `deploy` | Comparar o fim de uma virada com o `kubectl rollout status` num merge real (8.2) |
| 3. Cobertura do EKS | Em produção: 17 namespaces, 30 releases, 21 projetos (12 com origem de pipeline) | Origem do `jambonz-vad`, o único sem resposta (10.1); até lá ele aparece só com a virada |
| 3.1 Histórico no banco | Em produção | Nada |
| 3.2 Indicadores e tema | Em produção | Nada |
| 3.3 Painel fora do ar | Em produção | Nada |
| 4. Pipelines | Em produção, com 9 webhooks no Bitbucket e 3 no GitHub. Já entregaram: condominio, api_gateway e chat-winker (Bitbucket) e os 3 do GitHub. O chat-winker chegou em 03/11 e foi descartado, porque o painel esperava a branch `master` e a produção sai da `main`; corrigido no chart 0.5.2 | A primeira entrega aceita do chat-winker e a primeira dos outros 6 do Bitbucket, mais o `refname` da pipeline de pull request (20.3); um merge do condominio acompanhado até a virada concluída, com os tempos (20.4) |
| 5. Sons | Em produção | Nada |
| 6. Como voltar | Em produção | Nada |
| 7. Amplify | Em produção; os 8 apps lidos pela role, sem erro; "Flow", "Convite", "Portaria Web" e "Phone (Frontend)" ligados aos apps (03/11) | Acompanhar um build real do `pro` no painel e conferir o link "abrir" (26.3) |
| 8. Conferência de cobertura | Não começada; é a próxima | Tudo (27 e 28) |
| 9. Projetos da OCI | Código pronto (03/11/2026); conta Winker sem credencial ainda | ServiceAccount de leitura no OKE, Secret no EKS e webhooks dos dois repositórios (31.1 a 31.3); a conta Condominizar espera decisão (29.3) |

Dos 6 repositórios do Bitbucket que ainda não entregaram, 5 não tiveram merge na branch de deploy
desde o cadastro (connector-server, observer, land, mcp-winker e audit-consumer); a entrega vem com o
próximo. O `ia-agents` teve um merge em 02/11 às 16:02 UTC, que os logs do Kuma, refeitos a cada
deploy dele, já não mostram: a conferência é no "View requests" do webhook no Bitbucket.

As conferências que faltam nas fases 2 e 4 (8.2 e 20.4) dependem do mesmo evento: um merge do
condominio acompanhado no painel do push até "No ar", comparando o fim com o `kubectl rollout status`.

A ordem segue valor e custo: a virada é o que ninguém vê hoje e só precisa de permissão no
cluster, e a fase 3 estende o mesmo coletor ao resto do EKS sem código novo além da origem
opcional; os webhooks exigem rota pública e cadastro em vários repositórios; o Amplify é
independente e é a única fase com IAM e dependência nova. A conferência fica depois das fontes
porque só faz sentido com elas ligadas: ela mede o que as anteriores deixaram de fora. A OCI vem por
último, a pedido do Erik (02/11/2026): é o único caminho que pede credencial e rede de outra nuvem, e
a fase 9 refaz a conferência com o OKE incluído.

## Capabilities

### New Capabilities

- `painel-de-deploys`: a página `/deploys/<slug>` — acesso só com login, as duas colunas, a lista
  de monitores tirada da curadoria da status page, os estados dos deploys e dos monitores, a
  ligação monitor ↔ release e o aviso quando uma fonte de dado para de responder.
- `deploys-no-cluster`: observação dos Deployments e CronJobs no EKS, detecção da virada por
  revisão, estados por release e a permissão só de leitura que isso exige.
- `deploys-de-pipeline`: webhooks assinados do Bitbucket e do GitHub, consulta dos jobs do Amplify
  e a correlação de pipeline com virada.
- `voltar-versao`: o comando de voltar à imagem anterior que o cartão mostra, de onde vem a versão
  anterior e o que o comando não cobre.
- `conferencia-de-cobertura`: o relatório que cruza o que roda no EKS e no Amplify com a
  configuração do painel e as tags dos monitores, e a lista de exclusões com motivo.
- `deploys-na-oci`: a leitura do cluster OKE da Oracle Cloud ao lado do EKS, a credencial só de
  leitura que isso exige, a identificação do cluster em cada release e o que acontece quando a OCI
  não responde.

### Modified Capabilities

Nenhuma. `openspec/specs/` está vazio, e a mudança não altera requisito da status page nem da TV.

## Impact

**Candidatura a upstream:** não — **exclusiva do fork**. O upstream não tem o caso de uso
(pipelines e cluster de uma empresa específica), e a página depende de infraestrutura nossa.

**Arquivos quentes do upstream tocados** (custo de merge):
- `server/server.js` — três inserções de uma linha, todas aditivas: montar o roteador de webhook
  **antes** do `app.use(express.json())` da linha 213 (a assinatura HMAC precisa do corpo cru, e o
  parser global o consome), registrar o socket handler na lista da linha ~1733 e iniciar os
  coletores no boot.
- `src/router.js` — uma rota nova, com import lazy.
- `src/lang/en.json` e `src/lang/pt-BR.json` — chaves novas no meio do arquivo.
- `package.json` / `package-lock.json` — dependência nova `@aws-sdk/client-amplify`.
- `db/knex_migrations/` — uma migration nova do fork (tabela `deploy_board_deploy`), arquivo novo.
- `src/mixins/socket.js` **não** muda: a rota fica fora de `/status`, então o socket abre normalmente.
- Todo o resto é arquivo novo (`server/deploy-board/`, roteador, socket handler, página, testes e,
  na fase 8, `extra/deploy-board-coverage.js` com a lista de exclusões).

**Infraestrutura** (repositório `infrastructure`):
- chart `helm-packages/tools/uptimekuma`: ServiceAccount própria para o Kuma (hoje ele roda com a
  `default`), ClusterRole de leitura de Deployments e CronJobs ligada por RoleBinding só nos
  namespaces observados (5 na fase 2, 17 a partir da fase 3), ConfigMap com a configuração, Secret
  com os segredos dos webhooks e, na fase 7, a anotação de IRSA na ServiceAccount; na fase 9, a
  montagem da credencial do OKE (Secret criado à mão, como o dos webhooks);
- `terraform/`: a role IAM com as quatro ações de leitura do Amplify, no padrão de
  `terraform/iam-cost-exporter`.

**OCI (fase 9):** ServiceAccount no OKE com leitura de Deployments e CronJobs só nos namespaces
observados, e o caminho de rede do EKS até a API do OKE (endpoint público com lista de IPs de saída
do EKS, ou rota privada). Onde isso é versionado do lado da OCI ainda é pergunta aberta.

**Configuração fora do código:** cadastrar os webhooks nos repositórios com origem no Bitbucket ou
no GitHub (os cinco da fase 2 e os da fase 3) apontando para `monitor-clientes.winker.com.br`,
marcar os monitores com a tag `deploy` e, na fase 8, criar os monitores que a conferência apontar
como faltando.

## Fora de escopo

- **Passos da pipeline no Bitbucket.** O webhook do Bitbucket só informa o estado da pipeline
  inteira; os passos ("Build & Push Docker", "Deploy") exigiriam consultar a API com um token. O
  painel infere a etapa pelo cluster (imagem nova aplicada = passou do deploy). No GitHub os jobs
  chegam pelo `workflow_job`.
- **Ações.** O painel só mostra; não dispara, cancela nem desfaz deploy. Para voltar a versão ele
  mostra o comando (fase 6), e quem roda é quem tem acesso ao cluster.
- **Notificação de deploy** pelos providers do Kuma.
- **Ambientes Elastic Beanstalk.** (O OKE da OCI entrou como fase 9.)
- **Alterar a status page do cliente ou a TV.** As duas continuam como estão.
- **Colocar `--wait` nas pipelines dos outros repositórios.** É mudança nas pipelines, não no Kuma;
  o painel mostra a virada com ou sem ele.

## Pendências futuras

- **Passos da pipeline do Bitbucket por API.** Revisar quando a falta de saber em que passo a
  pipeline falhou atrapalhar um diagnóstico.
- **O próprio deploy do Kuma não aparece ao vivo:** o pod reinicia (réplica única com volume). Desde a
  fase 3.3 ele aparece depois do boot, concluído e sem duração. Revisar se o Kuma passar a ter mais de
  uma réplica.
- **Webhooks no domínio dos clientes.** As rotas ficam em `monitor-clientes.winker.com.br`,
  protegidas por assinatura e limite de taxa. Revisar quando houver um host interno para o Kuma.
