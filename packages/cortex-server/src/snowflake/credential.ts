// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * The value Snowflake's REST APIs expect in `X-Snowflake-Authorization-Token-Type`.
 *
 * Not every host uses the same one: a service credential is a
 * Programmatic Access Token, the Teams server forwards an OAUTH token from its
 * On-Behalf-Of exchange, and a host authenticating with a signed JWT (e.g. a
 * connected app) needs KEYPAIR_JWT.
 */
export type SnowflakeTokenType = 'OAUTH' | 'PROGRAMMATIC_ACCESS_TOKEN' | 'KEYPAIR_JWT'

/**
 * A resolved Snowflake credential: the token, plus what kind of token it is.
 *
 * Shared code takes this rather than a host's own auth-mode enum. That is the whole
 * point of the type - `relay` distinguishes 'pat' | 'external-oauth' and `server`
 * distinguishes 'local-pat' | 'local-oauth' | 'production', and those unions must NOT
 * be merged: a single shared enum would mean every new host integration has to edit a
 * type in this package. Each host maps its own mode to a SnowflakeTokenType at its
 * boundary and passes the result in.
 *
 * Before this existed, `relay` funnelled every call through a `snowflakeHeaders(token,
 * mode)` helper while `server` hardcoded the header object at six separate call sites -
 * which is exactly how the two drifted.
 */
export interface SnowflakeCredential {
  readonly token: string
  readonly tokenType: SnowflakeTokenType
}

/** The single place Snowflake auth headers are built. */
export function snowflakeHeaders(
  cred: SnowflakeCredential,
  accept: 'application/json' | 'text/event-stream' = 'application/json',
): Record<string, string> {
  return {
    Authorization: `Bearer ${cred.token}`,
    'X-Snowflake-Authorization-Token-Type': cred.tokenType,
    'Content-Type': 'application/json',
    Accept: accept,
  }
}

/**
 * How the container addresses Snowflake, from SNOWFLAKE_HOST_MODE (unset = 'account').
 *
 * - 'account': the public account host built from SNOWFLAKE_ACCOUNT. Requests leave
 *   through the SPCS egress NAT, so a network policy can allowlist them by IP.
 * - 'internal': the SNOWFLAKE_HOST that SPCS injects. Requests route inside Snowflake and
 *   Snowflake accepts only the SPCS-issued service token (/snowflake/session/token) on this
 *   path. Forwarded External OAuth, PAT and key-pair JWT credentials are rejected with
 *   395090, so it cannot carry per-user identity. Opt-in, for service-identity-only hosts.
 */
export type SnowflakeHostMode = 'account' | 'internal'

export function resolveSnowflakeHostMode(env: NodeJS.ProcessEnv = process.env): SnowflakeHostMode {
  const raw = (env.SNOWFLAKE_HOST_MODE ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'account') return 'account'
  if (raw === 'internal') return 'internal'
  throw new Error(`Invalid SNOWFLAKE_HOST_MODE "${env.SNOWFLAKE_HOST_MODE}" - expected "account" or "internal".`)
}

// A bare DNS name. No scheme, port, path or userinfo can survive this, so the value is
// safe to splice into a URL that carries the user's bearer token.
const HOSTNAME = /^[a-z0-9](?:[a-z0-9_.-]{0,251}[a-z0-9])?$/

/** Validate SNOWFLAKE_HOST, tolerating an `https://` prefix. Throws if it is not a bare host. */
export function parseSnowflakeHost(raw: string | undefined): string {
  const host = (raw ?? '').trim().toLowerCase().replace(/^https:\/\//, '')
  if (!HOSTNAME.test(host) || host.includes('..')) {
    throw new Error(`Invalid SNOWFLAKE_HOST "${raw ?? ''}" - expected a bare hostname.`)
  }
  return host
}

/**
 * Base URL for Snowflake REST calls, per SnowflakeHostMode.
 *
 * Reads the environment on each call so no caller has to thread the mode through; in
 * 'account' mode the result is the same as it has always been.
 */
export function snowflakeBase(account: string, env: NodeJS.ProcessEnv = process.env): string {
  if (resolveSnowflakeHostMode(env) === 'internal') {
    return `https://${parseSnowflakeHost(env.SNOWFLAKE_HOST)}`
  }
  return `https://${account}.snowflakecomputing.com`
}
