// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Entra → Snowflake token legs shared by /token/exchange (tab) and the bot link flow.
// Mirrors packages/server/src/auth/obo.ts parsing; keep the scope checks in lockstep.

export interface OboEnv {
  AZURE_TENANT_ID: string
  OBO_CLIENT_ID: string
  OBO_CLIENT_SECRET: string
  SNOWFLAKE_SCOPE: string
}

export interface OboResult {
  snowflakeToken: string
  expiresIn: number
  /** Present only when `offline_access` was requested and granted. */
  refreshToken?: string
}

export interface EntraGrantError extends Error {
  status: number
  code?: string
  /** True when Entra rejected the grant itself (4xx), as opposed to a transient failure. */
  permanent: boolean
}

function parseTokenResponse(data: unknown, requiredScope: string): OboResult {
  if (!data || typeof data !== 'object') {
    throw new Error('OBO response missing access_token')
  }
  const rec = data as Record<string, unknown>
  if (typeof rec.access_token !== 'string' || !rec.access_token) {
    throw new Error('OBO response missing access_token')
  }
  const expiresIn = Number(rec.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OBO response missing a valid expires_in')
  }
  const granted = new Set(
    (typeof rec.scope === 'string' ? rec.scope : '').split(/\s+/).filter(Boolean),
  )
  const needed = requiredScope.split(/\s+/).filter(Boolean)
  if (needed.some((scope) => !granted.has(scope))) {
    throw new Error('OBO response did not grant the requested Snowflake scope')
  }
  const refreshToken = typeof rec.refresh_token === 'string' && rec.refresh_token ? rec.refresh_token : undefined
  return { snowflakeToken: rec.access_token, expiresIn, ...(refreshToken ? { refreshToken } : {}) }
}

function entraErrorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown }
    const fromDesc = typeof parsed.error_description === 'string'
      ? parsed.error_description.match(/AADSTS\d+/)?.[0]
      : undefined
    if (fromDesc) return fromDesc
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  } catch {
    /* raw text */
  }
  return undefined
}

async function postToken(label: string, env: OboEnv, body: URLSearchParams, requiredScope: string): Promise<OboResult> {
  const url = `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text()
    const code = entraErrorCode(text)
    console.error(`${label} failed`, { status: res.status, code })
    const err = new Error(`${label} failed`) as EntraGrantError
    err.status = res.status
    err.code = code
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429
    throw err
  }
  return parseTokenResponse(await res.json(), requiredScope)
}

/**
 * `offlineAccess` additionally requests a refresh token so the edge can mint later
 * Snowflake tokens without the user's tab open (bot link flow only).
 */
export async function exchangeOnBehalfOf(
  entraToken: string,
  env: OboEnv,
  opts: { offlineAccess?: boolean } = {},
): Promise<OboResult> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: env.OBO_CLIENT_ID,
    client_secret: env.OBO_CLIENT_SECRET,
    assertion: entraToken,
    scope: opts.offlineAccess ? `${env.SNOWFLAKE_SCOPE} offline_access` : env.SNOWFLAKE_SCOPE,
    requested_token_use: 'on_behalf_of',
  })
  return postToken('OBO exchange', env, body, env.SNOWFLAKE_SCOPE)
}

export async function refreshSnowflakeToken(refreshToken: string, env: OboEnv): Promise<OboResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.OBO_CLIENT_ID,
    client_secret: env.OBO_CLIENT_SECRET,
    refresh_token: refreshToken,
    scope: `${env.SNOWFLAKE_SCOPE} offline_access`,
  })
  return postToken('Refresh grant', env, body, env.SNOWFLAKE_SCOPE)
}
