# Self-hosted edge for NETWORK_MODE=privatelink: serves the tab, proxies /api/* to the
# private SPCS ingress and handles /token/*. Build from the repo root:
#   docker build -f apps/teams/edge.Dockerfile -t agents-teams-edge .
#
# Run it hardened, with one replica and an encrypted volume for the bot-link store:
#   docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
#     --tmpfs /tmp -v edge-data:/data --env-file edge.env -p 8080:8080 agents-teams-edge

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/tab/package.json packages/tab/
COPY packages/chat-core/package.json packages/chat-core/
COPY packages/cortex-server/package.json packages/cortex-server/
COPY packages/teams-edge/package.json packages/teams-edge/
RUN npm ci
COPY . .
RUN npm run build -w packages/tab

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    TAB_DIST_ROOT=/app/dist \
    DATA_DIR=/data \
    PORT=8080

# Source-only shared packages run through tsx, so their package.json (exports map) and src
# must both be present. A missing COPY only fails at container start, so build and run this image before releasing.
COPY package.json package-lock.json ./
COPY packages/cortex-server/package.json packages/cortex-server/
COPY packages/teams-edge/package.json packages/teams-edge/
RUN npm ci --omit=dev -w packages/teams-edge --include-workspace-root=false
# The runtime only needs node and the local tsx. The base image's bundled npm/corepack carry
# HIGH CVEs (pacote, sigstore, brace-expansion...) that fail image vulnerability scans.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm
COPY --from=builder /app/packages/cortex-server/src ./packages/cortex-server/src
COPY --from=builder /app/packages/teams-edge/src ./packages/teams-edge/src
COPY --from=builder --chown=node:node /app/packages/tab/dist ./dist

# /data holds the sealed bot-link store. The app refuses a dir that is not owned by `node`
# or is group/world accessible, so create it 0700 here and mount the volume over it.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node_modules/.bin/tsx", "packages/teams-edge/src/node/server.ts"]
