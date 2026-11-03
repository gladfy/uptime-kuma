## ADDED Requirements

### Requirement: Página própria, só com login

O sistema SHALL servir o painel na rota `/deploys/<slug>`, em tela cheia, sem a barra de navegação
do Kuma. A página SHALL exigir login: sem sessão, ela SHALL exibir o formulário de login do Kuma e
nenhum dado de deploy ou de monitor.

O servidor SHALL entregar dado de deploy somente a socket autenticado. Pedido de socket sem login
SHALL ser recusado, e a difusão de mudanças SHALL alcançar só sockets autenticados.

#### Scenario: Abrir sem login
- **WHEN** `/deploys/winker` é aberto num navegador sem sessão no Kuma
- **THEN** a página mostra o formulário de login e nenhum nome de repositório, commit, release ou monitor aparece no HTML nem nas mensagens recebidas pelo socket

#### Scenario: Socket sem login pede o estado
- **WHEN** um socket não autenticado emite o pedido do estado do painel
- **THEN** o servidor responde com recusa de login e não envia nenhum deploy

#### Scenario: Abrir com login
- **WHEN** `/deploys/winker` é aberto com sessão válida
- **THEN** o painel aparece com os deploys à esquerda e os monitores da status page `winker` à direita

### Requirement: A TV e a status page não mudam

A rota `/status/<slug>/tv` e a status page `/status/<slug>` SHALL continuar exibindo o que exibem
hoje. O painel SHALL NOT importar nem alterar `StatusPage.vue` nem `StatusPageTv.vue`.

#### Scenario: As três telas convivem
- **WHEN** `/status/winker`, `/status/winker/tv` e `/deploys/winker` são abertos ao mesmo tempo
- **THEN** cada uma mostra o próprio layout, e as duas primeiras continuam públicas

### Requirement: Duas colunas, com os monitores ocupando a maior parte

Em tela larga, o painel SHALL dividir a tela em duas colunas: deploys numa coluna estreita à
esquerda (29% da largura, nunca menos de 340 px) e monitores à direita no restante.

Os monitores SHALL ficar numa superfície só, dividida em 3 colunas (2 abaixo de 1180 px, 1 no
celular), preenchida de cima para baixo e coluna por coluna, com a última coluna completada por
células vazias para as linhas alinharem. Cada monitor é uma linha (nome à esquerda, barras à
direita) e as linhas dividem a altura disponível: numa tela de 1920 × 1080 todos cabem, sem paginar e
sem rolar. Um monitor SHALL ficar sempre no mesmo lugar, qualquer que seja o estado dele.

Em tela estreita, as colunas SHALL empilhar (deploys em cima), com rolagem vertical normal e
nenhuma rolagem horizontal.

#### Scenario: TV 1080p com a status page winker
- **WHEN** o painel é aberto em 1920 × 1080 com a status page `winker` (34 monitores) e seis deploys ativos
- **THEN** os 34 monitores e os seis cartões aparecem na mesma tela, sem indicador de página, sem rolagem e sem cartão cortado

#### Scenario: Monitor cai
- **WHEN** o monitor "Superlógica" fica fora do ar
- **THEN** ele continua na mesma linha da grade, com a pílula "▲ Fora do ar" e a linha em vermelho claro

#### Scenario: Celular
- **WHEN** o painel é aberto com 400 px de largura
- **THEN** os deploys aparecem acima dos monitores e a página não rola na horizontal

### Requirement: A lista de monitores vem da curadoria da status page

O painel SHALL exibir exatamente os monitores que a status page `<slug>` exibe, na mesma ordem,
respeitando a expansão de grupo (`monitor_group.show_children`). Slug inexistente ou despublicado
SHALL mostrar o mesmo desfecho de página não encontrada da status page.

#### Scenario: Monitor entra na status page
- **WHEN** um monitor é acrescentado à status page `winker`
- **THEN** ele passa a aparecer no painel sem release e sem recarregar a página manualmente

