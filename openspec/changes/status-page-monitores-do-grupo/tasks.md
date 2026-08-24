## 1. Schema

- [x] 1.1 Migration `db/knex_migrations/<YYYY-MM-DD-HHMM>-add-show-children-to-monitor-group.js`
      criando `monitor_group.show_children` (boolean, notNullable, defaultTo(false)), com
      `down` removendo a coluna. Validar o nome com `node extra/check-knex-filenames.mjs`.
- [x] 1.2 Subir com SQLite zerado (`compose.build.yaml` ou `npm run start-server` com data/
      limpo) e confirmar a coluna criada; conferir que uma instalação existente migra sem
      erro (boot roda migrations).

## 2. Backend — persistência e serialização

- [x] 2.1 `server/socket-handlers/status-page-socket-handler.js`: no bloco do save que copia
      campos por linha (~linha 385, padrão do `send_url`), gravar `show_children` quando
      vier do editor (coagir para boolean; só aceitar `true` se o monitor for tipo `group`).
- [x] 2.2 `Group.getMonitorList`: trazer `monitor_group.show_children` no SELECT e expor
      `showChildren` no `toPublicJSON` da linha do grupo — o editor carrega da API pública
      e o save round-tripa o objeto (sem isso, editar a página apaga a flag).
- [x] 2.3 `server/model/group.js` (`toPublicJSON`/`getMonitorList`): trazer `show_children`
      no SELECT; quando `show_children = 1` e `monitor.type === 'group'`, anexar
      `childrenList` com filhos diretos ativos (`Monitor.getChildren` + filtro `active`),
      serializados SEM url/customUrl (spec: URL do filho nunca vaza).
- [x] 2.4 `server/routers/status-page-router.js` (`/api/status-page/heartbeat/:slug`):
      incluir ids dos filhos diretos ativos dos grupos com `show_children = 1` no
      `monitorIDList` antes do loop de heartbeats/uptime, com dedupe (filho que também
      tem linha própria entra uma vez).

## 3. Backend — testes

- [x] 3.1 Teste em `test/backend-test/` cobrindo os cenários da spec: grupo expandido lista
      filhos ativos; filho pausado fora; **URL do filho não aparece no JSON público mesmo
      com url configurada** (controle positivo: o mesmo monitor com linha própria e
      send_url ligado EXPÕE a url — prova que a busca acha); flag desligada = formato
      atual sem `childrenList`.
- [x] 3.2 Teste do endpoint de heartbeat: filho expandido presente em `heartbeatList` e
      `uptimeList`; flag desligada não inclui filhos.

## 4. Frontend

- [x] 4.1 `src/components/MonitorSettingDialog.vue`: checkbox "Mostrar monitores do grupo"
      visível só para `monitor.type === 'group'`, ligado ao campo `showChildren` da linha
      (mesmo padrão do toggle de `sendUrl`).
- [x] 4.2 `src/pages/StatusPage.vue`: propagar o campo no objeto salvo (se o save já envia a
      linha inteira, conferir que o campo novo viaja; senão, acrescentar).
- [x] 4.3 `src/components/PublicGroupList.vue`: bloco aditivo renderizando
      `monitor.element.childrenList` como sub-lista indentada (nome + HeartbeatBar +
      uptime, sem link), somente-leitura em modo edição.
- [x] 4.4 Conferir no navegador (dev :3000 ou build): página com grupo expandido, grupo não
      expandido e monitor comum; adicionar um filho novo ao grupo e ver aparecer sem editar
      a página.

## 5. i18n

- [x] 5.1 Chaves novas (`showGroupChildren` + texto de aviso "inclusive monitores
      adicionados ao grupo no futuro") em `src/lang/en.json` E `src/lang/pt-BR.json`,
      inseridas no MEIO do json, perto de chaves de status page relacionadas.
      Validar com `node extra/check-lang-json.js`.

## 6. Fechamento

- [x] 6.1 `npm run lint` + `npm run test-backend` (exige `npm run build` antes).
- [x] 6.2 Build da imagem (`docker build -f docker/winker.dockerfile ...`) e smoke test via
      `compose.build.yaml` com uma status page real (grupo + filhos) — validar os cenários
      da spec no navegador.
- [x] 6.3 Atualizar a proposal se algo divergiu na implementação; marcar pendências futuras
      (recursão de grupos aninhados; PR upstream após 2+ semanas em produção).

> Notas da execução: 4.2 confirmado sem mudança (o save envia `publicGroupList` inteiro,
> `showChildren` viaja de graça). 4.4 verificado com Chrome headless (playwright-core) —
> screenshot com filhos aninhados, links ausentes, barras individuais. O ponta a ponta do
> endpoint de heartbeat está em `test/manual-test-group-expansion/smoke.js` (9 asserts).
> Filho novo respeita o cache público de 5 min (documentado na spec).
