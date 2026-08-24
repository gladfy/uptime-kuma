## Why

Ao adicionar um monitor do tipo **grupo** a uma status page (ex.: `/status/situator`), a
página exibe apenas a linha do grupo com o status agregado — os monitores que compõem o
grupo ficam invisíveis para quem acessa. Para o caso de uso do fork (status page por
cliente Winker, com um grupo por cliente/ambiente), o gestor precisa ver **cada serviço**
do grupo, não só o agregado. Hoje o contorno é adicionar os monitores um a um, o que
duplica gestão: todo serviço novo no grupo exige lembrar de editar também a status page.

Causa raiz (confirmada no código): a status page lista somente os monitores com linha em
`monitor_group` (`Group.getMonitorList`, server/model/group.js). Um monitor tipo grupo
entra como UMA linha; seus filhos (monitores com `parent` = id do grupo) não têm linha,
então não são serializados (`toPublicJSON`) nem recebem heartbeats no endpoint público
(`/api/status-page/heartbeat/:slug` filtra por `monitor_group`).

## What Changes

- Nova opção por monitor na status page: **"Mostrar monitores do grupo"** (checkbox no
  MonitorSettingDialog, visível só para monitores tipo grupo), persistida em coluna nova
  `monitor_group.show_children` (default `0` — opt-in, zero mudança nas páginas existentes).
- Com a opção ligada, a página pública renderiza os **filhos diretos** do grupo aninhados
  sob a linha do grupo, cada um com seu HeartbeatBar e uptime próprios.
- O endpoint público de heartbeats passa a incluir os filhos dos grupos com a opção ligada.
- Filhos expandidos **nunca expõem URL** (não têm linha em `monitor_group`, logo não têm
  `send_url`/`custom_url`) — só nome, status, heartbeats e uptime.
- A expansão acompanha o grupo dinamicamente: serviço novo no grupo aparece na status page
  sem editar a página.

**Candidatura a upstream:** sim — o design opt-in por linha de `monitor_group` (mesmo
padrão do `send_url`) é formato aceitável lá. Desenvolver no fork primeiro; se o PR
upstream for aceito, a manutenção some.

**Arquivos quentes do upstream tocados** (custo de merge): `src/pages/StatusPage.vue` e
`src/components/PublicGroupList.vue` (blocos aditivos), `server/model/group.js`,
`server/routers/status-page-router.js`, `server/socket-handlers/status-page-socket-handler.js`
(linhas aditivas no save), migration nova (arquivo próprio, sem conflito).

## Capabilities

### New Capabilities
- `status-page-expansao-de-grupo`: expansão opt-in dos filhos de um monitor tipo grupo na
  status page pública — persistência da opção, serialização dos filhos, heartbeats/uptime
  dos filhos no endpoint público e renderização aninhada.

### Modified Capabilities

<!-- nenhum spec existente em openspec/specs/ — repositório recém-adotou OpenSpec -->

## Impact

- **Schema:** coluna nova `monitor_group.show_children` (boolean, default 0) — migration
  knex que precisa rodar em SQLite E MySQL.
- **Backend:** `server/model/group.js` (serialização), `server/routers/status-page-router.js`
  (heartbeats públicos), `server/socket-handlers/status-page-socket-handler.js` (save).
- **Frontend:** `src/components/MonitorSettingDialog.vue` (checkbox),
  `src/components/PublicGroupList.vue` (render aninhado), `src/pages/StatusPage.vue` (se
  necessário para propagar o campo no save).
- **i18n:** chave nova em `en.json` + `pt-BR.json` (no MEIO do json).
- **Fora de escopo:** ver proposal — expansão recursiva de grupos aninhados, tags/cert
  expiry dos filhos, edição individual dos filhos na página.

## Fora de escopo

- **Grupos aninhados (recursão):** v1 expande só filhos diretos; um filho que também é
  grupo aparece como linha única com status agregado (comportamento atual).
- **Tags e vencimento de certificado dos filhos** na página pública.
- **Reordenar/remover filhos individualmente** na status page — os filhos seguem o grupo;
  quem quer curadoria manual adiciona os monitores um a um (comportamento atual).
- **Badges públicos por filho** — já funcionam por monitor, nada muda.

## Pendências futuras

- Expansão recursiva de grupos aninhados — revisar quando houver grupo de grupos em uso
  real na status page de clientes.
- Propor o PR no upstream — revisar depois da feature rodar 2+ semanas em
  monitor-clientes.winker.com.br.