#### Scenario: Grupo expandido
- **WHEN** a status page tem um grupo com "mostrar monitores do grupo" ligado
- **THEN** o painel mostra os filhos diretos do grupo como monitores próprios

### Requirement: O estado de cada monitor vem do Kuma, ao vivo

O estado exibido de cada monitor SHALL vir do último heartbeat que o Kuma entregou pelo socket,
nos quatro estados do Kuma: `UP` (Normal), `PENDING` (Pendente), `DOWN` (Fora do ar) e
`MAINTENANCE` (Manutenção). Monitores em `DOWN` e `PENDING` SHALL subir para um bloco de destaque
no topo da coluna de monitores e sair da grade. `MAINTENANCE` SHALL ficar na grade com cor própria
e SHALL NOT contar como queda.

#### Scenario: Monitor cai
- **WHEN** o Kuma registra `DOWN` para um monitor da lista
- **THEN** o monitor sai da grade e aparece no destaque no topo da coluna, sem esperar ciclo de atualização

#### Scenario: Manutenção programada
- **WHEN** um monitor entra em manutenção
- **THEN** ele permanece na grade com o rótulo "Manutenção" e o veredito de serviços não acusa queda

### Requirement: Deploy não altera a saúde do monitor

A cor e o rótulo de estado de um monitor SHALL depender só do Kuma. Um deploy em andamento,
travado ou com falha SHALL NOT mudar o estado exibido do monitor; ele SHALL aparecer como uma
marca à parte no cartão do monitor ligado à release ("em deploy" ou "virada travada").

#### Scenario: Virada travada com serviço de pé
- **WHEN** a virada de `connector/connector-access` está travada e o monitor "Connector Access" está `UP` no Kuma
- **THEN** o monitor aparece como Normal, com a marca "virada travada", e o veredito de serviços não acusa queda

### Requirement: Ligação de monitor com release pela tag do Kuma

Um monitor SHALL ser ligado a uma release por uma tag do Kuma de nome `deploy`, com valor
`<namespace>/<release>` para o cluster ou `amplify/<app>` para o Amplify. Um monitor MAY ter mais
de uma tag `deploy`. Mudar a tag na tela do monitor SHALL refletir no painel sem deploy.

A marca "em deploy" (pílula e faixa azul da linha) SHALL aparecer só enquanto o deploy ligado
mexe no serviço: virando no cluster, ou, no Amplify, a partir do início do passo `deploy`. No
merge, na pipeline e com a pipeline verde aguardando a virada, o serviço ainda não foi tocado e a
linha fica sem marca.

#### Scenario: Monitor com tag
- **WHEN** o monitor "Web" tem a tag `deploy` = `condominio/winker-prod` e começa uma virada do `winker-prod`
- **THEN** o cartão do monitor "Web" mostra a marca "em deploy" enquanto a virada durar

#### Scenario: Pipeline rodando não marca o monitor
- **WHEN** o monitor "Flow" tem a tag `deploy` = `amplify/pro` e o job do `pro` está no passo `build`, com o `deploy` na fila
- **THEN** a linha do "Flow" fica sem a marca "em deploy" até o passo `deploy` começar

#### Scenario: Monitor sem tag
- **WHEN** um monitor não tem tag `deploy`
- **THEN** ele nunca mostra marca de deploy, e o destaque de queda diz que ele não tem deploy associado

### Requirement: O destaque de queda diz se havia deploy

Com ao menos um monitor fora do ar, uma faixa acima da grade SHALL dizer quais (até 3, e "+N" para
o resto), quantas verificações seguidas falharam e há quanto tempo está fora (mm:ss), e SHALL sumir
quando todos voltarem. A faixa SHALL dizer, do que está fora há mais tempo, uma linha sobre deploy:
"Deploy de <projeto> em andamento" (só deploy que já chegou ao serviço: virada no cluster ou passo de
publicação do Amplify, a mesma regra da marca "em deploy"; pipeline e build pronto não contam),
"Começou <n> min depois da virada de <release>" (virada
concluída até 60 min antes do início da queda), "Nenhum deploy relacionado na última hora" ou
"Este monitor não tem deploy associado".

