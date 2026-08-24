## Context

Mapa do fluxo atual (confirmado no código em 2026-08-24):

- **Editor** (`src/pages/StatusPage.vue`): o picker (`selectedMonitor` watcher, ~linha 926)
  empurra o monitor escolhido para `publicGroupList[0].monitorList` — um monitor tipo grupo
  vira UMA entrada. O dado do editor já traz `childrenIDs` por monitor
  (`server/model/monitor.js:133`, via `preloadData`).
- **Save** (`server/socket-handlers/status-page-socket-handler.js:375-386`): apaga e recria
  as linhas de `monitor_group`, copiando campos opcionais por linha (`send_url`,
  `custom_url`) — padrão a seguir para o campo novo.
- **Página pública** (`server/model/status_page.js` → `Group.toPublicJSON`,
  `server/model/group.js`): serializa só monitores com linha em `monitor_group`, via
  `monitor.toPublicJSON(showTags, certExpiry)` que expõe id, nome, sendUrl, type (+ url se
  sendUrl).
- **Heartbeats públicos** (`server/routers/status-page-router.js:64-111`): SELECT por
  `monitor_group` → mapa `heartbeatList[id]` + `uptimeList[id_24]`, cache de 1 minuto.
- **Filhos de grupo**: `Monitor.getChildren(id)` (monitor.js:1919) — filhos diretos;
  `Monitor.getAllChildrenIDs` existe para recursão (não usada na v1).

## Goals / Non-Goals

**Goals:**
- Opt-in por linha de status page: grupo com "Mostrar monitores do grupo" ligado renderiza
  os filhos diretos aninhados, com heartbeat e uptime individuais, dinamicamente (novo
  filho no grupo aparece sem editar a página).
- Zero mudança de comportamento para páginas existentes (default 0).
- Formato aditivo e aceitável para PR upstream.

**Non-Goals:**
- Recursão de grupos aninhados; tags/cert-expiry dos filhos; URL dos filhos; curadoria
  individual dos filhos (ordem/remoção) na status page.

## Decisions

1. **Opt-in em `monitor_group.show_children` (boolean default 0)**, não flag global da
   página nem comportamento automático. Razões: páginas existentes não mudam de cara;
   é o mesmo padrão dos campos por linha que já existem (`send_url`, `custom_url`); e o
   escopo por linha permite na mesma página um grupo expandido e outro não.
   *Alternativa descartada:* expandir no editor materializando os filhos como linhas de
   `monitor_group` (frontend-only, usando `childrenIDs` que o editor já tem). Mais barato,
   mas estático — serviço novo no grupo NÃO apareceria na página, que é exatamente a dor
   relatada. Se um dia virar necessidade (curadoria manual), é feature separada.

2. **Expansão dinâmica na serialização** (`Group.toPublicJSON`): quando a linha tem
   `show_children` e o monitor é tipo `group`, anexar `childrenList` ao objeto público do
   grupo — `Monitor.getChildren(id)` filtrando `active = 1`, cada filho via
   `toPublicJSON(false, false)` **forçando** `sendUrl` ausente/false (filho não tem linha
   em `monitor_group`; nunca expor `url` — regra de "nada de segredo na página pública").
   Filho pausado fica fora (mesma semântica do check do grupo, que ignora inativos).

3. **Heartbeats dos filhos no endpoint público**: em
   `/api/status-page/heartbeat/:slug`, o SELECT ganha uma segunda etapa: para cada linha
   de `monitor_group` com `show_children = 1` cujo monitor é tipo `group`, incluir os ids
   dos filhos diretos ativos. Reusa o loop existente
   (heartbeats + uptime 24h por id), com **dedupe** (Set): filho que também esteja listado
   individualmente na página não entra duas vezes. Cache de 1 minuto continua valendo.

4. **Render aninhado em `PublicGroupList.vue`**: bloco aditivo — abaixo da linha do
   monitor, se `monitor.element.childrenList?.length`, renderizar sub-lista indentada com
   nome + HeartbeatBar + uptime (mesmos componentes da linha principal). Em modo edição, a
   sub-lista aparece como preview somente-leitura (sem drag, sem remover individual — os
   filhos seguem o grupo).

5. **Checkbox no `MonitorSettingDialog.vue`** (o dialog por-monitor que já gerencia
   `sendUrl`/`customUrl`), visível apenas quando `monitor.type === 'group'`. O save já
   copia campos da linha (`status-page-socket-handler.js:385`) — acrescentar
   `show_children` no mesmo bloco. **O editor carrega `publicGroupList` da API PÚBLICA**
   (`axios.get("/api/status-page/"+slug)`, StatusPage.vue:1001; o comentário na linha 952
   confirma), então `showChildren` TEM de sair no `toPublicJSON` da linha (mesmo caminho do
   `sendUrl`, via SELECT do `getMonitorList`) — sem isso, qualquer edição da página
   apagaria a flag no round-trip editar→salvar.

6. **Migration** `db/knex_migrations/<data>-add-show-children-to-monitor-group.js`:
   `table.boolean("show_children").notNullable().defaultTo(false)`. Boolean + default
   funciona igual em SQLite (0/1) e MySQL (tinyint) — sem tipo exótico, sem check
   constraint (precedente do fix sqlite-only de 2026-08-18 mostra que check constraint
   diverge entre os dois).

## Divergência do upstream e custo de merge

Tudo aditivo: blocos novos em 5 arquivos quentes (`group.js`, `status-page-router.js`,
`status-page-socket-handler.js`, `PublicGroupList.vue`, `MonitorSettingDialog.vue`) +
1 chave i18n + 1 migration (arquivo próprio, zero conflito). Nenhuma linha existente
muda de comportamento com a flag desligada — merge futuro do upstream tende a conflito
trivial de contexto, não de semântica. Candidato declarado a PR upstream (ver proposal).

## Risks / Trade-offs

- **Exposição implícita**: ligar a flag publica nome/status de TODOS os filhos atuais e
  futuros do grupo. Mitigação: opt-in explícito, texto do checkbox avisa ("inclusive os
  adicionados no futuro"), URL nunca sai.
- **Custo do endpoint de heartbeat**: grupo com N filhos adiciona N consultas no loop
  (padrão já existente, 100 beats por monitor, cache de 1 min). Para grupos de dezenas de
  filhos está ok; grupos de centenas entram como pendência de paginação — fora de escopo.
- **Filho pausado some da página** (decisão 2). Alternativa (mostrar cinza) descartada na
  v1: exigiria estado visual novo no componente público.
- **e2e**: o fluxo público tem specs Playwright (`test/e2e/specs`) — cobrir com teste
  backend + validação manual; e2e novo é opcional (suíte pesada).

## Open Questions

- Nenhuma bloqueante. Nome final da chave i18n decidido na implementação
  (`showGroupChildren` + descrição).
