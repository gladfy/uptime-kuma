## ADDED Requirements

### Requirement: Rota própria, sem alterar a status page do cliente

O sistema SHALL servir o painel numa rota própria derivada do slug (`/status/<slug>/tv`), e
SHALL NOT alterar o que a status page do mesmo slug exibe.

`src/pages/StatusPage.vue` SHALL permanecer idêntico ao upstream.

#### Scenario: Painel e status page convivem
- **WHEN** `/status/<slug>` e `/status/<slug>/tv` são abertos para o mesmo slug
- **THEN** a status page mostra o quadro do upstream e o painel mostra o quadro do telão, cada um com seu layout

#### Scenario: Slug inválido
- **WHEN** `/status/<slug>/tv` é aberto para um slug que não existe ou não está publicado
- **THEN** o painel não exibe dado de monitor e mostra o mesmo desfecho de página não encontrada da status page

### Requirement: A lista de monitores vem da curadoria da status page

O painel SHALL exibir exatamente os monitores que a status page do slug exibe, respeitando
grupos, ordem e a expansão de grupo (`monitor_group.show_children`) já existente.

Incluir ou remover monitor do painel SHALL ser feito editando a status page, sem deploy.

#### Scenario: Monitor entra na status page
- **WHEN** um monitor é adicionado à status page do slug
- **THEN** ele passa a aparecer no painel dentro de um ciclo de atualização, sem release e sem reiniciar o telão

#### Scenario: Grupo expandido
- **WHEN** um monitor tipo grupo do slug está com "mostrar monitores do grupo" ligado
- **THEN** o painel exibe os filhos diretos dele como monitores próprios

### Requirement: Quem está fora do ar é promovido ao bloco de destaque

Quando ao menos um monitor está em `DOWN`, o sistema SHALL exibir um bloco de destaque no topo
com esses monitores, e SHALL removê-los da lista de baixo.

Quando nenhum monitor está em `DOWN`, o sistema SHALL exibir o cartão de tudo normal e listar
todos os monitores.

#### Scenario: Uma queda
- **WHEN** exatamente um monitor está em `DOWN`
- **THEN** ele aparece no bloco de destaque e não aparece na lista de baixo

#### Scenario: Nenhuma queda
- **WHEN** nenhum monitor está em `DOWN`
- **THEN** o cartão "todos os serviços operando normalmente" é exibido e a lista traz todos os monitores

#### Scenario: Contagem do cabeçalho
- **WHEN** N monitores estão em `DOWN` de um total de T
- **THEN** a faixa do destaque informa N de T monitores, e a lista informa os T menos N restantes

### Requirement: O formato do destaque muda com a quantidade

O sistema SHALL exibir card grande com histórico completo quando houver exatamente um monitor em
`DOWN`, e grade de cards compactos quando houver dois ou mais.

#### Scenario: Card grande
- **WHEN** há exatamente um monitor em `DOWN`
- **THEN** o destaque mostra nome, rótulo do erro e o histórico completo daquele monitor

#### Scenario: Grade de cards
- **WHEN** há cinco monitores em `DOWN`
- **THEN** o destaque mostra cinco cards compactos, cada um com nome, rótulo do erro e histórico curto

### Requirement: O destaque nunca corta conteúdo nem esconde queda

O canvas é fixo (1920 × 1080) com `overflow: hidden`. O sistema SHALL limitar quantos cards o
bloco de destaque exibe, de modo que o bloco caiba na tela **e** sobre espaço para ao menos uma
linha da lista. Acima do teto de cards (queda em massa), o sistema SHALL recolher o destaque à
faixa de contagem e exibir TODOS os monitores na lista, com os caídos primeiro — nenhum monitor
fora do ar pode ficar representado apenas por um número.

> Revisado em 2026-08-25: a primeira versão resumia o excedente em "e mais N fora do ar". Medido
> em produção com 32 de 48 fora, 23 quedas ficavam invisíveis — o painel deixava de responder
> exatamente "o que está fora?". O excedente resumido foi substituído pelo modo lista.

#### Scenario: Quedas acima do teto (queda em massa)
- **WHEN** o número de monitores em `DOWN` excede o teto de cards do destaque
- **THEN** o destaque exibe apenas a faixa com a contagem ("N de T monitores"), sem cards
- **AND** a lista exibe todos os monitores, ordenados por gravidade (fora do ar, degradado,
  manutenção, normal), preservando a ordem de curadoria dentro de cada estado
- **AND** cada linha de monitor fora do ar exibe o rótulo saneado da causa ao lado do nome

#### Scenario: Quedas dentro do teto
- **WHEN** há mais de um e no máximo o teto de monitores em `DOWN`
- **THEN** o destaque mostra um card por monitor caído e a lista mostra apenas os demais

#### Scenario: Nada é cortado pela borda
- **WHEN** todos os 50 monitores do slug estão em `DOWN`
- **THEN** o bloco de destaque (a faixa) continua inteiramente visível dentro dos 1080 px e a lista mantém ao menos uma linha

### Requirement: Mudança de situação dispara pulso de 15 segundos

O sistema SHALL comparar o conjunto de monitores em `DOWN` com o do ciclo anterior e, quando ele
mudar, SHALL pulsar o bloco de destaque (ou o cartão de tudo normal) por 15 segundos, cancelando
o temporizador anterior.

Os monitores que **entraram** em `DOWN` nessa mudança SHALL pulsar individualmente e exibir o
selo "mudou agora"; os que já estavam fora SHALL permanecer estáticos.

