## Why

O time de suporte precisa de um painel de parede (TV) que faça a queda **saltar aos olhos**
do outro lado da sala. Hoje o que existe é a status page voltada ao cliente: um monitor fora
do ar vira uma linha vermelha entre 50, na ordem de leitura, sem nenhum destaque — quem passa
não vê. Pior, com ~50 monitores a lista não cabe em 1080 px, então boa parte do quadro fica
fora da tela o tempo todo.

Já existe design hi-fi pronto e validado para essa tela em `docs/design_handoff_status_destaque/`
(spec, referência visual e implementação de referência executável em JS puro). O que falta é
encaixá-lo no Uptime Kuma.

A tentativa anterior foi mexer na própria status page (commit `8aaa1154`, revertido em
`0baf0056`): mudava o que **o cliente** vê para atender uma necessidade **interna**. Esta
proposta separa as duas coisas — a status page volta a ser só do cliente e o painel ganha
rota própria.

## What Changes

- **Rota nova `/status/<slug>/tv`**, pública, servida pela mesma SPA. Reusa a curadoria que já
  existe na status page do slug (quais monitores, grupos, ordem) — inclusive a expansão de
  grupo entregue em `status-page-monitores-do-grupo`. Trocar o que aparece no telão passa a ser
  editar a status page, sem deploy.
- **Promoção do que está fora do ar:** monitores em DOWN saem da lista e sobem para um bloco de
  destaque no topo — card grande quando é um só, grade de cards quando são vários. A lista de
  baixo mostra só os não afetados e **pagina sozinha** a cada 15 s, com a capacidade medida no
  DOM (nunca uma constante), para nunca cortar linha.
- **Pulso de 15 s a cada mudança de situação**, com selo "mudou agora" no card de quem acabou de
  cair — o que separa "caiu agora" de "está caído há uma hora" na visão de quem olha de longe.
- **Endpoint público novo com a mensagem de erro saneada.** Hoje `Heartbeat.toPublicJSON()` zera
  `msg` de propósito, e o valor cru (`bean.msg = error.message`, `server/model/monitor.js:918`)
  carrega IP interno, host e até query de banco. O painel precisa da linha do erro, então a
  mensagem passa por uma **allowlist que RENDERIZA um rótulo** a partir do padrão reconhecido —
  nunca repassa a string original. Default deny: o que não casar vira rótulo genérico.
- **Os quatro estados do Kuma passam a ter lugar na tela.** O design tem três (Normal /
  Degradado / Fora do ar) e o Kuma tem quatro: `UP`, `PENDING`, `DOWN` e `MAINTENANCE`. Sem
  regra explícita, um monitor em manutenção programada apareceria como "Fora do ar" no telão —
  alarme falso. O design se adapta ao Kuma, não o contrário.
- **Teto para muitas quedas simultâneas.** O bloco de destaque é `flex:0 0 auto` num canvas fixo
  com `overflow:hidden`: a partir de ~13 monitores fora ele estoura os 1080 px e é cortado em
  silêncio — justamente no cenário em que o painel mais importa. Acima do teto, mostra os
  primeiros e conta o excedente.
- **Rótulo do histórico derivado do dado**, não do literal "últimos 60 minutos": heartbeat é por
  intervalo de cada monitor (default 60 s, mas configurável por monitor), então 45 barras não são
  60 minutos. A janela sai do campo `time` do primeiro heartbeat exibido.
- **Plus Jakarta Sans embutida** — a fonte não existe no Uptime Kuma (`app.scss` usa a stack do
  sistema), e sem ela as métricas do design não fecham.

Sem breaking change: nada do que existe hoje muda de comportamento. A rota é nova, o endpoint é
novo e a status page do cliente fica **idêntica ao upstream**.

**Candidatura a upstream:** não — **exclusiva do fork**. O upstream não tem o caso de uso
(painel interno de NOC com identidade visual Winker), e a tela carrega tokens e fonte do Design
System do app Winker.

**Arquivos quentes do upstream tocados** (custo de merge):
- `src/router.js` — 1 rota nova (aditiva, no meio do array de rotas: conflito possível, trivial).
- `src/mixins/socket.js` — 1 entrada no array `noSocketIOPages` para a rota nova não abrir socket
  (aditiva, 1 linha).
- `server/routers/status-page-router.js` — 1 `router.get` novo no fim do arquivo (aditivo).
- `src/pages/StatusPage.vue` — **não é tocado**, de propósito. Voltou ao upstream com o revert
  `0baf0056` e deve continuar assim.
