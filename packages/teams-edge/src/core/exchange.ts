// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Edge handler: POST /token/exchange
//
// The no-auth edge half of the auth design (see docs/superpowers/specs §51, §393-400):
// this runs BEFORE the browser holds any Snowflake token, so it CANNOT sit behind SPCS
// ingress (public SPCS endpoints always require Snowflake login). Serving it from the same
// edge origin as the SPA makes it same-origin — no CORS needed.
//
// Entra token validation is the shared cortex-server `auth/entra-token` module (also used by
// packages/server), so issuer/audience/scope/azp rules cannot drift. OBO parsing mirrors
// packages/server/src/auth/obo.ts. Secrets live only here, never in the browser bundle.
// Set them with apps/teams/scripts/set-edge-secrets.sh.

import { BodyTooLargeError, MAX_TOKEN_BODY_BYTES, readJsonCapped } from './body-limit'
import { createRemoteJWKSet } from 'jose'
import {
  entraJwksUrl,
  parseClientIdList,
  validateEntraToken,
} from '@snowflake-agents-embed/cortex-server/auth/entra-token'
import { createSlidingWindow } from '@snowflake-agents-embed/cortex-server/http/sliding-window'
import { edgeSessionTtlS, signEdgeSession } from './edge-session'
import { exchangeOnBehalfOf } from './obo'
import { defaultRuntime, type EdgeRuntime } from './runtime'

export interface ExchangeEnv {
  AZURE_TENANT_ID: string
  OBO_CLIENT_ID: string
  OBO_CLIENT_SECRET: string
  SNOWFLAKE_SCOPE: string
  ENTRA_AUDIENCE_URI?: string
  EDGE_SESSION_SECRET: string
  ENTRA_ALLOWED_CLIENT_IDS?: string
  ENTRA_REQUIRED_SCOPE?: string
}

// Per-isolate limits (same trade-off as the container limiter): an outer per-IP bound that
// runs before any JWKS/OBO work, and a tighter per-identity bound once the token is verified.
export const ipWindow = createSlidingWindow({ windowMs: 60_000, max: 30 })
export const identityWindow = createSlidingWindow({ windowMs: 60_000, max: 10 })

function tooMany(retryAfterSec: number): Response {
  return Response.json(
    { error: 'Too many requests' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  )
}

// Cached per isolate, keyed by tenant so a future multi-tenant binding cannot
// reuse the first tenant's JWKS against a different issuer.
const jwksByTenant = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
function getJwks(tenantId: string) {
  let jwks = jwksByTenant.get(tenantId)
  if (!jwks) {
    jwks = createRemoteJWKSet(entraJwksUrl(tenantId))
    jwksByTenant.set(tenantId, jwks)
  }
  return jwks
}

// Pages-style alias kept for the existing tests.
export const onRequestPost = (context: { request: Request; env: ExchangeEnv }): Promise<Response> =>
  handleExchange(context.request, context.env)

export async function handleExchange(
  request: Request,
  env: ExchangeEnv,
  rt: EdgeRuntime = defaultRuntime,
): Promise<Response> {
  for (const key of [
    'AZURE_TENANT_ID',
    'OBO_CLIENT_ID',
    'OBO_CLIENT_SECRET',
    'SNOWFLAKE_SCOPE',
    'EDGE_SESSION_SECRET',
  ] as const) {
    if (!env[key]) {
      console.error('Edge misconfigured', { missing: key })
      return Response.json({ error: 'Edge misconfigured' }, { status: 500 })
    }
  }

  const ip = rt.clientIp(request) ?? 'unknown'
  const ipTake = ipWindow.take(ip)
  if (!ipTake.ok) return tooMany(ipTake.retryAfterSec)

  let body: { entraToken?: string } | null
  try {
    body = (await readJsonCapped(request, MAX_TOKEN_BODY_BYTES)) as { entraToken?: string } | null
  } catch (err) {
    if (err instanceof BodyTooLargeError) return Response.json({ error: 'Payload too large' }, { status: 413 })
    throw err
  }
  if (!body?.entraToken) {
    return Response.json({ error: 'entraToken required' }, { status: 400 })
  }

  try {
    // Signature, tenant issuer, audience, age, `scp` and `azp` are all checked in the shared
    // validator before spending an OBO call.
    const payload = await validateEntraToken(body.entraToken, getJwks(env.AZURE_TENANT_ID), {
      tenantId: env.AZURE_TENANT_ID,
      oboClientId: env.OBO_CLIENT_ID,
      audienceUri: env.ENTRA_AUDIENCE_URI,
      requiredScope: env.ENTRA_REQUIRED_SCOPE || undefined,
      allowedClientIds: parseClientIdList(env.ENTRA_ALLOWED_CLIENT_IDS),
    })
    const tid = String(payload.tid ?? env.AZURE_TENANT_ID)
    const oid = String(payload.oid ?? payload.sub ?? '')
    const idTake = identityWindow.take(`${tid}:${oid}`)
    if (!idTake.ok) return tooMany(idTake.retryAfterSec)
    const result = await exchangeOnBehalfOf(body.entraToken, env)
    // The Snowflake token never leaves the edge: it rides inside the encrypted session and
    // the /api proxy injects it per request. The browser only holds the opaque session.
    const expiresIn = edgeSessionTtlS(result.expiresIn)
    const edgeSession = await signEdgeSession(
      { tid, oid, snowflakeToken: result.snowflakeToken },
      env.EDGE_SESSION_SECRET,
      expiresIn,
    )
    return Response.json({ edgeSession, expiresIn })
  } catch (err: any) {
    const code = typeof err?.code === 'string' ? err.code : undefined
    return Response.json(
      { error: 'OBO exchange failed', status: err?.status ?? 401, ...(code ? { code } : {}) },
      { status: 401 },
    )
  }
}
