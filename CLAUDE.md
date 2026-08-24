# Uptime Kuma — Fork Winker

Fork de [louislam/uptime-kuma](https://github.com/louislam/uptime-kuma) (v2.5.3) para evoluir
funcionalidades que faltam no upstream. Destino de producao: **monitor-clientes.winker.com.br**
(Kubernetes/EKS winkernetes), hoje rodando a imagem oficial — a meta e trocar pela imagem propria
(`docker/winker.dockerfile`).

## Regras do fork

- **Remotes:** `origin` = github.com/gladfy/uptime-kuma (nosso), `upstream` = louislam/uptime-kuma.
  Sync: `git fetch upstream && git merge upstream/master`. Conflitos em arquivos que removemos
  (workflows, CNAME, CLAUDE.md/AGENTS.md/CODE_OF_CONDUCT.md do upstream) resolvem-se mantendo a remocao.
- **Node 22** para desenvolver (`nvm use 22`). O `engines` exige `>= 20.4.0` e o server **recusa**
  versoes banidas (20.0–20.3) no boot (`server/server.js`).
- **Workflows:** mantivemos so `auto-test.yml`, `validate.yml` e `codeql-analysis.yml`. O resto
  (release, docker push, bots de comunidade) foi removido — eram do upstream e falhariam aqui.
- **i18n:** o upstream so aceita mudanca em `src/lang/en.json` (o resto vem do Weblate). No fork
  podemos editar `pt-BR.json` direto, MAS cada edicao vira conflito no proximo merge do upstream —
  prefira chaves novas (aditivas) a alterar traducao existente.

## Stack

| Camada | Tecnologia |
|---|---|
| Backend | Node.js + Express + **Socket.io** (quase toda a comunicacao logada e socket, nao REST) |
| Frontend | Vue 3 SPA + Bootstrap 5, build via Vite (`config/vite.config.js`, gera `dist/` com .gz e .br) |
| ORM | **redbean-node** (`R.*`, models em `server/model/`) + **knex** so para migrations |
| Banco da app | SQLite (default, `data/kuma.db`) ou MariaDB/MySQL — decidido por `data/db-config.json`, criado no wizard de setup do primeiro boot |
| Testes | backend: `node --test` nativo · e2e: Playwright |

`pg`, `mongodb`, `mssql`, `oracledb`, `redis` etc. nas dependencies sao **monitor types**, nao banco da app.

## Como rodar

```bash
nvm use 22
npm ci                 # .npmrc ja seta legacy-peer-deps
npm run dev            # vite em :3000 (frontend) + server em :3001 — desenvolva em :3000
npm run build          # compila o frontend para dist/ (producao serve dist/ pelo proprio server)
npm run start-server   # so o backend, servindo dist/ ja compilado, em 0.0.0.0:3001
```

- Dados locais ficam em `./data/` (gitignored). Apagar `data/` = instalacao zerada (wizard de novo).
- Docker local com build do fork: `docker compose -f compose.build.yaml up --build`.
- O `compose.yaml` original (imagem oficial `louislam/uptime-kuma:2`) foi mantido como referencia —
  ele NAO roda o codigo do fork.

## Testes e lint

```bash
npm run build          # o CI roda build antes dos testes; alguns testes dependem de dist/
npm run test-backend   # node --test em test/backend-test/ (roteado por versao em test/test-backend.mjs)
npm run test-e2e       # Playwright (config/playwright.config.js) — pesado, exige build
npm run lint           # eslint + stylelint
npm run fmt            # prettier
```

Validacoes que o CI (`validate.yml`) cobra e valem rodar antes de commitar coisa nova:
`node extra/check-lang-json.js` (langs), `node extra/check-knex-filenames.mjs` (nome de migration).

## Arquitetura

```
server/server.js            - entry point (2k linhas): rotas HTTP + TODOS os handlers socket.io de auth/monitor
server/uptime-kuma-server.js- singleton UptimeKumaServer; REGISTRO dos monitor types (linha ~113)
server/database.js          - conexao, escolha de banco, migrations no boot; template sqlite = db/kuma.db
server/model/               - models redbean (monitor.js com 2k linhas = loop de check + heartbeat)
server/monitor-types/       - um arquivo por tipo de monitor (26)
server/notification-providers/ - um arquivo por provider (107); base: notification-provider.js
server/socket-handlers/     - handlers socket.io por dominio (status page, maintenance, docker, proxy...)
server/routers/             - o pouco de REST: api-router.js (badges, push, entry-page), status-page-router.js
src/                        - SPA Vue (paginas grandes: EditMonitor.vue 4.5k linhas, StatusPage.vue 1.8k)
src/mixins/socket.js        - cliente socket.io do frontend (estado global)
db/knex_migrations/         - migrations (rodam no boot); db/old_migrations/ = era v1, nao mexer
```

Fluxo: browser ⇄ socket.io ⇄ `server.js`/socket-handlers ⇄ models redbean ⇄ SQLite/MariaDB.
REST existe so para: status pages publicas, badges, push token (`/api/push/:token`), `/metrics`
(Prometheus, com auth) e `/api/entry-page`.

## Pontos de extensao (o motivo do fork)

### Novo monitor type — 3 pontas
1. `server/monitor-types/meu-tipo.js` — estende `MonitorType`, sobrescreve `async check(monitor, heartbeat, server)`
   (sucesso: setar `heartbeat.status = UP`; falha: `throw new Error("motivo")`).
2. Registrar em `server/uptime-kuma-server.js` (~linha 113): `UptimeKumaServer.monitorTypeList["meu-tipo"] = new MeuTipo();`
3. Frontend: `src/pages/EditMonitor.vue` — `<option>` no select de tipo + campos condicionais
   (`v-if="monitor.type === 'meu-tipo'"`). Textos novos em `src/lang/en.json` (+ pt-BR).
   Campo novo no banco = migration em `db/knex_migrations/`.

### Novo notification provider — 2 pontas (backend + frontend), 4 arquivos
1. `server/notification-providers/meu-provider.js` — estende `NotificationProvider`, define `name`,
   sobrescreve `async send(notification, msg, monitorJSON, heartbeatJSON)` (retorna msg de sucesso ou lanca).
2. `server/notification.js` — `require` no topo + instancia na lista do `static init()`. O `name` da
   classe TEM de casar com a chave usada no frontend.
3. `src/components/notifications/MeuProvider.vue` — formulario dos campos (padrao: `notification.*` via v-model).
4. `src/components/notifications/index.js` — import + entrada no objeto `NotificationFormList`
   (a CHAVE e o `name` do provider no backend).
Teste em `test/backend-test/notification-providers/` (ha ~20 exemplos).

### Migration
Nome validado pelo CI: `YYYY-MM-DD-HHMM-descricao.js` em `db/knex_migrations/`. Roda no boot
(sqlite E mysql — teste nos dois se a coluna tiver tipo exotico; ha precedente de fix so de sqlite:
`2026-08-18-0000-sqlite-only-drop-analytics-type-check.js`).

## Gotchas

- **Socket.io e a API "de verdade"** — funcionalidade logada nova nao ganha rota REST; ganha
  `socket.on(...)` no `server.js` (ou num socket-handler) e chamada correspondente no frontend.
- **`server/server.js` importa `../src/util.js`** (codigo COMPARTILHADO front/back, gerado de
  `src/util.ts` via `npm run tsc` — edite o .ts e regenere, nunca o .js direto).
- **Healthcheck**: `GET /` responde **302** → o healthcheck oficial (`extra/healthcheck.js|.go`)
  considera SO 302 como saudavel. Probes k8s httpGet em `/` funcionam (302 ∈ 200–399).
- **Monitor `ping` precisa de CAP_NET_RAW** — rodando como nao-root no k8s, adicione a capability
  no securityContext, senao todo monitor de ping falha.
- **`.npmrc` tem `legacy-peer-deps=true`** — npm sem essa flag (ou yarn/pnpm) quebra o install.
- **nscd**: em container o server tenta `sudo service nscd start` e **engole a falha** com um
  log info — na nossa imagem (sem nscd/sudo) essa linha de log e esperada e inofensiva.
- **Embedded MariaDB** so ativa com `UPTIME_KUMA_ENABLE_EMBEDDED_MARIADB=1` (a imagem oficial cheia
  seta isso; a nossa NAO tem mariadb — use SQLite ou banco externo).

## Imagem Docker propria (`docker/winker.dockerfile`)

Multi-stage sobre `node:22-bookworm-slim`, roda como usuario `node` (uid 1000), sem chromium,
mariadb embutido, cloudflared, apprise e nscd. O que se perde em relacao a imagem oficial cheia:

| Removido | Funcionalidade que morre |
|---|---|
| chromium | monitor "HTTP(s) - Browser Engine" (real-browser) local — remote browser continua funcionando |
| mariadb-server | banco embutido (usar SQLite ou MariaDB externo) |
| apprise (python) | provider de notificacao "Apprise" (os outros 100+ continuam) |
| cloudflared | Cloudflare Tunnel pela UI |

O estagio de runtime copia **cirurgicamente** `server/ db/ dist/ src/util.js extra/rdap-dns.json
extra/healthcheck.js package.json` + node_modules de producao. Se um merge do upstream introduzir
require de caminho novo fora desses, a imagem quebra no boot — ajustar o COPY.

K8s: `runAsUser: 1000`, `fsGroup: 1000` no volume de `/app/data`, `capabilities.add: ["NET_RAW"]`
para monitores de ping, probe httpGet `/` porta 3001 com `initialDelaySeconds` generoso (~60s+,
migrations rodam no boot).
