// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Client-facing stand-in for an upstream Snowflake/Cortex error body.
 *
 * Routes used to forward the upstream text verbatim (or a slice of it). That
 * defeated each host's `onError` — which exists so a Cortex/Snowflake outage
 * cannot leak role names, object FQNs, statement handles or generated SQL to
 * the browser. Apply the redaction here, at the pass-through boundary, not
 * only in `onError` (which never runs for a normal `c.json` / `Response`).
 */

export type UpstreamErrorCode =
  | 'agent_forbidden'
  | 'network_policy_blocked'
  | 'host_mode_rejects_user_token'
  | 'thread_not_found'
  | 'upstream_rate_limited'
  | 'upstream_error'

const MESSAGES: Record<UpstreamErrorCode, string> = {
  agent_forbidden: 'You do not have access to that resource.',
  network_policy_blocked: "Your Snowflake account's network policy is blocking this connection. Contact your Snowflake administrator.",
  host_mode_rejects_user_token:
    'Snowflake rejected the signed-in user token. SNOWFLAKE_HOST_MODE=internal only accepts the SPCS service token; set SNOWFLAKE_HOST_MODE=account for per-user sign-in.',
  thread_not_found: 'That thread could not be found.',
  upstream_rate_limited: 'Too many requests. Please wait a moment.',
  upstream_error: 'The upstream service rejected the request.',
}

/**
 * Snowflake REST API codes meaning "network policy rejected the source IP/token"
 * before any user identity was even evaluated (error 390422; see docs/install-teams.md
 * §5, error 4). Distinguishing it from a real auth/identity failure
 * is safe: the numeric code carries no role name, object FQN, statement handle, or
 * SQL — it's the one piece of the upstream body this module can forward.
 */
const NETWORK_POLICY_CODES = new Set(['390422'])

/**
 * 395090 is what the SPCS-internal Snowflake host returns for any credential other than the
 * SPCS-issued service token (forwarded External OAuth, PAT, key-pair JWT). Its own message
 * ("Please use OAuth") is misleading, so surface a distinct code rather than agent_forbidden.
 */
const HOST_MODE_REJECTS_TOKEN_CODES = new Set(['395090'])

function upstreamJsonCode(detail: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(detail)
    const code = (parsed as { code?: unknown } | null)?.code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

export function codeForUpstreamStatus(status: number, detail = ''): UpstreamErrorCode {
  if (status === 401 || status === 403) {
    const snowflakeCode = upstreamJsonCode(detail)
    if (snowflakeCode && NETWORK_POLICY_CODES.has(snowflakeCode)) return 'network_policy_blocked'
    if (snowflakeCode && HOST_MODE_REJECTS_TOKEN_CODES.has(snowflakeCode)) return 'host_mode_rejects_user_token'
    return 'agent_forbidden'
  }
  if (status === 404) return 'thread_not_found'
  if (status === 429) return 'upstream_rate_limited'
  return 'upstream_error'
}

export function redactedUpstreamErrorFrom(status: number, detail: string): Response {
  if (detail) console.error(`Upstream ${status}: ${detail.slice(0, 500)}`)
  const code = codeForUpstreamStatus(status, detail)
  const safeStatus = status >= 400 && status < 600 ? status : 502
  return new Response(JSON.stringify({ error: MESSAGES[code], code }), {
    status: safeStatus,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function redactedUpstreamError(upstream: Response): Promise<Response> {
  const detail = await upstream.text().catch(() => '')
  return redactedUpstreamErrorFrom(upstream.status, detail)
}

/** Success bodies stay verbatim; error bodies are replaced with the closed set above. */
export async function passThroughOrRedact(upstream: Response): Promise<Response> {
  if (upstream.ok) {
    const body = await upstream.text().catch(() => '')
    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return redactedUpstreamError(upstream)
}
