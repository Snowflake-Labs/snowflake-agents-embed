// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { logSafeError } from '@snowflake-agents-embed/cortex-server/http/log-safe-error'
import { BodyTooLargeError, readTextCapped } from './body-limit'
import { filterUpstreamResponse } from './filter-headers'
import { REQUEST_ALLOW } from './strip-headers'
import { EDGE_SESSION_HEADER, openEdgeSession } from './edge-session'
import {
  getLinkedToken,
  mintLinkCode,
  verifyBotRequest,
  linkKey,
  type BotIdentity,
  type BotLinkEnv,
} from './bot-link'
import { defaultRuntime, type EdgeRuntime } from './runtime'
import { canonicalizePath, isDeniedTokenApiPath } from './path'
//
// Edge proxy: /api/* → SPCS
//
// SPCS ingress strips Access-Control-Allow-Origin from app responses AND requires
// Snowflake session auth (cookie or token). Direct browser calls fail on both counts.
// This proxy solves both: same-origin to the browser, and authenticates to SPCS ingress
// using SPCS_PAT, and injects the user's Snowflake token (decrypted from the edge session)
// as X-User-Access-Token for Cortex on-behalf-of calls. The browser never holds that token.
//
// Runtime secrets (Worker: apps/teams/scripts/set-edge-secrets.sh):
//   SPCS_BASE — full origin of the SPCS endpoint, e.g. https://xyz.snowflakecomputing.app,
//               or the privatelink_ingress_url origin behind a private upstream
//   SPCS_PAT  — Snowflake PAT for SPCS ingress auth (replaces browser Authorization header)
//   ALLOWED_ORIGIN — optional extra origin (in addition to this edge's origin)
//   EDGE_SESSION_SECRET — HMAC key for the edge session minted by /token/exchange; required
//                         on every browser /api/* request before SPCS_PAT is attached
//   Bot per-user identity (all optional; when BOT_LINKS, BOT_LINK_SECRET and BOT_APP_ID are
//   absent the bot path behaves as before and the server falls back to its shared credential):
//   BOT_LINKS (KV binding), BOT_LINK_SECRET, BOT_APP_ID, plus the OBO_* / AZURE_TENANT_ID /
//   SNOWFLAKE_SCOPE secrets used by /token/exchange.
//   With rt.requireBotVerify, BOT_APP_ID is required even without bot links.
//
// Build env: VITE_SPCS_BASE must be empty so the SPA uses relative /api/* URLs.

export interface ApiEnv extends BotLinkEnv {
  SPCS_BASE: string
  SPCS_PAT: string
  ALLOWED_ORIGIN?: string
  EDGE_SESSION_SECRET: string
}

const MAX_BOT_BODY_BYTES = 1_000_000

/** An extra origin must be a bare https origin (no wildcard, path or credentials); anything else is ignored. */
export function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' || u.username || u.password || u.hostname.includes('*')) return null
    if (u.origin !== value.replace(/\/$/, '')) return null
    return u.origin
  } catch {
    return null
  }
}

function allowedOrigins(requestUrl: URL, env: ApiEnv): Set<string> {
  const allowed = new Set<string>([requestUrl.origin])
  const extra = normalizeOrigin(env.ALLOWED_ORIGIN)
  if (extra) allowed.add(extra)
  return allowed
}

// Pages-style alias kept for the existing tests and any caller still using the old shape.
export const onRequest = (context: { request: Request; env: ApiEnv }): Promise<Response> =>
  handleApi(context.request, context.env)

