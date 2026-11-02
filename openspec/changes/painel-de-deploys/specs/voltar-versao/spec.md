## ADDED Requirements

### Requirement: O cartão mostra o comando que volta a imagem anterior

O cartão de um deploy do cluster, concluído ou travado, SHALL ter um botão "Como voltar" quando
houver, no histórico do painel, um deploy anterior concluído da mesma release. O botão SHALL abrir,
pronto para copiar, uma linha `kubectl -n <namespace> set image deployment/<nome>
<container>=<repositório>:<tag anterior>` por Deployment das releases do deploy, só com os containers
cuja tag mudou entre as duas versões, seguida de `kubectl -n <namespace> rollout status
deployment/<nome>` de cada um. O painel SHALL NOT executar o comando nem ter permissão para isso.

#### Scenario: Comando do condominio
- **WHEN** o deploy `9ee108f` do condominio concluiu e o anterior concluído foi `5f2c1aa`
- **THEN** "Como voltar" mostra uma linha `set image` para o `winker-prod` e outra para o `winker-integration`, só com o container da aplicação e a tag `5f2c1aa`, sem o `nginx`, e as linhas de `rollout status`

#### Scenario: Release com vários Deployments
- **WHEN** o deploy do api_gateway inclui a release `gateway-worker`, com 14 Deployments
- **THEN** o comando tem uma linha `set image` por Deployment dela, e copiar leva todas

#### Scenario: Sem versão anterior conhecida
- **WHEN** não há deploy anterior concluído da release no histórico do painel
- **THEN** o cartão diz "versão anterior desconhecida" e não mostra comando

### Requirement: O cartão diz o que o comando não cobre

Junto do comando, o cartão SHALL avisar que os CronJobs da release não estão no comando e continuam
na imagem nova, e que o próximo deploy pela pipeline sobrescreve a volta.

#### Scenario: gateway-cron
- **WHEN** o deploy do api_gateway inclui a release `gateway-cron`, de 95 CronJobs
- **THEN** o aviso diz que os 95 CronJobs ficam na imagem nova

### Requirement: Só o necessário no comando

O comando SHALL conter só namespace, nome do Deployment, nome do container, repositório da imagem e
tag. Nenhum outro campo do Deployment (variáveis de ambiente, volumes, anotações) SHALL ser guardado
para montá-lo nem aparecer na tela. O comando SHALL sair só para socket logado, como o resto do
estado do painel.

#### Scenario: Deployment com credencial no template
- **WHEN** um Deployment observado tem variáveis de ambiente com credenciais
- **THEN** nenhum valor delas aparece no comando, no estado em memória nem no histórico gravado
