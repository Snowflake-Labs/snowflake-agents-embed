// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Edge handler: POST /token/link
//
// Completes the Teams bot sign-in: the tab (running Teams SSO) posts the one-time code the
// edge minted for a chat user plus that user's Entra token. We require both to name the same
// identity, run OBO with offline_access, and keep the refresh token encrypted in KV.
// The browser gets back only { linked: true }.

import { BodyTooLargeError, MAX_TOKEN_BODY_BYTES, readJsonCapped } from './body-limit'
import { createRemoteJWKSet } from 'jose'
import {
  entraJwksUrl,
  parseClientIdList,
  validateEntraToken,
} from '@snowflake-agents-embed/cortex-server/auth/entra-token'
import { createSlidingWindow } from '@snowflake-agents-embed/cortex-server/http/sliding-window'
import { consumeJti, openLinkCode, saveLink, type BotLinkEnv } from './bot-link'
import { exchangeOnBehalfOf } from './obo'
import { defaultRuntime, type EdgeRuntime } from './runtime'

export interface LinkEnv extends BotLinkEnv {
  AZURE_TENANT_ID: string
  OBO_CLIENT_ID: string
  OBO_CLIENT_SECRET: string
  SNOWFLAKE_SCOPE: string
  ENTRA_AUDIENCE_URI?: string
  ENTRA_ALLOWED_CLIENT_IDS?: string
  ENTRA_REQUIRED_SCOPE?: string
}

export const ipWindow = createSlidingWindow({ windowMs: 60_000, max: 30 })
export const identityWindow = createSlidingWindow({ windowMs: 60_000, max: 10 })

function tooMany(retryAfterSec: number): Response {
  return Response.json(
    { error: 'Too many requests' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  )
}

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
export const onRequestPost = (context: { request: Request; env: LinkEnv }): Promise<Response> =>
  handleLink(context.request, context.env)

export async function handleLink(
  request: Request,
  env: LinkEnv,
  rt: EdgeRuntime = defaultRuntime,
): Promise<Response> {
  for (const key of [
    'AZURE_TENANT_ID',
    'OBO_CLIENT_ID',
    'OBO_CLIENT_SECRET',
    'SNOWFLAKE_SCOPE',
    'BOT_LINK_SECRET',
  ] as const) {
    if (!env[key]) {
      console.error('Edge misconfigured', { missing: key })
      return Response.json({ error: 'Edge misconfigured' }, { status: 500 })
    }
  }
  const kv = env.BOT_LINKS
  if (!kv) {
    console.error('Edge misconfigured', { missing: 'BOT_LINKS' })
    return Response.json({ error: 'Edge misconfigured' }, { status: 500 })
  }

  const ip = rt.clientIp(request) ?? 'unknown'
  const ipTake = ipWindow.take(ip)
  if (!ipTake.ok) return tooMany(ipTake.retryAfterSec)

  let body: { code?: string; entraToken?: string } | null
  try {
    body = (await readJsonCapped(request, MAX_TOKEN_BODY_BYTES)) as { code?: string; entraToken?: string } | null
  } catch (err) {
    if (err instanceof BodyTooLargeError) return Response.json({ error: 'Payload too large' }, { status: 413 })
    throw err
  }
  if (!body?.code || !body?.entraToken) {
    return Response.json({ error: 'code and entraToken required' }, { status: 400 })
  }

  const code = await openLinkCode(body.code, env.BOT_LINK_SECRET!)
  if (!code) {
    return Response.json({ error: 'This sign-in link is invalid or has expired.', reason: 'bad_code' }, { status: 400 })
  }

  try {
    const payload = await validateEntraToken(body.entraToken, getJwks(env.AZURE_TENANT_ID), {
      tenantId: env.AZURE_TENANT_ID,
      oboClientId: env.OBO_CLIENT_ID,
      audienceUri: env.ENTRA_AUDIENCE_URI,
      requiredScope: env.ENTRA_REQUIRED_SCOPE || undefined,
      allowedClientIds: parseClientIdList(env.ENTRA_ALLOWED_CLIENT_IDS),
    })
    const tid = String(payload.tid ?? env.AZURE_TENANT_ID)
    const oid = String(payload.oid ?? payload.sub ?? '')
    if (tid !== code.tid || oid !== code.oid) {
      return Response.json(
        { error: 'This sign-in link was issued to a different user.', reason: 'identity_mismatch' },
        { status: 403 },
      )
    }
    const idTake = identityWindow.take(`${tid}:${oid}`)
    if (!idTake.ok) return tooMany(idTake.retryAfterSec)

    if (!(await consumeJti(kv, code.jti))) {
      return Response.json({ error: 'This sign-in link has already been used.', reason: 'used' }, { status: 409 })
    }

    const result = await exchangeOnBehalfOf(body.entraToken, env as any, { offlineAccess: true })
    if (!result.refreshToken) {
      console.error('OBO returned no refresh_token; is offline_access consented for the OBO app?')
      return Response.json(
        { error: 'Sign-in could not be stored.', reason: 'no_refresh_token' },
        { status: 502 },
      )
    }
    await saveLink(
      kv,
      tid,
      oid,
      {
        rt: result.refreshToken,
        at: result.snowflakeToken,
        atExp: Math.floor(Date.now() / 1000) + result.expiresIn,
      },
      env.BOT_LINK_SECRET!,
    )
    return Response.json({ linked: true })
  } catch (err: any) {
    const codeStr = typeof err?.code === 'string' ? err.code : undefined
    return Response.json(
      { error: 'Sign-in failed', status: err?.status ?? 401, ...(codeStr ? { code: codeStr } : {}) },
      { status: 401 },
    )
  }
}
