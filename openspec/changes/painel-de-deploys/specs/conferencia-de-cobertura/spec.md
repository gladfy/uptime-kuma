## ADDED Requirements

### Requirement: O relatório cruza o que roda com o que é monitorado

Um relatório executado por uma pessoa SHALL listar, a partir das fontes reais:

- do EKS (contexto atual do `kubectl`), os Deployments, StatefulSets e CronJobs agrupados por
  release do Helm com a mesma regra do painel (anotação `meta.helm.sh/release-name`, depois o
  rótulo `app.kubernetes.io/instance`, depois o nome do objeto);
- do Amplify, os apps com branch em estágio `PRODUCTION`;
- da configuração do painel lida do cluster, os projetos e as releases observadas;
- do Kuma, os monitores e as tags `deploy` de cada um.

Para cada release do EKS e cada app do Amplify, o relatório SHALL mostrar se ele (a) está na
configuração do painel (EKS) ou é descoberto pelo painel (Amplify), (b) tem ao menos um monitor
cuja tag `deploy` aponta para ele, e qual. Um item SHALL contar como **coberto** quando cumpre (a) e
(b).

#### Scenario: Release monitorada
- **WHEN** a release `condominio/winker-prod` está na configuração e o monitor "Winker - Web" tem a tag `deploy` = `condominio/winker-prod`
- **THEN** o relatório mostra `condominio/winker-prod` como coberta pelo monitor "Winker - Web"

#### Scenario: Release fora da configuração
- **WHEN** a release `land/land` roda no EKS e não está em nenhum projeto da configuração
- **THEN** o relatório mostra `land/land` como lacuna "fora do painel"

#### Scenario: Release sem monitor
- **WHEN** a release `chat-api/chat-api` está na configuração e nenhum monitor tem a tag `deploy` apontando para ela
- **THEN** o relatório mostra `chat-api/chat-api` como lacuna "sem monitor"

#### Scenario: Worker coberto pelo monitor do projeto
- **WHEN** o monitor "Winker - Observer" tem duas tags `deploy`, `observer/observer-prod` e `observer/observer-worker`
- **THEN** o relatório mostra as duas releases como cobertas pelo mesmo monitor

### Requirement: Tag que aponta para o nada é lacuna

Uma tag `deploy` cujo valor não corresponde a nenhuma release que roda no EKS nem a nenhum app do
Amplify SHALL aparecer no relatório como **tag órfã**, com o monitor que a tem.

#### Scenario: Release removida do cluster
- **WHEN** o monitor "Winker - Web integração" tem a tag `deploy` = `condominio/winker-integration` e essa release não existe mais no cluster
- **THEN** o relatório mostra a tag órfã e o monitor "Winker - Web integração"

### Requirement: Exclusão só com motivo

Itens que não devem ser monitorados (namespaces de sistema, variantes de estágio, infraestrutura
sem deploy de aplicação) SHALL ficar numa lista versionada, cada entrada com o item (namespace
inteiro ou release) e o motivo. Entrada sem motivo SHALL ser ignorada e o item SHALL continuar como
lacuna. O relatório SHALL mostrar os itens excluídos separados, com o motivo.

#### Scenario: Variante de estágio excluída
- **WHEN** o namespace `chat-dev` está na lista de exclusões com o motivo "estágio, sem monitor de produção"
- **THEN** as releases de `chat-dev` aparecem como excluídas, com o motivo, e não como lacuna

#### Scenario: Exclusão sem motivo
- **WHEN** a release `glpi/glpi` está na lista de exclusões com o motivo vazio
- **THEN** o relatório continua mostrando `glpi/glpi` como lacuna

### Requirement: Só leitura e sem segredo na saída

O relatório SHALL NOT escrever no cluster, no Amplify nem no Kuma. A senha do Kuma SHALL ser pedida
no terminal, sem eco, e SHALL NOT ser gravada nem impressa. Da leitura do cluster SHALL sair só
namespace, nome, tipo e release de cada objeto; variáveis de ambiente, volumes e Secrets SHALL NOT
aparecer na saída.

#### Scenario: Deployment com credencial no template
- **WHEN** um Deployment lido tem variáveis de ambiente com credenciais
- **THEN** nenhum valor delas aparece na saída do relatório

### Requirement: Código de saída que permite repetir

O relatório SHALL sair com código 0 quando não houver lacuna nem tag órfã fora das exclusões, e com
código 1 caso contrário, para poder ser repetido a cada aplicação nova no EKS ou no Amplify.

#### Scenario: Tudo coberto
- **WHEN** todas as releases e apps estão cobertos ou excluídos com motivo e não há tag órfã
- **THEN** o relatório termina com código 0
