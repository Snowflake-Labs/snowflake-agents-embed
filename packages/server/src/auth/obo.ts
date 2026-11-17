// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Config } from '../config.js'
import type { EntraPayload } from './entra.js'

export interface SnowflakeTokenResult {
  snowflakeToken: string
  expiresIn: number
}

export class OboExchangeError extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, code?: string) {
    super('OBO exchange failed')
    this.name = 'OboExchangeError'
    this.status = status
    this.code = code
  }
}

/**
 * Keep in lockstep with packages/teams-edge/src/core/exchange.ts — same grant,
 * same response checks, same sanitized error. Do not merge into cortex-server
 * (auth strategy stays host-local; see that package's README).
 */
export function parseOboTokenResponse(data: unknown, requestedScope: string): SnowflakeTokenResult {
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
  const needed = requestedScope.split(/\s+/).filter(Boolean)
  if (needed.some((scope) => !granted.has(scope))) {
    throw new Error('OBO response did not grant the requested Snowflake scope')
  }
  return { snowflakeToken: rec.access_token, expiresIn }
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

export async function exchangeOnBehalfOf(
  teamsEntraToken: string,
  config: Config,
  verified: EntraPayload,
): Promise<SnowflakeTokenResult> {
  // Callers must have already run createEntraValidator. A missing payload is a
  // programming error — never exchange a raw, unvalidated assertion.
  if (!verified || typeof verified !== 'object') {
    throw new Error('OBO exchange requires a verified Entra payload')
  }

  const url = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: config.oboClientId,
    client_secret: config.oboClientSecret,
    assertion: teamsEntraToken,
    scope: config.snowflakeScope,
    requested_token_use: 'on_behalf_of',
  })

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    const code = entraErrorCode(text)
    console.error('OBO exchange failed', { status: res.status, code })
    throw new OboExchangeError(res.status, code)
  }

  const data = await res.json()
  return parseOboTokenResponse(data, config.snowflakeScope)
}
