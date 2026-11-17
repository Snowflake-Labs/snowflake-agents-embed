// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { AgentEntry } from '../snowflake/agent-ref.js'
import { resolveSnowflakeHostMode, snowflakeBase } from '../snowflake/credential.js'

/**
 * Runtime feature flags served from GET /api/config, so they can flip without a client
 * rebuild - see chat-core's lib/featureFlags.ts. Independent of the client's build-time
 * VITE_FF_* vars (which stay the fallback if a host never calls setFeatureFlags()).
 */
export interface CortexFeatureFlags {
  fileUpload: boolean
  deepResearch: boolean
  skills: boolean
  webSearch: boolean
  richComposer: boolean
  nativeStreamFlags: boolean
}

/**
 * The config fields every Cortex-fronting host needs, regardless of how it authenticates
 * or what else it does. Each host's own Config extends this with whatever is specific to
 * its auth story (relay: serviceToken/relaySharedSecret; server: Entra/OBO/bot identity) -
 * see cortex-server/README.md for why AuthMode itself is deliberately NOT here.
 */
export interface CortexRuntimeConfig {
  snowflakeAccount: string
  port: number
  defaultAgentFqn: string
  agentAllowList: AgentEntry[]
  // 'dynamic' = discover agents per-user via SHOW AGENTS (RBAC-filtered);
  // 'static'  = restrict to the admin-curated AGENT_ALLOW_LIST. We default to
  // dynamic and only switch to static when an explicit allow-list is provided.
  agentDiscovery: 'dynamic' | 'static'
  agentsSecondaryOrigin?: string
  featureFlags: CortexFeatureFlags
}

export function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const val = env[key]
  if (!val) throw new Error(`Missing required environment variable: ${key}`)
  return val
}

export function parseCortexRuntimeConfig(env: NodeJS.ProcessEnv): CortexRuntimeConfig {
  const snowflakeAccount = requireEnv(env, 'SNOWFLAKE_ACCOUNT')
  // Fail at boot, not on the first user request, when SNOWFLAKE_HOST_MODE or
  // SNOWFLAKE_HOST is unusable.
  snowflakeBase(snowflakeAccount, env)
  if (/\.privatelink/i.test(snowflakeAccount)) {
    // Inside SPCS a service can't resolve its own account's PrivateLink host
    // (NXDOMAIN). Use the bare ORG-ACCOUNT name; the default 'account' host mode
    // reaches it over SPCS egress.
    console.warn('[config] SNOWFLAKE_ACCOUNT contains ".privatelink"; expected the bare ORG-ACCOUNT name')
  }
  const authMode = env.TEAMS_AUTH_MODE ?? env.AUTH_MODE
  if (resolveSnowflakeHostMode(env) === 'internal' && (authMode === 'production' || authMode === 'local-oauth')) {
    console.warn(
      '[config] SNOWFLAKE_HOST_MODE=internal only accepts the SPCS service token; forwarded user tokens ' +
        'will fail with Snowflake error 395090. Use SNOWFLAKE_HOST_MODE=account for per-user sign-in.',
    )
  }
  const defaultAgentFqn = env.DEFAULT_AGENT_FQN ?? ''

  // AGENT_ALLOW_LIST is a JSON array of {fqn, displayName} objects. When set
  // (and non-empty), it curates a fixed set of agents and puts discovery in
  // 'static' mode. When absent, agents are discovered per-user via SHOW AGENTS
  // ('dynamic' mode) - defaultAgentFqn is only an initial-selection hint and
  // does NOT force static mode.
  let agentAllowList: AgentEntry[] = []
  let explicitAllowList = false
  if (env.AGENT_ALLOW_LIST) {
    try {
      const parsed = JSON.parse(env.AGENT_ALLOW_LIST)
      if (Array.isArray(parsed) && parsed.length) {
        agentAllowList = parsed
        explicitAllowList = true
      }
    } catch {
      // misconfigured JSON — leave empty so the host still starts
    }
  }
  if (!agentAllowList.length && defaultAgentFqn) {
    agentAllowList = [{ fqn: defaultAgentFqn, displayName: defaultAgentFqn }]
  }

  return {
    snowflakeAccount,
    port: parseInt(env.PORT ?? '3000', 10),
    defaultAgentFqn,
    agentAllowList,
    agentDiscovery: explicitAllowList ? 'static' : 'dynamic',
    agentsSecondaryOrigin: env.AGENTS_SECONDARY_ORIGIN || undefined,
    featureFlags: {
      fileUpload: env.FF_FILE_UPLOAD === 'true',
      deepResearch: env.FF_DEEP_RESEARCH === 'true',
      skills: env.FF_SKILLS === 'true',
      webSearch: env.FF_WEB_SEARCH === 'true',
      richComposer: env.FF_RICH_COMPOSER === 'true',
      nativeStreamFlags: env.FF_NATIVE_STREAM_FLAGS === 'true',
    },
  }
}