Quando a fonte da release ligada ao monitor (cluster ou Amplify) não está ativa, o destaque SHALL
omitir a linha de deploy: "nenhum deploy relacionado" só pode ser dito por quem está lendo a fonte.

#### Scenario: Queda depois de virada
- **WHEN** a virada de `gateway/gateway-prod` conclui e o monitor ligado cai 2 minutos depois
- **THEN** o destaque mostra "Começou 2 min depois da virada de gateway-prod" com o SHA curto do commit

#### Scenario: Queda com pipeline do mesmo projeto rodando
- **WHEN** o monitor ligado ao `gateway/gateway-prod` cai enquanto a pipeline do api_gateway roda e nada virou ainda
- **THEN** o destaque não diz "Deploy de api_gateway em andamento"

#### Scenario: Queda sem a fonte do cluster
- **WHEN** o monitor "Web" (tag `deploy` = `condominio/winker-prod`) cai e a fonte do cluster não está configurada
- **THEN** o destaque mostra o monitor e o tempo fora do ar, sem nenhuma linha sobre deploy

### Requirement: O cartão de deploy separa pipeline e virada

Cada deploy SHALL aparecer como um cartão com: o projeto, o SHA curto e a primeira linha da
mensagem do commit (quando conhecida), o tempo desde o merge, o estado da pipeline (e os jobs,
quando a fonte informar) e, para projetos no cluster, uma linha por release com
"<atualizados>/<réplicas> na versão nova" e o estado da virada. Quando a pipeline já terminou e a
virada continua, o cartão SHALL dizer isso explicitamente.

Rótulos do cartão: "Na pipeline", "Virando no cluster", "Sem progresso", "Virada travada" e
"Falhou". Virada sem pipeline correspondente SHALL manter o rótulo do estado dela e dizer "sem
pipeline vinculado" em cinza no subtítulo: é um fato sobre a origem do deploy, não um estado, e
não usa a cor de falha.

Cores e formas do painel: verde é saudável ou concluído; azul é deploy em andamento, nos cartões
da esquerda e na marca "em deploy" dos monitores da direita; âmbar é atenção; vermelho é só falha
de verdade (fora do ar, pipeline que falhou, virada travada) e vem com um triângulo, para não
depender só da cor. O magenta é da marca, não de estado. Monitor no ar não escreve "Normal": a cor
diz; só a exceção tem texto, numa pílula dentro da linha. Movimento só no deploy rodando, no
monitor fora do ar e na etapa atual, e os botões (som, tema, "abrir", "Como voltar") somem sem
ninguém na tela e voltam com o mouse, um toque ou uma tecla.

Quando a fonte de pipeline do projeto (Bitbucket ou GitHub) não está configurada, ou o projeto não
tem origem de pipeline na configuração, o cartão SHALL
mostrar só a virada, sem a seção de pipeline, e SHALL NOT mostrar "Sem pipeline": a ausência
de pipeline ali é falta de fonte, não deploy manual.

#### Scenario: Pipeline verde, virada em curso
- **WHEN** a pipeline do condominio terminou com sucesso e o `winker-prod` está com 9 de 17 réplicas na versão nova
- **THEN** o cartão mostra "Virando no cluster", "pipeline verde há N min", a linha `winker-prod 9/17` e o texto de que a virada continua no cluster

#### Scenario: Virada manual
- **WHEN** a fonte de pipeline do projeto está configurada e uma release dele muda de revisão sem pipeline correspondente
- **THEN** o cartão aparece com o rótulo do estado da virada ("Virando no cluster", "Virada travada"...), "sem pipeline vinculado" em cinza no subtítulo e as três primeiras etapas puladas

