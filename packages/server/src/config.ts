// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { parseClientIdList } from '@snowflake-agents-embed/cortex-server/auth/entra-token'
import {
  parseCortexRuntimeConfig,
  requireEnv,
  type CortexRuntimeConfig,
} from '@snowflake-agents-embed/cortex-server/config/runtime'

/**
 * Deliberately NOT shared with packages/relay's AuthMode - the two describe different
 * auth stories (Entra/OBO here, PAT/external-OAuth there), and merging them into one
 * enum would mean every new host integration has to edit a type in
 * packages/cortex-server. See its README for the full argument.
 */
export type AuthMode = 'local-pat' | 'local-oauth' | 'production'

export interface Config extends CortexRuntimeConfig {
  authMode: AuthMode
  /** Bind address. Local modes default to loopback; production defaults to 0.0.0.0. */
  host: string
  botAppId: string
  botAppSecret: string
  tenantId?: string
  jwksUri?: string
  oboClientId: string
  oboClientSecret: string
  snowflakeScope: string
  /** Optional extra Entra audience (App ID URI). Mirrors the tab edge validator. */
  entraAudienceUri?: string
  /** Override the Teams client allow-list checked against azp/appid (default: Teams desktop + web). */
  entraAllowedClientIds?: string[]
  entraRequiredScope?: string
  teamsAppId: string
  /** HMAC key for ?s= share snapshots. Unset = link unfurling disabled (fail closed). */
  shareSigningSecret?: string
  /** Explicit CORS allow-list. Never '*' — these are credentialed requests. */
  allowedOrigins: string[]
  // Where the bot's per-user agent selection + Cortex thread chain is persisted, so a
  // container restart or SPCS scale-out doesn't lose it (previously in-memory Maps only).
  botStateTable: string
}

const AUTH_MODES: readonly AuthMode[] = ['local-pat', 'local-oauth', 'production']

export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // TEAMS_AUTH_MODE takes precedence so this and packages/relay's AUTH_MODE stop
  // colliding on one env var with two different sets of legal values (relay's is
  // 'pat' | 'external-oauth'). AUTH_MODE is read as a fallback indefinitely, not
  // removed - it costs one `??` and a live SPCS service's env may not match its
  // checked-in service_spec.yml at any given moment.
  //
  // No silent default: an omitted or misspelled value used to boot as local-pat
  // (no Entra check, every query under the shared PAT). Require an explicit
  // setting and reject anything outside the closed set.
  const rawMode = env.TEAMS_AUTH_MODE ?? env.AUTH_MODE
  if (!rawMode) {
    throw new Error('Missing required environment variable: TEAMS_AUTH_MODE (or AUTH_MODE)')
  }
  if (!AUTH_MODES.includes(rawMode as AuthMode)) {
    throw new Error(
      `Invalid TEAMS_AUTH_MODE "${rawMode}" — expected 'local-pat', 'local-oauth', or 'production'.`,
    )
  }
  const authMode = rawMode as AuthMode
  const insecure = env.ALLOW_INSECURE_AUTH_MODE === '1'
  // local-pat answers every query under the shared PAT and local-oauth skips the Entra gate on
  // some routes; neither may boot in a production image unless explicitly overridden.
  if (authMode !== 'production' && env.NODE_ENV === 'production' && !insecure) {
    throw new Error(
      `TEAMS_AUTH_MODE "${authMode}" is not allowed when NODE_ENV=production. Use 'production', ` +
        'or set ALLOW_INSECURE_AUTH_MODE=1 for a throwaway local container.',
    )
  }
  const defaultHost = authMode === 'production' ? '0.0.0.0' : '127.0.0.1'
  const host = env.HOST || defaultHost
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost'
  if (authMode !== 'production' && !loopback && !insecure) {
    throw new Error(
      `TEAMS_AUTH_MODE "${authMode}" cannot bind ${host}; use 127.0.0.1 or set ALLOW_INSECURE_AUTH_MODE=1.`,
    )
  }
  // Requires SNOWFLAKE_ACCOUNT first, before the auth-mode-specific checks below - a
  // misconfigured production deploy missing both should report the Snowflake account,
  // not Azure, since that's the more fundamental omission.
  const base = parseCortexRuntimeConfig(env)

  if (authMode === 'production' || authMode === 'local-oauth') {
    requireEnv(env, 'AZURE_TENANT_ID')
    requireEnv(env, 'OBO_CLIENT_ID')
    requireEnv(env, 'OBO_CLIENT_SECRET')
    requireEnv(env, 'SNOWFLAKE_SCOPE')
  }

  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  if (authMode === 'production' && allowedOrigins.length === 0) {
    throw new Error('Missing required environment variable: ALLOWED_ORIGINS')
  }
  if (authMode !== 'production' && !allowedOrigins.includes('http://localhost:5173')) {
    allowedOrigins.push('http://localhost:5173')
  }

  return {
    ...base,
    authMode,
    host,
    botAppId: env.BOT_APP_ID ?? '',
    botAppSecret: env.BOT_APP_SECRET ?? '',
    tenantId: env.AZURE_TENANT_ID,
    jwksUri: env.AZURE_TENANT_ID
      ? `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/discovery/v2.0/keys`
      : undefined,
    oboClientId: env.OBO_CLIENT_ID ?? '',
    oboClientSecret: env.OBO_CLIENT_SECRET ?? '',
    snowflakeScope: env.SNOWFLAKE_SCOPE ?? '',
    entraAudienceUri: env.ENTRA_AUDIENCE_URI || undefined,
    entraAllowedClientIds: parseClientIdList(env.ENTRA_ALLOWED_CLIENT_IDS),
    entraRequiredScope: env.ENTRA_REQUIRED_SCOPE || undefined,
    teamsAppId: env.TEAMS_APP_ID ?? '',
    shareSigningSecret: env.SHARE_SIGNING_SECRET || undefined,
    allowedOrigins,
    botStateTable: env.BOT_STATE_TABLE ?? 'SNOWFLAKE_INTELLIGENCE.AGENTS.COWORK_BOT_STATE',
  }
}
