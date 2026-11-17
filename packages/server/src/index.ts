// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { parseConfig, type Config } from './config.js'
import { registerTokenRoutes } from './routes/token.js'
import { registerBotRoutes } from './routes/bot.js'
import { forwardedTokenResolver } from './auth/forwarded-token.js'
import { securityHeaders } from '@snowflake-agents-embed/cortex-server/http/security-headers'
import { rateLimiter } from '@snowflake-agents-embed/cortex-server/http/rate-limit'
import { registerCortexApiRoutes } from '@snowflake-agents-embed/cortex-server/http/index.routes'
import { assertHostBackendAdapter, type HostBackendAdapter } from '@snowflake-agents-embed/cortex-server/host/hostBackendAdapter'
import { loadDotEnv } from '@snowflake-agents-embed/cortex-server/config/load-env'
import { isUpstreamTimeoutError } from '@snowflake-agents-embed/cortex-server/snowflake/fetch-timeout'

/**
 * Builds the composed app without binding a port or serving static assets from
 * disk - split out from the module's top-level script so a test can assert on
 * the route table without also parsing real env vars, opening a socket, or
 * needing packages/tab/dist to exist on disk.
 */
export function buildApp(config: Config): Hono {
  const app = new Hono()

  // The seam shared route factories in @snowflake-agents-embed/cortex-server take instead
  // of a raw Config - see that package's README for why this exists.
  const host: HostBackendAdapter = {
    originApp: 'agents_teams',
    credentials: forwardedTokenResolver(config.authMode),
  }
  assertHostBackendAdapter(host)

  // Allow the edge-hosted tab frontend to call the SPCS API cross-origin.
  // The SPCS ingress forwards Access-Control headers from the app response when
  // the app sets them explicitly — it only strips headers the app does NOT set.
  app.use('/api/*', cors({
    origin: config.allowedOrigins,
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-User-Access-Token', 'Accept'],
    exposeHeaders: ['Content-Type'],
    maxAge: 600,
    credentials: true,
  }))

  app.use('*', async (c, next) => {
    for (const [name, value] of Object.entries(securityHeaders({ connectSelfOnly: true }))) c.header(name, value)
    await next()
  })

  // Two tiers. The outer per-IP bound is deliberately generous: the IP is usually a
  // corporate egress NAT shared by a whole tenant, and one page load fires several requests
  // (config, agents, threads, run, title, telemetry). It only caps a single hostile source.
  // The inner bucket is per caller, keyed on a hash of the user's access token, so one noisy
  // user cannot starve colleagues behind the same NAT. Requests without a token (e.g. the
  // token exchange) are governed by the outer limiter alone.
  // Deliberately NOT applied to /api/bot/messages: Bot Framework calls it
  // server-to-server from a shared Azure egress range with no per-user identity
  // in headers, so bucketing by IP there would throttle every Teams user in the
  // tenant together. That route is already gated by BotFrameworkAdapter's own
  // JWT validation. /healthz is the SPCS readiness probe.
  const exempt = (c: { req: { path: string } }) =>
    c.req.path === '/healthz' || c.req.path === '/api/bot/messages'
  app.use('*', rateLimiter({
    windowMs: 60_000,
    max: 600,
    skip: exempt,
  }))
  app.use('*', rateLimiter({
    windowMs: 60_000,
    max: 60,
    skip: (c) => exempt(c) || !c.req.header('X-User-Access-Token'),
    key: (c) =>
      `tok:${createHash('sha256').update(c.req.header('X-User-Access-Token') ?? '').digest('hex').slice(0, 32)}`,
  }))

  // Liveness/readiness probe for SPCS. Body is non-sensitive on purpose —
  // this path is unauthenticated and reachable on the public ingress.
  app.get('/healthz', (c) => c.json({ ok: true }))

  registerTokenRoutes(app, config)
  registerBotRoutes(app, config)
  // Every chat/agent/thread route is shared - see packages/cortex-server/src/http/.
  // Only the Entra token exchange and the Bot Framework webhook above stay host-local.
  registerCortexApiRoutes(app, { config, host })

  // See packages/relay/src/index.ts for why this exists: without it, Hono's
  // default handler serializes err.message (which can include upstream detail)
  // straight into the response body.
  app.onError((err, c) => {
    if (isUpstreamTimeoutError(err)) {
      c.header('Retry-After', '30')
      return c.json({ error: 'Upstream timed out', code: 'upstream_timeout' }, 504)
    }
    console.error('Unhandled server error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  })

  return app
}

/* c8 ignore start -- entrypoint side effects, exercised by running the container, not unit tests */
if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnv({ appDir: 'apps/teams' })
  const config = parseConfig()
  const app = buildApp(config)

  const tabDistRoot = process.env.TAB_DIST_ROOT ?? 'packages/tab/dist'
  app.get('/tab/*', serveStatic({ root: tabDistRoot, rewriteRequestPath: (p) => p.replace('/tab', '') }))
  app.get('/*', serveStatic({ root: tabDistRoot }))

  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`agents-teams-app server listening on ${config.host}:${info.port} [${config.authMode}]`)
  })
}
/* c8 ignore stop */
