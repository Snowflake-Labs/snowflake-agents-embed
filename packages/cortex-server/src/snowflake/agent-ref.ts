// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { snowflakeBase } from './credential.js'
import { assertIdentifier } from './path-id.js'

export interface CortexAgentRef { database: string; schema: string; name: string }

export interface AgentEntry { fqn: string; displayName: string; description?: string }

/**
 * Check whether a caller-supplied FQN is in the admin allow-list.
 * Comparison is case-insensitive so admins don't have to worry about case.
 */
export function isAllowedAgent(fqn: string, allowList: AgentEntry[]): boolean {
  if (!fqn || !allowList.length) return false
  const needle = fqn.trim().toUpperCase()
  return allowList.some((e) => e.fqn.trim().toUpperCase() === needle)
}

export type AgentAuthFailure =
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 403; error: string }

export type AgentAuthResult =
  | { ok: true; ref: CortexAgentRef; fqn: string }
  | AgentAuthFailure

/** Parse an FQN, then enforce the static-mode allow-list when one is in force. */
export function resolveAuthorizedAgent(
  fqn: string,
  agentDiscovery: 'static' | 'dynamic',
  allowList: AgentEntry[],
): AgentAuthResult {
  let ref: CortexAgentRef
  try {
    ref = parseAgentRef(fqn)
  } catch {
    return { ok: false, status: 400, error: `Invalid agent FQN: ${fqn}` }
  }
  if (agentDiscovery === 'static' && !isAllowedAgent(fqn, allowList)) {
    return { ok: false, status: 403, error: `Agent not allowed: ${fqn}` }
  }
  return { ok: true, ref, fqn }
}

/**
 * Parse a fully-qualified agent name (`db.schema.name`) into its parts.
 * Throws if any segment is missing or blank so misconfiguration surfaces early
 * rather than producing a malformed Cortex URL.
 */
export function parseAgentRef(fqn: string): CortexAgentRef {
  const parts = (fqn ?? '').split('.').map((p) => p.trim())
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new Error(
      `Invalid agent FQN "${fqn}" — expected "database.schema.name".`,
    )
  }
  const [database, schema, name] = parts
  for (const part of parts) {
    try {
      assertIdentifier(part)
    } catch {
      throw new Error(`Invalid agent FQN "${fqn}" — segments must be unquoted identifiers.`)
    }
  }
  return { database, schema, name }
}

/**
 * Build the Cortex Agents Run URL for a persisted (named) agent object.
 * Agent is identified by the URL path — the request body carries only
 * thread/message state (thread_id, parent_message_id, messages, stream).
 */
export function buildAgentRunUrl(account: string, ref: CortexAgentRef): string {
  return `${snowflakeBase(account)}/api/v2/databases/${encodeURIComponent(ref.database)}/schemas/${encodeURIComponent(ref.schema)}/agents/${encodeURIComponent(ref.name)}:run`
}