#### Scenario: Monitor novo cai
- **WHEN** um monitor entra em `DOWN` enquanto outro já estava fora
- **THEN** o card do que acabou de cair pulsa e traz o selo "mudou agora", e o do que já estava fora não pulsa

#### Scenario: O pulso termina
- **WHEN** passam 15 segundos desde a última mudança de situação
- **THEN** o pulso para e o selo "mudou agora" some

#### Scenario: Mudança durante o pulso
- **WHEN** uma nova mudança acontece antes de os 15 segundos terminarem
- **THEN** o temporizador reinicia e o selo passa a marcar os monitores da mudança nova

#### Scenario: Recuperação também é mudança
- **WHEN** o último monitor em `DOWN` volta a `UP`
- **THEN** o cartão de tudo normal é exibido e pulsa por 15 segundos

### Requirement: A lista pagina sozinha com capacidade medida

O sistema SHALL trocar a página da lista a cada 15 segundos e SHALL derivar quantos itens cabem
por página **medindo o DOM** (altura da grade dividida pela altura de uma linha real), nunca por
constante.

A última página SHALL retroceder para preencher a tela em vez de exibir só o resto.

#### Scenario: Capacidade medida
- **WHEN** a altura disponível para a lista muda porque o bloco de destaque cresceu
- **THEN** o número de itens por página é recalculado e nenhuma linha fica cortada

#### Scenario: Última página cheia
- **WHEN** sobram menos itens que uma página inteira ao final da rotação
- **THEN** a última página recua para exibir uma página cheia

#### Scenario: Uma página só
- **WHEN** todos os monitores restantes cabem numa página
- **THEN** a lista não pagina e o resumo não exibe contador de páginas

### Requirement: O vocabulário da tela cobre os quatro estados do Kuma

O sistema SHALL traduzir os quatro estados do Uptime Kuma para a tela: `UP` como normal,
`PENDING` como degradado, `DOWN` como fora do ar e `MAINTENANCE` como manutenção, com cor
própria.

Monitor em `MAINTENANCE` SHALL NOT ser promovido ao bloco de destaque nem contar como fora do ar.

#### Scenario: Manutenção não é queda
- **WHEN** um monitor está em `MAINTENANCE` e nenhum outro está em `DOWN`
- **THEN** o painel exibe o cartão de tudo normal e o monitor aparece na lista marcado como em manutenção

#### Scenario: Degradado fica na lista
- **WHEN** um monitor está em `PENDING`
- **THEN** ele aparece na lista marcado como degradado, e não no bloco de destaque

### Requirement: Grupo e filho não são contados em dobro

Monitor do tipo `group` vai a `DOWN` quando qualquer filho cai. Quando o grupo e seus filhos
estão ambos no painel, o sistema SHALL evitar que a mesma queda apareça duas vezes no destaque e
seja contada duas vezes no total de fora do ar.

#### Scenario: Grupo expandido com um filho fora
- **WHEN** um grupo expandido está em `DOWN` porque um dos seus filhos caiu
- **THEN** a queda aparece uma única vez no destaque, representada pelo filho, e a contagem "N de T" reflete uma única queda

#### Scenario: Grupo sem expansão continua sendo promovido
- **WHEN** um grupo **sem** expansão de filhos está em `DOWN`
- **THEN** ele aparece no destaque como um monitor único, porque é a única representação daquela queda no painel

### Requirement: A janela do histórico é derivada do dado

O rótulo da janela do histórico SHALL ser calculado a partir do campo `time` dos heartbeats
exibidos, e SHALL NOT ser um texto fixo.

Heartbeat é gravado no intervalo de cada monitor (default 60 s, configurável por monitor), então
um número fixo de barras não corresponde a uma duração fixa.

#### Scenario: Monitor com intervalo diferente do default
- **WHEN** o monitor em destaque roda com intervalo de 20 segundos
- **THEN** o rótulo da janela reflete o período realmente coberto pelas barras exibidas, não "60 minutos"

#### Scenario: Monitor sem histórico suficiente
- **WHEN** um monitor tem menos heartbeats que as barras do histórico
- **THEN** as posições sem dado aparecem como vazias e o rótulo cobre só o período existente

### Requirement: O painel não é interativo e não abre socket

O painel SHALL NOT oferecer hover, clique, filtro, edição ou qualquer controle de demonstração,
e SHALL NOT abrir conexão socket.io — a rota entra na lista de páginas sem socket, como as demais
rotas de status.

#### Scenario: Sem socket
- **WHEN** o painel é aberto
- **THEN** nenhuma conexão socket.io é estabelecida e os dados chegam por requisição HTTP periódica

#### Scenario: Sem controles de demonstração
- **WHEN** o painel é aberto em produção
- **THEN** não existe botão de simular queda nem qualquer controle de estado na tela

### Requirement: A tipografia do design é servida junto com o painel

Plus Jakarta Sans não existe no Uptime Kuma. O sistema SHALL servir a fonte junto com o painel,
sem depender de rede externa.

#### Scenario: Sem rede externa
- **WHEN** o painel é aberto num navegador sem acesso à internet
- **THEN** a fonte do design é aplicada e as medidas do layout se mantêm

### Requirement: A atualização é periódica e visível

O painel SHALL atualizar os dados em intervalo fixo e SHALL exibir o horário da última leitura e
a contagem regressiva para a próxima.

#### Scenario: Contador regressivo
- **WHEN** o painel acabou de atualizar
- **THEN** a contagem regressiva reinicia no intervalo configurado e decresce a cada segundo

#### Scenario: Falha na atualização
- **WHEN** uma atualização falha
- **THEN** o painel mantém o último quadro conhecido em vez de esvaziar a tela, e volta a tentar no ciclo seguinte