#### Scenario: Pipeline ainda não ligada
- **WHEN** a fonte de pipeline do projeto não está configurada e uma release dele muda de revisão
- **THEN** o cartão mostra só a virada, com o rótulo do estado dela, sem seção de pipeline e sem "Sem pipeline"

#### Scenario: Projeto sem origem de pipeline
- **WHEN** o projeto `temporal` está configurado sem origem de pipeline, os segredos do Bitbucket e do GitHub existem, e a release `temporal/temporal` muda de revisão
- **THEN** o cartão mostra só a virada, sem seção de pipeline e sem "Sem pipeline"

### Requirement: O cartão diz em que etapa o deploy está

O cartão SHALL mostrar as etapas do deploy, em ordem — "Merge", "Pipeline", "Build pronto",
"Virada" e "No ar" —, com "etapa N de M" e uma faixa com um segmento por etapa. A etapa atual
SHALL aparecer destacada; as anteriores, como concluídas; a que falhou (pipeline que falhou,
virada travada) em vermelho; a que parou sem falhar (pipeline cancelada, virada sem progresso,
nenhuma virada depois da pipeline verde) em amarelo.

As etapas SHALL ser só as que as fontes do projeto conseguem ver: sem fonte de pipeline (não
configurada, ou projeto sem origem), o cartão começa na "Virada" ("etapa 1 de 2"); sem a fonte do
cluster, termina na pipeline verde ("Merge", "Pipeline", "No ar"). Quando o projeto tem pipeline e
o deploy chegou sem ela (virada manual, ou vista com o painel fora do ar), as três primeiras etapas
SHALL aparecer como puladas, e não como concluídas. A conta é do servidor, que já decide o rótulo:
o navegador só desenha.

Os segmentos concluídos SHALL ser azuis, os futuros cinza e o da etapa que falhou vermelho. O
segmento da etapa atual SHALL ser azul-claro, preenchido em azul na proporção do que já andou
dentro dela, pulsando: na virada, as réplicas na versão nova sobre o total, somando os workloads;
na pipeline, os jobs concluídos sobre o total, contando 0,35 de job quando algum está rodando; nas
outras etapas, metade. O preenchimento SHALL ser de pelo menos 6%, para sempre aparecer, e vale nos
três níveis do cartão (no compacto é a única indicação de progresso).

#### Scenario: Pipeline do condominio rodando
- **WHEN** o merge chegou e a pipeline do condominio está rodando
- **THEN** o cartão mostra "etapa 2 de 5", com "Merge" concluída e "Pipeline" destacada

#### Scenario: Progresso dentro da virada
- **WHEN** o `winker-prod` está com 4 de 7 réplicas na versão nova e o `winker-integration` com 2 de 2
- **THEN** o segmento "Virada" aparece preenchido em 67% (6 de 9)

#### Scenario: Virada travada
- **WHEN** a pipeline ficou verde e a virada do `winker-prod` passou do prazo
- **THEN** o cartão mostra "etapa 4 de 5", com "Virada" em vermelho

#### Scenario: Virada sem pipeline num projeto com pipeline
- **WHEN** a fonte de pipeline do condominio está configurada e o `winker-prod` vira sem pipeline correspondente
- **THEN** o cartão mostra "etapa 4 de 5", com "Merge", "Pipeline" e "Build pronto" puladas

#### Scenario: Projeto sem origem de pipeline
- **WHEN** a release `microservices-prod/agua-gas` vira
- **THEN** o cartão mostra "etapa 1 de 2", com "Virada" destacada e "No ar" a seguir

### Requirement: Ordem e ciclo de vida dos cartões

