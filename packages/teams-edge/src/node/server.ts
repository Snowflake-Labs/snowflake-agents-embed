// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Entry point for the self-hosted edge. Run: tsx src/node/server.ts (see apps/teams/edge.Dockerfile).
import { serve } from '@hono/node-server'
import { createNodeEdge } from './app'
import { loadNodeConfig } from './config'
import { openSqliteKv } from './sqlite-kv'

process.umask(0o077)

const config = loadNodeConfig(process.env)
const kv = openSqliteKv({ dir: config.dataDir })
const edge = await createNodeEdge({
  publicOrigin: config.publicOrigin,
  tabDistRoot: config.tabDistRoot,
  trustedProxyHops: config.trustedProxyHops,
  env: { ...config.env, BOT_LINKS: kv },
})

const server = serve(
  {
    port: config.port,
    hostname: config.host,
    fetch: (request: Request, bindings: { incoming: { socket: { remoteAddress?: string } } }) =>
      edge.handle(request, bindings?.incoming?.socket?.remoteAddress ?? null),
  },
  (info) => console.log(`teams-edge listening on ${info.address}:${info.port} for ${config.publicOrigin}`),
)

function shutdown(): void {
  server.close(() => {
    kv.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
