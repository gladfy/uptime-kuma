## ADDED Requirements

### Requirement: Um endpoint só entrega tudo que o painel precisa

O sistema SHALL expor um endpoint público, derivado de um slug de status page, cuja resposta
única traz a lista de monitores do painel (identificador, nome e tipo) e, por monitor: o estado
do último heartbeat, os heartbeats recentes (com `status` e `time`) e — quando o monitor não está
`UP` — um **rótulo de erro saneado**.

A lista e as batidas SHALL vir da mesma resposta, sob o mesmo cache. Compor o painel a partir de
dois endpoints com caches diferentes faz um monitor recém-adicionado ter batida e não ter linha,
sumindo da tela sem erro.

O endpoint SHALL manter `Heartbeat.toPublicJSON()` intocado: o endpoint público existente
(`/api/status-page/heartbeat/:slug`) continua sem `msg`, como está hoje.

#### Scenario: Monitor fora do ar tem rótulo
- **WHEN** o painel consulta o endpoint e um monitor do slug está em `DOWN`
- **THEN** a resposta traz, para aquele monitor, o nome, o estado, os heartbeats recentes e o rótulo de erro saneado

#### Scenario: Lista e batidas chegam juntas
- **WHEN** um monitor é adicionado à status page do slug
- **THEN** na resposta seguinte do endpoint ele aparece com linha e batidas ao mesmo tempo, nunca com uma sem a outra

#### Scenario: O endpoint existente não muda
- **WHEN** `/api/status-page/heartbeat/:slug` é consultado
- **THEN** a resposta continua sem campo de mensagem, idêntica ao comportamento do upstream

### Requirement: O saneamento é uma allowlist que renderiza rótulo

O sistema SHALL derivar o rótulo a partir do padrão reconhecido na mensagem do heartbeat,
**renderizando um texto próprio**, e SHALL NOT repassar a mensagem original — nem inteira, nem em
parte, nem como fallback.

Todo padrão não reconhecido SHALL resultar num rótulo genérico (default deny).

#### Scenario: Status HTTP recusado vira rótulo com o código
- **WHEN** a mensagem do heartbeat é `Request failed with status code 502`
- **THEN** o rótulo é `HTTP 502 · Bad Gateway`

#### Scenario: Timeout vira rótulo com o tempo
- **WHEN** a mensagem do heartbeat é `timeout by AbortSignal (30s)`
- **THEN** o rótulo é `timeout 30s`

#### Scenario: Conexão recusada não leva endereço
- **WHEN** a mensagem do heartbeat é `connect ECONNREFUSED 10.0.3.14:5432`
- **THEN** o rótulo é `Conexão recusada` e não contém `10.0.3.14` nem `5432`

#### Scenario: Host não resolvido não leva o host
- **WHEN** a mensagem do heartbeat é `getaddrinfo ENOTFOUND api-interna.winker.local`
- **THEN** o rótulo é `Host não encontrado` e não contém `api-interna.winker.local`

#### Scenario: Mensagem desconhecida cai no default deny
- **WHEN** a mensagem do heartbeat é uma string que nenhum padrão da allowlist reconhece
- **THEN** o rótulo é o genérico (`Sem resposta`) e nenhum trecho da mensagem original aparece na resposta

#### Scenario: Mensagem vazia ou ausente
- **WHEN** o heartbeat não tem mensagem
- **THEN** o rótulo é o genérico, sem erro na requisição

### Requirement: Nenhum identificador de infraestrutura sai no rótulo

O conjunto de rótulos que o saneador pode produzir SHALL ser fechado e conhecido, e nenhum deles
SHALL conter host, domínio, endereço IP, porta, caminho de URL, query de banco, nome de usuário
ou trecho de stack trace.

#### Scenario: A saída pertence ao conjunto fechado
- **WHEN** o saneador é exercitado com qualquer entrada
- **THEN** o valor devolvido é um dos rótulos declarados, e nenhum outro

#### Scenario: Entrada com credencial embutida
- **WHEN** a mensagem do heartbeat contém uma URL com usuário e senha
- **THEN** o rótulo devolvido não contém nenhum trecho dessa URL

### Requirement: Só monitor fora do normal carrega rótulo

O sistema SHALL omitir o rótulo de erro para monitor em `UP`.

Isso vale inclusive quando o heartbeat de sucesso tem mensagem (monitores HTTP gravam
`200 - OK`): a resposta não é lugar de publicar o que o monitor respondeu quando está tudo bem.

#### Scenario: Monitor normal não tem rótulo
- **WHEN** o último heartbeat de um monitor tem status `UP` e mensagem `200 - OK`
- **THEN** a resposta não traz rótulo de erro para aquele monitor

### Requirement: Monitor de grupo não vaza nome de filho

Monitor do tipo `group` grava mensagens que enumeram os filhos afetados
(`Child monitors down: <nomes>`). Como um grupo pode estar numa status page **sem** que seus
filhos estejam, o sistema SHALL render um rótulo que não nomeia filho nenhum.

#### Scenario: Grupo com filhos fora do ar
- **WHEN** a mensagem do heartbeat é `Child monitors down: Banco interno, Fila de jobs`
- **THEN** o rótulo não contém `Banco interno` nem `Fila de jobs`

### Requirement: O saneamento acontece no servidor

O sistema SHALL sanear a mensagem antes de escrevê-la na resposta HTTP. A mensagem original
SHALL NOT trafegar até o navegador em nenhuma circunstância, inclusive em campo auxiliar,
comentário ou payload de depuração.

#### Scenario: Corpo da resposta não contém a mensagem original
- **WHEN** um monitor está em `DOWN` com uma mensagem que carrega um identificador reconhecível
- **THEN** o corpo inteiro da resposta, normalizado, não contém esse identificador

### Requirement: Status page não publicada não alimenta o painel

O endpoint SHALL recusar quando a status page do slug não está publicada
(`status_page.published = 0`), devolvendo 404.

O endpoint expõe mais do que a status page pública (o rótulo de erro), então despublicar SHALL
bastar para fechar essa porta.

#### Scenario: Slug despublicado
- **WHEN** o endpoint do painel é chamado para um slug cuja status page tem `published = 0`
- **THEN** a resposta é 404 e não traz dado de monitor nenhum

#### Scenario: Slug inexistente
- **WHEN** o endpoint do painel é chamado para um slug que não existe
- **THEN** a resposta é 404, indistinguível da anterior

### Requirement: O cache do endpoint não pode ser maior que o ciclo do painel

O tempo de cache do endpoint SHALL ser menor ou igual ao intervalo de atualização do painel.

Cache maior que o ciclo faz o painel receber dado repetido e atrasa em silêncio tanto o pulso
quanto o selo "mudou agora" — a tela fica com cara de atualizada e não está.

#### Scenario: Cache coerente com o refresh
- **WHEN** o painel atualiza a cada 60 s
- **THEN** o cache do endpoint é de no máximo 60 s
