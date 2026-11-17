// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { logSafeError } from '@snowflake-agents-embed/cortex-server/http/log-safe-error'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Config } from '../config.js'
import { createBotAdapter, AgentsEmbedBot } from '../bot/handler.js'
import { REQUEST_AUTH_KEY, type RequestAuth } from '../bot/request-auth.js'

function authorizationScheme(value: string | undefined): string {
  if (!value) return 'none'
  const scheme = value.trim().split(/\s+/, 1)[0]
  return scheme || 'none'
}

export function registerBotRoutes(app: Hono, config: Config) {
  if (!config.botAppId) return

  const adapter = createBotAdapter(config)
  const bot = new AgentsEmbedBot(config)

  adapter.onTurnError = async (context, error) => {
    logSafeError('[bot] turn error', error)
    try {
      await context.sendActivity('Something went wrong handling that — try again.')
    } catch (sendErr: unknown) {
      logSafeError('[bot] onTurnError send failed', sendErr)
    }
  }

  app.post('/api/bot/messages', bodyLimit({ maxSize: 1_000_000, onError: (c) => c.json({ error: 'Payload too large' }, 413) }), async (c) => {
    const body = await c.req.json().catch(() => ({}))

    return new Promise<Response>((resolve) => {
      let statusCode = 200
      let responseBody: unknown = ''

      // The edge proxy replaces Authorization with the SPCS PAT so the
      // SPCS ingress lets the request through. It stashes the original Bot Framework
      // JWT in X-Bot-Auth. Restore it here so the BF adapter can validate the token.
      // BotFrameworkAdapter reads req.headers.authorization as a plain property (Express
      // style), NOT via .get() — so we must pass a POJO, not a Web API Headers object.
      const botAuth = c.req.header('X-Bot-Auth')
      const reqHeaders: Record<string, string> = {}
      for (const [k, v] of c.req.raw.headers.entries()) reqHeaders[k.toLowerCase()] = v
      if (botAuth) reqHeaders['authorization'] = botAuth
      console.log(
        `[bot] ${c.req.method} /api/bot/messages x-bot-auth=${botAuth ? 'present' : 'absent'} authorization-scheme=${authorizationScheme(botAuth ?? c.req.header('Authorization'))}`,
      )
      // Set by the Pages proxy from its KV lookup; the proxy strips client-supplied copies.
      const requestAuth: RequestAuth = {
        userToken: c.req.header('X-User-Access-Token') || undefined,
        linkCode: c.req.header('X-Link-Code') || undefined,
        unlink: false,
      }
      const responseHeaders = (base: Record<string, string> = {}) =>
        requestAuth.unlink ? { ...base, 'X-Unlink': '1' } : base
      const rawRequest = {
        method: c.req.method,
        url: c.req.url,
        headers: reqHeaders,
        body,
      }

      // BotFrameworkAdapter expects an Express-style WebResponse (res.status().send()).
      // Hono's c.res is a standard Response — not mutable in that way — so we shim it.
      const res = {
        status(code: number) {
          statusCode = code
          return this
        },
        send(body?: unknown) {
          if (statusCode >= 400) {
            resolve(new Response(JSON.stringify({ error: 'Internal server error' }), {
              status: statusCode,
              headers: responseHeaders({ 'Content-Type': 'application/json' }),
            }))
            return this
          }
          responseBody = body ?? ''
          const encoded = typeof responseBody === 'string'
            ? responseBody
            : JSON.stringify(responseBody)
          resolve(new Response(encoded, {
            status: statusCode,
            headers: responseHeaders({ 'Content-Type': 'application/json' }),
          }))
          return this
        },
        end() {
          resolve(new Response(null, { status: statusCode, headers: responseHeaders() }))
          return this
        },
        // Some BotFrameworkAdapter paths call body() before send()/end().
        body(b: unknown) {
          responseBody = b
          return this
        },
      }

      adapter
        .processActivity({ ...rawRequest, body }, res as any, (ctx) => {
          ctx.turnState.set(REQUEST_AUTH_KEY, requestAuth)
          return bot.run(ctx)
        })
        .catch((err: unknown) => {
          logSafeError('[bot] processActivity error', err)
          resolve(new Response(JSON.stringify({ error: 'Internal server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }))
        })
    })
  })
}
