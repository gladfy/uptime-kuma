## ADDED Requirements

### Requirement: Opção "Mostrar monitores do grupo" por linha da status page
Cada monitor adicionado a uma status page DEVE (MUST) ter a opção `show_children`, persistida em
`monitor_group.show_children` (boolean, default `false`), editável pelo diálogo de
configurações do monitor na status page e visível apenas quando o monitor é do tipo
`group`. O default DEVE preservar o comportamento atual das páginas existentes.

#### Scenario: Checkbox aparece só para monitor tipo grupo
- **WHEN** o diálogo de configurações é aberto para um monitor tipo `group` na edição da status page
- **THEN** o checkbox "Mostrar monitores do grupo" é exibido, refletindo o valor salvo

#### Scenario: Monitor comum não expõe a opção
- **WHEN** o diálogo é aberto para um monitor que não é do tipo `group`
- **THEN** o checkbox não é exibido e o save não grava `show_children` diferente de `false`

#### Scenario: Persistência no save da página
- **WHEN** a status page é salva com a opção ligada num grupo
- **THEN** a linha correspondente em `monitor_group` fica com `show_children = 1` e o
  editor reaberto (`getStatusPage`) devolve o campo com o valor salvo

### Requirement: Serialização pública expande filhos diretos do grupo
`Group.toPublicJSON` DEVE (MUST) anexar `childrenList` ao objeto público de um monitor quando a
linha tem `show_children = 1` e o monitor é tipo `group`, contendo os filhos diretos
ativos (`parent = id do grupo` e `active = 1`), cada um com `id`, `name` e `type` (o
status visual vem dos heartbeats públicos, como nas linhas normais) — e NUNCA `url`,
`customUrl`, `send_url` ou qualquer campo de configuração. A linha do grupo DEVE expor
`showChildren` no JSON público, porque o editor carrega dessa API e o save round-tripa
o objeto.

#### Scenario: Grupo expandido lista os filhos ativos
- **WHEN** a página pública é montada para um grupo com `show_children = 1` e 3 filhos ativos
- **THEN** o objeto do grupo traz `childrenList` com os 3 filhos, cada um com id e nome

#### Scenario: Filho pausado fica de fora
- **WHEN** um dos filhos do grupo expandido está pausado (`active = 0`)
- **THEN** ele não aparece em `childrenList`

#### Scenario: URL do filho nunca vaza
- **WHEN** um filho do grupo expandido tem `url` configurada no monitor
- **THEN** o JSON público do filho não contém `url` nem `customUrl`, independentemente de
  qualquer flag

#### Scenario: Flag desligada preserva o comportamento atual
- **WHEN** o grupo está na página com `show_children = 0`
- **THEN** o objeto público do grupo não tem `childrenList` (idêntico ao formato atual)

### Requirement: Heartbeats públicos incluem os filhos expandidos
O endpoint `GET /api/status-page/heartbeat/:slug` DEVE (MUST) incluir em `heartbeatList` e
`uptimeList` os filhos diretos ativos de cada grupo com `show_children = 1` na página,
além dos monitores já listados por `monitor_group`.

#### Scenario: Filho expandido tem heartbeats e uptime próprios
- **WHEN** o endpoint é chamado para uma página com grupo expandido cujos filhos têm heartbeats
- **THEN** a resposta contém `heartbeatList[<id do filho>]` e `uptimeList[<id do filho>_24]`

#### Scenario: Filho listado também individualmente não duplica
- **WHEN** um filho do grupo expandido também tem linha própria em `monitor_group` da mesma página
- **THEN** ele aparece uma única vez na resposta (ids deduplicados)

#### Scenario: Flag desligada não inclui filhos
- **WHEN** o endpoint é chamado para uma página cujo grupo tem `show_children = 0`
- **THEN** a resposta contém apenas os monitores com linha em `monitor_group`

### Requirement: Renderização aninhada na página pública
A página pública DEVE (MUST) renderizar os filhos de um grupo expandido como sub-lista indentada
sob a linha do grupo, cada filho com nome, HeartbeatBar e uptime — sem link, sem controles
de edição individuais. Em modo de edição, a sub-lista é somente-leitura (os filhos seguem
o grupo; não são removíveis nem reordenáveis individualmente).

#### Scenario: Filhos visíveis sob o grupo
- **WHEN** um visitante abre a status page com um grupo expandido
- **THEN** vê a linha do grupo (status agregado) e, aninhadas, as linhas dos filhos com
  heartbeat e uptime individuais

#### Scenario: Serviço novo no grupo aparece sem editar a página
- **WHEN** um monitor novo é criado com `parent` = o grupo expandido, após a página já publicada
- **THEN** a página pública passa a listá-lo sob o grupo sem qualquer edição da status page,
  respeitado o TTL do cache público (5 min na página, 1 min nos heartbeats — o mesmo de
  qualquer mudança; salvar a página limpa o cache na hora)

### Requirement: Migration compatível com SQLite e MySQL
A coluna `monitor_group.show_children` DEVE (MUST) ser criada por migration knex
(boolean, `notNullable`, `defaultTo(false)`), sem check constraint, funcionando em SQLite
e MySQL, com nome de arquivo no padrão validado pelo CI (`check-knex-filenames.mjs`).

#### Scenario: Migration roda nos dois bancos
- **WHEN** o boot roda as migrations em uma instalação SQLite e em uma MySQL
- **THEN** a coluna existe com default 0 nos dois, e linhas pré-existentes de
  `monitor_group` continuam com o comportamento antigo
