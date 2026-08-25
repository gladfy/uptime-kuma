############################################################
# Imagem Winker do Uptime Kuma — leve, self-contained, k8s
#
# Diferencas da oficial (louislam/uptime-kuma:2):
#   - build do frontend acontece AQUI (a oficial espera dist/ pronto do CI)
#   - sem chromium (real-browser local), mariadb embutido, apprise,
#     cloudflared, nscd/sudo — ver tabela no CLAUDE.md
#   - roda como usuario node (uid 1000) por padrao
#
# Build:  docker build -f docker/winker.dockerfile -t tiwinker/uptime-kuma:local .
# K8s:    runAsUser 1000, fsGroup 1000 em /app/data,
#         capabilities.add: ["NET_RAW"] p/ monitores de ping
############################################################
ARG NODE_IMAGE=node:22-bookworm-slim

############################################################
# 1) Build do frontend (precisa das devDependencies / vite)
############################################################
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY . .
RUN npm run build

############################################################
# 2) node_modules so de producao
############################################################
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
# --omit=optional derruba deps que so servem a auths que nao usamos
# (ex.: @aws-sdk/* do mongodb, so p/ MONGODB-AWS/Atlas IAM) — ~16 MB.
# O prune abaixo tira artefato que o runtime nunca le (~20 MB); LICENSEs ficam.
RUN npm ci --omit=dev --omit=optional --no-fund --no-audit && \
    npm cache clean --force && \
    find node_modules -type f \( -name "*.map" -o -name "*.d.ts" -o -name "*.d.mts" \
        -o -name "*.d.cts" -o -name "*.md" -o -name "*.markdown" \) -delete && \
    find node_modules -type d \( -name test -o -name tests -o -name __tests__ \
        -o -name ".github" \) -prune -exec rm -rf {} +

############################################################
# 3) Runtime
############################################################
FROM ${NODE_IMAGE} AS release
WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/gladfy/uptime-kuma"
LABEL org.opencontainers.image.vendor="Winker"

ENV NODE_ENV=production \
    UPTIME_KUMA_IS_CONTAINER=1

# iputils-ping    = monitor de ping (binario com file-capability cap_net_raw)
# dumb-init       = PID 1 decente (zumbis/sinais)
# ca-certificates = validacao TLS dos monitores https
# tzdata          = suporte a TZ=America/Sao_Paulo etc.
RUN apt-get update && \
    apt-get install --yes --no-install-recommends \
        dumb-init \
        iputils-ping \
        ca-certificates \
        tzdata && \
    rm -rf /var/lib/apt/lists/*

# Copia cirurgica: so o que o server usa em runtime.
# (se um merge do upstream exigir caminho novo, ajustar aqui — ver CLAUDE.md)
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist         ./dist
COPY --chown=node:node server                          ./server
COPY --chown=node:node db                              ./db
COPY --chown=node:node src/util.js                     ./src/util.js
COPY --chown=node:node extra/rdap-dns.json extra/healthcheck.js ./extra/
COPY --chown=node:node package.json                    ./package.json

# /app/data e o volume de estado (sqlite, uploads, db-config.json)
RUN mkdir ./data && chown node:node ./data

USER node

EXPOSE 3001
# k8s ignora HEALTHCHECK (use probe httpGet / — o server responde 302);
# fica aqui para docker compose / docker run
HEALTHCHECK --interval=60s --timeout=30s --start-period=180s --retries=5 \
    CMD ["node", "extra/healthcheck.js"]

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server/server.js"]
