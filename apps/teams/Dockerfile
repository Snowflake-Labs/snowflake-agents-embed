FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder
WORKDIR /app

# Copy every workspace manifest before the sources so `npm ci` is cached
# independently of code changes. Every tracked workspace is listed because
# the root lockfile covers them; omitting any makes `npm ci` fail the lock
# integrity check. chat-core and cortex-server are also required so npm
# workspaces creates the node_modules/@snowflake-agents-embed/* symlinks.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/tab/package.json packages/tab/
COPY packages/chat-core/package.json packages/chat-core/
COPY packages/cortex-server/package.json packages/cortex-server/
RUN npm ci
COPY . .
RUN npm run build:teams

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runner
WORKDIR /app
ENV NODE_ENV=production

# Reinstall from the same lockfile with devDependencies omitted rather than
# copying the builder's node_modules: that tree carries
# playwright, vitest, typescript, and tab's browser deps (vega, react),
# none of which the server needs at runtime. tsx is a runtime dependency
# here (not just a dev convenience) precisely because of the next comment.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/tab/package.json packages/tab/
COPY packages/chat-core/package.json packages/chat-core/
COPY packages/cortex-server/package.json packages/cortex-server/
RUN npm ci --omit=dev

COPY --from=builder --chown=node:node /app/packages/server/dist ./packages/server/dist
COPY --from=builder --chown=node:node /app/packages/tab/dist ./packages/tab/dist
# Neither chat-core nor cortex-server has a build step - server imports their .ts source
# directly (as tsx already does in dev via `tsx watch`), so the runner needs that source
# present and a TS-aware entry point rather than plain `node`. Each package.json comes
# along via the manifest copies above because Node reads the exports map from it to
# resolve the subpaths.
COPY --from=builder /app/packages/chat-core/src ./packages/chat-core/src
COPY --from=builder /app/packages/cortex-server/src ./packages/cortex-server/src
# The runtime only needs node and the local tsx; drop the base image's npm/corepack and their dependency surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1
CMD ["node_modules/.bin/tsx", "packages/server/dist/index.js"]