Só deploy rodando e deploy com falha SHALL ser cartão: com falha primeiro, sob "Com falha", e os
rodando sob "Em andamento", cada grupo do mais antigo para o mais novo pela hora de início; sem
nenhum, a coluna mostra só o histórico. Um cartão SHALL NOT mudar de lugar quando o deploy passa de
uma etapa para a outra. Os dois títulos mostram a quantidade ("Em andamento 5"). Um deploy que fica no ar
SHALL virar a primeira linha das "Últimas 24 horas", destacada em verde por 15 minutos, com o "Como
voltar" nela. Um cartão de falha ou de virada travada SHALL ficar até alguém dispensar (o ✕ do
cartão, gravado no navegador; o cabeçalho deixa de contá-lo) ou até um deploy posterior do mesmo
projeto concluir com sucesso, o que vier primeiro.

Uma pipeline rodada de novo num commit cujo deploy já foi ao ar SHALL ser um deploy próprio,
contado da hora em que a nova execução começou, e não do merge nem da primeira execução (o Bitbucket
reaproveita o status da primeira, com a data de criação de dias antes). Rodada de novo depois de uma
falha, a pipeline SHALL seguir no cartão da falha. Pipeline verde de um commit que todas as releases
do projeto já rodam (cada objeto com tag de commit, lido do cluster ativo) SHALL concluir como "No ar"
na hora, sem esperar virada e sem o aviso "Nenhuma virada": não há o que trocar.

As "Últimas 24 horas" SHALL mostrar os deploys encerrados nas últimas 24 horas em quatro colunas
(✓/✕, projeto e SHA curto, duração, há quanto tempo), os mais recentes primeiro. Duração
desconhecida (virou com o painel fora do ar) SHALL ser "—", com uma nota só abaixo da lista. Um
deploy da lista SHALL voltar para a coluna de cartões quando uma virada do mesmo projeto e do mesmo
SHA começar.

#### Scenario: Deploy avança de etapa
- **WHEN** há três deploys em andamento e o do meio passa da pipeline para a virada
- **THEN** os três cartões continuam na mesma ordem

#### Scenario: Integration e prod do mesmo commit, 26 minutos depois
- **WHEN** o `winker-integration` concluiu o commit `9ee108f`, o deploy já saiu para a lista "Hoje", e 26 minutos depois o `winker-prod` começa a virar o mesmo commit
- **THEN** o deploy `condominio 9ee108f` volta a ser cartão, com as duas linhas de release, e há uma entrada só desse commit

#### Scenario: Pipeline rodada de novo num commit em produção
- **WHEN** a pipeline do audit-consumer roda de novo no commit `c3073ea`, que o cluster já roda, 11 dias depois do merge, e fica verde em 4 minutos
- **THEN** o deploy entra nas "Últimas 24 horas" como concluído com 4 min, sem cartão "Nenhuma virada" e sem "263 h"

#### Scenario: Falha resolvida por deploy novo
- **WHEN** o connector-server tem uma virada travada e um deploy posterior dele conclui
- **THEN** o cartão travado sai do painel sozinho e os dois deploys aparecem nas "Últimas 24 horas"

#### Scenario: Falha que ninguém consertou
- **WHEN** a pipeline do api_gateway falha e nenhum deploy dele conclui depois
- **THEN** o cartão fica até alguém clicar no ✕, mesmo depois de o servidor mandar o deploy para o histórico

### Requirement: O painel não afirma o que não leu

Cada fonte (Kuma, cluster, Bitbucket, GitHub, Amplify) SHALL mostrar no rodapé há quanto tempo
chegou o último dado. Quando a fonte passar do limite sem dado (cluster sem watch ativo, Amplify
sem consulta bem-sucedida, socket do Kuma desconectado), o painel SHALL avisar e marcar como não
confirmada a parte da tela que depende dela. Fonte não configurada SHALL aparecer como "não
configurada" e SHALL NOT gerar alarme.

Webhook não tem ritmo próprio: ausência de evento não é falha. Para Bitbucket e GitHub o rodapé
SHALL mostrar o último evento recebido, sem alarme por tempo.

O ponto de cada fonte SHALL ter o mesmo significado em todas: verde, dado recente; âmbar, ligada e
ainda sem dado; cinza, não configurada; vermelho em triângulo, sem resposta.

