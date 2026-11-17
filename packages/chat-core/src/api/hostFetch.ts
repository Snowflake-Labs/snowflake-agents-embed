// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { getHostAdapter } from '../host/hostAdapter.js'

function extraFromInit(init?: RequestInit): Record<string, string> | undefined {
  if (!init?.headers) return undefined
  if (init.headers instanceof Headers) {
    return Object.fromEntries(init.headers.entries())
  }
  if (Array.isArray(init.headers)) {
    return Object.fromEntries(init.headers)
  }
  return { ...init.headers }
}

// Codes where reminting the token cannot possibly help: agent_forbidden is Cortex
// rejecting the (valid) identity for the resource; network_policy_blocked never got
// as far as evaluating identity at all (see cortex-server's upstream-error.ts).
const AUTHORITATIVE_CODES = new Set(['agent_forbidden', 'network_policy_blocked'])

async function isAuthoritativeForbidden(res: Response): Promise<boolean> {
  try {
    const data: unknown = await res.clone().json()
    const code = typeof data === 'object' && data !== null ? (data as { code?: unknown }).code : undefined
    return typeof code === 'string' && AUTHORITATIVE_CODES.has(code)
  } catch {
    return false
  }
}

/**
 * Host-aware fetch: attach the current Snowflake token, and on 401/403 ask the
 * host to remint once (`HostAdapter.onUnauthorized`) then retry with the new
 * token. Used by threads/agents (and any other JSON route) so a mid-session
 * expiry is not unique to `useAgentStream`.
 *
 * Do not remint on `agent_forbidden` or `network_policy_blocked` — see
 * AUTHORITATIVE_CODES above. Reminting updates the React token and re-fires every
 * `snowflakeToken` effect (HistoryList), which burns the edge 60/min limiter.
 */
export async function hostFetch(
  snowflakeToken: string,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const adapter = getHostAdapter()
  const extra = extraFromInit(init)
  const res = await fetch(input, { ...init, headers: adapter.headers(snowflakeToken, extra) })
  if (res.status !== 401 && res.status !== 403) return res
  if (await isAuthoritativeForbidden(res)) return res

  let next: string | null = null
  try {
    next = (await adapter.onUnauthorized?.()) ?? null
  } catch {
    next = null
  }
  if (!next) return res
  return fetch(input, { ...init, headers: adapter.headers(next, extra) })
}