export async function handleApi(
  request: Request,
  env: ApiEnv,
  rt: EdgeRuntime = defaultRuntime,
): Promise<Response> {
  if (!env.SPCS_BASE) {
    return Response.json({ error: 'Proxy misconfigured: missing SPCS_BASE' }, { status: 500 })
  }
  if (!env.SPCS_PAT) {
    return Response.json({ error: 'Proxy misconfigured: missing SPCS_PAT' }, { status: 500 })
  }

  if (!env.EDGE_SESSION_SECRET) {
    return Response.json({ error: 'Proxy misconfigured: missing EDGE_SESSION_SECRET' }, { status: 500 })
  }

  const url = new URL(request.url)
  const pathname = canonicalizePath(url.pathname)
  if (pathname === null) {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }
  const origin = request.headers.get('Origin')
  const isBotEndpoint = pathname === '/api/bot/messages'
  // Belt-and-suspenders with router.ts: the edge serves /token/exchange itself;
  // the SPCS route would hand back a raw Snowflake token.
  if (isDeniedTokenApiPath(pathname)) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  let userToken: string | undefined
  let linkCode: string | undefined
  let botIdentity: BotIdentity | undefined
  let botBody: string | undefined

  if (isBotEndpoint) {
    // Bot Framework calls carry no Origin; the container fully verifies the JWT.
    const authorization = request.headers.get('Authorization') ?? ''
    if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]*$/.test(authorization)) {
      console.error('bot request rejected: missing or malformed Bearer token')
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const kv = env.BOT_LINKS
    const linking = Boolean(kv && env.BOT_LINK_SECRET && env.BOT_APP_ID)
    if (linking || rt.requireBotVerify) {
      if (!env.BOT_APP_ID) {
        console.error('Edge misconfigured: BOT_APP_ID is required to verify bot requests')
        return Response.json({ error: 'Proxy misconfigured' }, { status: 500 })
      }
      try {
        botBody = await readTextCapped(request, MAX_BOT_BODY_BYTES)
      } catch (err) {
        if (err instanceof BodyTooLargeError) return Response.json({ error: 'Payload too large' }, { status: 413 })
        throw err
      }
      let activity: unknown
      try {
        activity = JSON.parse(botBody)
      } catch {
        return Response.json({ error: 'Bad request' }, { status: 400 })
      }
      // Only the edge-verified identity is used: the activity body alone is attacker-controlled.
      botIdentity = (await verifyBotRequest(authorization, env.BOT_APP_ID, activity)) ?? undefined
      if (!botIdentity) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
    }
    if (kv && env.BOT_LINK_SECRET && botIdentity && linking) {
      const { AZURE_TENANT_ID, OBO_CLIENT_ID, OBO_CLIENT_SECRET, SNOWFLAKE_SCOPE } = env
      if (!AZURE_TENANT_ID || !OBO_CLIENT_ID || !OBO_CLIENT_SECRET || !SNOWFLAKE_SCOPE) {
        console.error('Edge misconfigured for bot links')
        return Response.json({ error: 'Proxy misconfigured' }, { status: 500 })
      }
      try {
        const linked = await getLinkedToken(kv, botIdentity.tid, botIdentity.oid, env.BOT_LINK_SECRET, {
          AZURE_TENANT_ID,
          OBO_CLIENT_ID,
          OBO_CLIENT_SECRET,
          SNOWFLAKE_SCOPE,
        })
        if (linked.linked) userToken = linked.token
        else linkCode = await mintLinkCode(botIdentity.tid, botIdentity.oid, env.BOT_LINK_SECRET)
      } catch (err) {
        logSafeError('Bot link refresh failed', err)
        return Response.json({ error: 'Token refresh unavailable' }, { status: 503, headers: { 'Retry-After': '5' } })
      }
    }
  } else {
    // Browsers omit Origin on same-origin GET/HEAD; Sec-Fetch-Site is browser-set and unforgeable by page scripts.
    const sameOriginRead =
      !origin &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      request.headers.get('Sec-Fetch-Site') === 'same-origin'
    if (!sameOriginRead && (!origin || !allowedOrigins(url, env).has(origin))) {
      return Response.json({ error: 'Forbidden origin' }, { status: 403 })
    }
    const session = request.headers.get(EDGE_SESSION_HEADER)
    const opened = session ? await openEdgeSession(session, env.EDGE_SESSION_SECRET) : null
    if (!opened) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    userToken = opened.snowflakeToken
  }

  const upstream = `${env.SPCS_BASE}${url.pathname}${url.search}`

  // Build clean headers: strip browser-specific fetch metadata, replace Authorization
  // with the PAT for SPCS ingress, keep X-User-Access-Token for Cortex OBO.
  //
  // Special case for the bot endpoint: the Bot Framework sends its own JWT in
  // Authorization. We can't pass two Authorization values, so we stash the original
  // in X-Bot-Auth and the Hono bot route restores it before the BF adapter validates it.
  const headers = new Headers()
  for (const [key, value] of request.headers.entries()) {
    if (REQUEST_ALLOW.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  }
  // Never trust a client-supplied value: it is the session's token or nothing.
  headers.delete('X-User-Access-Token')
  headers.delete('X-Link-Code')
  if (botBody !== undefined) headers.delete('Content-Length')
  if (userToken) headers.set('X-User-Access-Token', userToken)
  if (linkCode) headers.set('X-Link-Code', linkCode)
  if (isBotEndpoint) {
    const originalAuth = request.headers.get('Authorization')
    if (originalAuth) headers.set('X-Bot-Auth', originalAuth)
  }
  headers.set('Authorization', `Snowflake Token="${env.SPCS_PAT}"`)
  const clientIp = rt.clientIp(request)
  if (clientIp) headers.set('X-Agents-Client-Ip', clientIp)

  // duplex is required for streaming request bodies; workers-types' RequestInit lacks it.
  // redirect: 'manual' so X-User-Access-Token / X-Bot-Auth are never replayed to a 3xx target.
  const init: RequestInit & { duplex: 'half' } = {
    method: request.method,
    headers,
    body: botBody ?? request.body,
    duplex: 'half',
    redirect: 'manual',
  }
  const proxyReq = new Request(upstream, init)

  const response = await rt.upstreamFetch(proxyReq)
  if (response.status >= 300 && response.status < 400) {
    return Response.json({ error: 'Bad gateway' }, { status: 502 })
  }
  // The server asks for an unlink ("sign out") with a response header; it is internal only.
  if (response.headers.has('X-Unlink')) {
    if (botIdentity && env.BOT_LINKS) await env.BOT_LINKS.delete(linkKey(botIdentity.tid, botIdentity.oid))
  }
  return filterUpstreamResponse(response)
}