#### Scenario: Watch do cluster cai
- **WHEN** a conexão de watch com o cluster cai e não volta por mais de 2 minutos
- **THEN** o rodapé marca o cluster como sem leitura e os cartões dizem que o estado da virada não está confirmado

#### Scenario: Rodando fora do cluster
- **WHEN** o Kuma roda na máquina de um desenvolvedor, sem conta de serviço do Kubernetes
- **THEN** o cluster aparece como "não configurado" e o resto do painel funciona

### Requirement: A coluna de deploys cabe na tela

Na tela larga, a coluna de deploys SHALL NOT rolar nem cortar cartão. Cada cartão SHALL ter um de
três níveis, sobre o mesmo conteúdo:

- **completo**: cabeçalho (projeto, SHA, rótulo), "começou há N" e "etapa N de M", a faixa de etapas
  com os nomes, a caixa da pipeline (estado, mensagem do commit, jobs) e as réplicas de cada
  workload com barra;
- **médio**: cabeçalho, "começou há N" e "etapa N de M", a faixa com os nomes e uma linha de detalhe;
- **compacto** (cerca de 70 px): cabeçalho com o tempo decorrido à direita, a faixa sem os nomes e a
  linha de detalhe.

Em qualquer nível o cartão SHALL manter o aviso de estado não confirmado e o "Como voltar" da virada
travada: um diz que o cartão pode estar errado, o outro é o que se precisa no incidente. Abrir o
"Como voltar" SHALL refazer a escolha dos níveis, como qualquer cartão que muda de altura.

