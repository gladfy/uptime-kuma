## ADDED Requirements

### Requirement: Voltar a imagem anterior, direto no cluster

O cartão de um deploy do cluster, concluído ou travado, SHALL ter um botão "Voltar para <versão>"
quando o projeto tiver `rollback: true` na configuração e houver, no histórico do painel, um deploy
anterior concluído da mesma release. Ao confirmar, o servidor SHALL trocar, em cada Deployment das
releases do deploy, só o campo `image` dos containers cuja tag mudou entre as duas versões, por um
patch que não contém nenhum outro campo. CronJobs SHALL NOT ser alterados. A volta SHALL aparecer no
painel como uma virada nova, com o rótulo "Voltando versão".

#### Scenario: Volta do condominio
- **WHEN** o deploy `9ee108f` do condominio concluiu, o anterior concluído foi `5f2c1aa`, e a pessoa confirma a volta
- **THEN** o painel troca a imagem do container da aplicação do `winker-prod` e do `winker-integration` para a tag `5f2c1aa`, sem mexer no `nginx` nem em outro campo, e o cartão "Voltando versão" aparece

#### Scenario: Sem versão anterior conhecida
- **WHEN** não há deploy anterior concluído da release no histórico do painel
- **THEN** o botão aparece desabilitado com "versão anterior desconhecida"

#### Scenario: Projeto sem rollback
- **WHEN** o projeto não tem `rollback: true` na configuração
- **THEN** o botão não aparece e o servidor recusa o pedido

### Requirement: Só com 2FA, confirmação e limite

O servidor SHALL aceitar a volta só de usuário logado no Kuma com 2FA ativo, para o id de um deploy
do estado atual do painel (nunca um nome de release enviado pelo navegador), com a confirmação
digitada igual ao nome do projeto, e no máximo uma volta por projeto a cada 5 minutos. A confirmação
SHALL mostrar a versão de origem e a de destino, as releases, que os CronJobs da release continuam na
versão nova e que o próximo deploy pela pipeline sobrescreve a volta. Com o cluster sem leitura, ou
com outra virada da mesma release em andamento, o botão SHALL ficar desabilitado.

#### Scenario: Usuário sem 2FA
- **WHEN** o usuário logado não tem 2FA ativo e pede a volta
- **THEN** o servidor recusa e o painel diz que a ação exige 2FA

#### Scenario: Duas voltas seguidas
- **WHEN** houve uma volta do condominio há 2 minutos e alguém pede outra
- **THEN** o servidor recusa e diz quando poderá de novo

### Requirement: Permissão de escrita à parte e mínima

A volta SHALL usar uma permissão própria, separada da de leitura: só `patch` em `deployments`
(apps), concedida apenas nos namespaces dos projetos com `rollback: true`. O servidor SHALL NOT ler
o template dos ReplicaSets, variáveis de ambiente, volumes ou Secrets para voltar a versão.

#### Scenario: Namespace sem rollback
- **WHEN** o projeto `temporal` não tem `rollback: true`
- **THEN** a conta de serviço do Kuma não consegue alterar Deployment no namespace `temporal`

### Requirement: Trilha de quem voltou

Toda volta SHALL gerar uma linha de log com usuário, projeto, releases, versão de origem, versão de
destino e desfecho, e o deploy de volta SHALL ficar no histórico com quem pediu e quando. O log SHALL
NOT conter o corpo do Deployment.

#### Scenario: Volta registrada
- **WHEN** o usuário `infra@winker.com.br` volta o condominio de `9ee108f` para `5f2c1aa`
- **THEN** o log tem a linha com esses dados e a lista "Hoje" mostra a volta com o usuário e o horário