- Todo o resto é **arquivo novo** (página do painel, componentes, saneador, testes): zero conflito.

## Capabilities

### New Capabilities
- `painel-tv-de-status`: a tela do painel — rota, os três formatos de quadro (tudo normal, uma
  queda, várias quedas), promoção do que está fora do ar, pulso de 15 s na mudança, paginação
  automática com capacidade medida, teto do bloco de destaque e o vocabulário de status derivado
  dos quatro estados do Kuma.
- `erro-saneado-no-heartbeat-publico`: o contrato de dados do painel — endpoint público que
  entrega, por monitor, o estado atual, os heartbeats recentes e a **mensagem de erro saneada por
  allowlist**, com default deny e sem jamais repassar a string original do erro.

### Modified Capabilities

<!-- nenhuma: openspec/specs/ está vazio (o change status-page-monitores-do-grupo ainda não foi
     sincronizado para specs/). Esta mudança CONSOME a expansão de grupo, mas não altera nenhum
     requisito dela. -->

## Impact

- **Schema:** nenhum. Sem migration — o painel só lê.
- **Backend:** `server/routers/status-page-router.js` (rota nova, aditiva); módulo novo do
  saneador de mensagem de erro; nenhuma mudança em `Heartbeat.toPublicJSON()` (o endpoint público
  atual continua sem `msg`, como está hoje).
- **Frontend:** página nova do painel + componentes próprios; `src/router.js` (1 rota);
  `src/mixins/socket.js` (1 linha em `noSocketIOPages`); assets da fonte Plus Jakarta Sans.
- **i18n:** o painel é uma tela em português para uso interno; qualquer string de UI nova entra
  em `en.json` **e** `pt-BR.json`, no MEIO do json.
- **Testes:** `test/backend-test/` para o saneador (é a peça com regra de segurança — merece
  teste de caso a caso, incluindo os que devem cair no default deny).
- **Operação:** o cache do endpoint novo tem de ser **coerente com o refresh do painel**. Hoje
  `/api/status-page/heartbeat/:slug` tem `cache("1 minutes")` no servidor; um refresh de 45 s
  contra cache de 60 s faria o painel repetir dado velho e atrasaria o pulso.

## Fora de escopo

- **Mexer na status page do cliente** (`src/pages/StatusPage.vue`) — de propósito: é a coisa que
  esta proposta existe para separar.
- **Qualquer interação** — sem hover, click, filtro ou edição pelo painel. É tela de parede.
- **Tempo real por socket.** A status page pública é polling REST por design do upstream
  (`noSocketIOPages`), e o painel segue o mesmo caminho. Consequência aceita: a queda aparece no
  telão com a latência de um ciclo de refresh, não no instante em que acontece.
- **Corrigir o `feedInterval` duplicado** do `mounted()` de `StatusPage.vue` (linhas 1051 e 1065,
  bug do upstream que faz a página pública pedir heartbeats duas vezes por ciclo). É de outro
  dono; a rota nova só não deve copiar o padrão.
- **Responsividade.** O alvo é canvas fixo de 1920 × 1080. Abrir em outra resolução escala o
  quadro inteiro, não reflui.
- **Múltiplos telões com conteúdo diferente na mesma tela**, som/alerta sonoro, e histórico de
  incidentes no painel.

## Pendências futuras

- **Refresh do painel: fica em 60 s.** Casa com o contador do design ("Próxima leitura em 00:60")
  e com o intervalo default de heartbeat do Kuma — pedir mais rápido que o intervalo do monitor
  devolve o mesmo dado. **Revisar quando** o time reclamar da latência do telão, ou quando os
  monitores do slug do painel passarem a rodar em intervalo menor que 60 s; baixar para 45 s é
  mudar a constante e o cache do endpoint junto.
- **Tempo real por socket para o painel.** Eliminaria a latência do ciclo e daria a `msg` sem
  endpoint novo, ao custo de o telão precisar de sessão autenticada. **Revisar quando** a
  latência de um ciclo virar problema concreto, ou se o painel sair da rede interna.
- **Painel montado sobre tag em vez de slug de status page.** **Revisar quando** existir telão
  cuja curadoria não faça sentido como status page publicável.
- **Recursão de grupo no painel** (grupo dentro de grupo). Segue o limite de v1 da expansão de
  grupo. **Revisar quando** houver grupo de grupos em uso real no slug do painel.