A linha de detalhe SHALL ser uma linha só, cortada com reticências: na virada, as réplicas de cada
workload ("winker-prod 4/7, winker-integration 2/2"); na pipeline, o job atual e os próximos
("build rodando há 1 min, depois deploy e verify"); na falha, o job que falhou ("build falhou há 2
min"); nos outros casos, a mensagem do commit. O nome do workload ou do job vai em negrito e o
resto em cinza. O nome do projeto SHALL manter o tamanho em todos os níveis.

O nível SHALL ser escolhido medindo a coluna, a cada mudança nos deploys, no redimensionamento e
depois de a fonte carregar, numa conta só, antes de pintar: todos completos se couberem; senão
todos médios; senão todos compactos, promovendo para médio, um de cada vez e enquanto couber, a
falha e depois as viradas; e, se nem compactos couberem, os cartões do fim (nunca o primeiro) saem
e uma faixa azul-clara diz "+N em andamento". Com cartões na tela, o histórico SHALL guardar
espaço para pelo menos três linhas e manter o degradê na base quando for cortado.

#### Scenario: Um deploy
- **WHEN** há um deploy em andamento numa tela de 1920 × 1080
- **THEN** o cartão aparece completo

#### Scenario: Seis deploys
- **WHEN** há uma falha, duas viradas, duas pipelines e uma pipeline verde aguardando a virada numa tela de 1920 × 1080
- **THEN** a falha e as viradas aparecem no nível médio, as outras no compacto, sem rolagem, e o histórico mostra pelo menos três linhas

#### Scenario: Tela baixa
- **WHEN** os seis deploys não cabem nem compactos
- **THEN** os do fim saem da coluna, o primeiro continua, e a faixa "+N em andamento" ocupa o lugar deles

### Requirement: Resumo dos deploys no cabeçalho

O segmento "Deploys" do cabeçalho SHALL ter, na linha principal, "N em andamento" (sem contar as
falhas), com a bolinha azul pulsando, ou em âmbar quando algum cartão em andamento está em âmbar
(virada sem progresso, pipeline verde sem virada); e, embaixo, a contagem por etapa, só das que existem, nesta
ordem: "X na virada, Y na pipeline, Z aguardando virada" e, se houver, "W falhou" em vermelho. A
linha de baixo SHALL NOT listar nomes de repositório e SHALL NOT quebrar. Sem deploy em andamento,
o segmento SHALL ficar sem bolinha, com "Nenhum agora" e, embaixo, o último deploy ("último:
<projeto>, há N"); com só falhas na tela, SHALL dizer "N com falha" em vermelho, com o triângulo
(uma virada travada ainda está acontecendo).

#### Scenario: Pipeline verde sem virada
- **WHEN** há dois deploys em andamento e um deles está com o aviso "Nenhuma virada"
- **THEN** "2 em andamento" e a bolinha aparecem em âmbar

#### Scenario: Cinco em andamento e uma falha
- **WHEN** há duas viradas, duas pipelines, uma pipeline verde aguardando a virada e uma falha
- **THEN** o segmento mostra "5 em andamento" e, embaixo, "2 na virada, 2 na pipeline, 1 aguardando virada, 1 falhou", numa linha

### Requirement: Indicadores das últimas 24 horas

O cabeçalho SHALL mostrar quantos deploys houve nas últimas 24 horas e a taxa de sucesso, contados
por deploy (um commit com integration e prod é um deploy). A taxa SHALL ser concluídos ÷
(concluídos + travados + com falha); deploy substituído e deploy em andamento SHALL ficar fora dela.
Sem nenhum deploy encerrado na janela, a taxa SHALL aparecer como "—". Com a taxa abaixo de 100%, o
total e a taxa SHALL aparecer em âmbar; em 100%, a taxa em verde. Os indicadores SHALL NOT mudar a cor
de monitor nem de cartão.

#### Scenario: Doze encerrados, um travado
- **WHEN** nas últimas 24 horas houve 11 deploys concluídos, 1 travado, 2 substituídos e 1 em andamento
- **THEN** o cabeçalho mostra "Deploys 24 h: 15" e "Sucesso: 92% (11 de 12)", os dois em âmbar

#### Scenario: Nada encerrado
- **WHEN** não há deploy encerrado nas últimas 24 horas
- **THEN** a taxa aparece como "—", e não como 0% nem 100%

### Requirement: Botão de tema

Um botão pequeno no cabeçalho SHALL alternar entre o tema claro e o escuro, gravando a escolha na
preferência de tema do próprio Kuma, para que valha nas próximas aberturas naquele navegador.

#### Scenario: Trocar para claro
- **WHEN** o painel está escuro e a pessoa clica no botão de tema
- **THEN** o painel fica claro, e continua claro ao recarregar a página

### Requirement: Sons dos eventos do deploy e da queda de serviço

Com o som ativado, o painel SHALL tocar, uma vez por deploy, por evento e por etapa (a produção
depois da integração é outra etapa): um toque longo de buzina de navio quando o deploy começa (a
pipeline começou, ou a virada, em projeto sem origem de pipeline); o apito de trem quando a pipeline
termina verde; dois toques curtos da buzina quando a virada começa no cluster; o sino de bordo com
dois toques quando o deploy fica "No ar"; a buzina mais grave seguida de cinco toques curtos (o sinal
de perigo do RIPEAM) quando a pipeline falha ou a virada trava. Os sons SHALL ser gravações reais,
nada eletrônico nem de jogo, com a licença e o autor registrados junto dos arquivos e o crédito que a
licença exigir na própria tela. Os arquivos SHALL ser baixados só quando o som estiver ligado. O
som SHALL começar ligado; um botão SHALL silenciar e religar, com a escolha gravada no navegador, e
religar toca o sino uma vez. Enquanto o navegador não deixar tocar (nenhum clique na página ainda),
o painel SHALL dizer isso ao lado do botão. Só transição vista ao vivo SHALL tocar: abrir a página, reconectar o socket ou
carregar o histórico SHALL NOT tocar nada. Um som SHALL tocar por vez.

O som SHALL continuar tocando com a página aberta por dias e em segundo plano: as gravações ficam na
memória da página (um deploy do Kuma não as tira), um som pausado de fora ou que falha não trava os
seguintes, e a página pede ao navegador para não congelar a aba.

Com o som ativado, o painel SHALL tocar a sirene de dois tons dos bombeiros (gravação real) quando
um monitor da lista passa de no ar, pendente ou em manutenção para fora do ar, visto ao vivo. Abrir a
página, reconectar o socket, um monitor religado que já volta fora e um monitor que entra na lista já
fora SHALL NOT tocar. Enquanto o monitor continua fora, a sirene SHALL NOT repetir; vários monitores
caindo juntos SHALL tocar uma sirene só. A sirene SHALL passar na frente dos sons de deploy que
esperam na fila, sem cortar o que já toca, e SHALL NOT ser descartada quando a fila enche.

#### Scenario: Serviço cai com a página aberta
- **WHEN** o som está ativado e o monitor "Gateway (API Geral)" passa de no ar para fora do ar
- **THEN** a sirene toca uma vez, e não toca de novo enquanto ele continuar fora

#### Scenario: Serviço cai durante um deploy
- **WHEN** há sons de deploy esperando na fila e um serviço cai
- **THEN** o som que toca termina, a sirene toca em seguida, e depois os sons de deploy

#### Scenario: Página aberta com serviço fora
- **WHEN** a pessoa abre o painel, ou o socket reconecta, e um serviço já está fora do ar
- **THEN** a sirene não toca

#### Scenario: Som pausado de fora
- **WHEN** o sistema pausa o som que tocava (uma tecla de mídia, outra aba tomando o áudio) e chega o evento seguinte
- **THEN** o som do evento seguinte toca

#### Scenario: Kuma atualizado com a página aberta
- **WHEN** o Kuma é atualizado e os arquivos de som da versão anterior deixam de existir no servidor
- **THEN** a página aberta desde antes continua tocando os sons

#### Scenario: Virada concluída
- **WHEN** o som está ativado e o deploy do condominio passa de "Virando no cluster" para "No ar"
- **THEN** toca o sino de duas notas, uma vez

#### Scenario: Página aberta com deploy travado
- **WHEN** a pessoa abre o painel e já há um deploy travado
- **THEN** nenhum som toca

#### Scenario: Integração e produção do mesmo commit
- **WHEN** a integração do condominio fica "No ar" e, 30 minutos depois, a produção do mesmo commit vira e fica "No ar"
- **THEN** o sino toca nas duas vezes, e os dois toques curtos antes da segunda

#### Scenario: Página recarregada na TV com o som ligado
- **WHEN** a página é recarregada e ninguém clicou nela ainda
- **THEN** o navegador não deixa tocar, e o painel avisa ao lado do botão que é preciso um clique

#### Scenario: Recarregada pelo Kuma, com reprodução automática permitida
- **WHEN** o Kuma é atualizado, a página recarrega sozinha (versão nova do servidor) e o navegador da TV tem a reprodução automática de áudio permitida para o site
- **THEN** o painel não mostra o aviso de clique e os sons tocam sem ninguém clicar

#### Scenario: Som silenciado
- **WHEN** alguém silenciou o som naquele navegador e uma virada começa
- **THEN** nada toca, e continua silenciado ao recarregar

#### Scenario: Navegador novo
- **WHEN** o painel é aberto num navegador em que ninguém mexeu no som
- **THEN** o som está ligado e toca a partir do primeiro clique na página

### Requirement: Textos traduzidos e sem controles de demonstração

Todo texto da página SHALL vir de chaves novas em `src/lang/en.json` e `src/lang/pt-BR.json`. A
página SHALL NOT ter botões de simulação. Dado fictício SHALL aparecer só com `?mock=deploys&n=N` na
URL (N de 0 a 6), para conferir o desenho com N deploys: troca os deploys, o histórico e o estado
das fontes do que se desenha, nunca o que o servidor guarda nem o que toca som, e um selo no título
diz que é simulação.

#### Scenario: Página em português
- **WHEN** o Kuma está em pt-BR
- **THEN** todos os rótulos do painel aparecem em português, sem chave crua na tela
