// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
export interface TurnWarning {
  code?: string
  message?: string
}

const EMPTY: TurnWarning[] = []
const MCP_UNAVAILABLE = 'connector unavailable. Open Connectors and authenticate in Snowflake CoWork.'

function isThreePartFqn(value: string | undefined): value is string {
  if (!value) return false
  const parts = value.split('.')
  return parts.length === 3 && parts.every((p) => p.length > 0)
}

/** Cortex MCP / TOOL_NOT_ACCESSIBLE dumps name the server as a three-part FQN. */
export function mcpServerFqnFromWarning(warning: TurnWarning): string | null {
  const message = warning.message
  if (!message) return null
  const quoted = message.match(/MCP server '([A-Za-z0-9_$.]+)'/i)?.[1]
  if (isThreePartFqn(quoted)) return quoted
  const tool = message.match(/^\s*TOOL_NOT_ACCESSIBLE\s*:\s*([A-Za-z0-9_$.]+)\s*\(\s*mcp_server\s*\)/i)?.[1]
  if (isThreePartFqn(tool)) return tool
  return null
}

export function isMcpTurnWarning(warning: TurnWarning): boolean {
  if (warning.code === '003001') return true
  if (mcpServerFqnFromWarning(warning)) return true
  return /mcp[_\s]server/i.test(warning.message ?? '')
}

export function uniqueTurnWarnings(warnings?: TurnWarning[]): TurnWarning[] {
  if (!warnings?.length) return EMPTY
  const seen = new Set<string>()
  const out: TurnWarning[] = []
  for (const w of warnings) {
    const key = `${w.code ?? ''}\0${w.message ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(w)
  }
  return out
}

/** Warnings on the latest assistant turn, de-duplicated. Empty when the catalog is showing. */
export function latestAssistantWarnings(turns: { role: string; warnings?: TurnWarning[] }[]): TurnWarning[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') return uniqueTurnWarnings(turns[i].warnings)
  }
  return EMPTY
}

/** DEMO_DB.AGENTS.JIRA_MCP / JIRA_MCP → Jira. */
export function friendlyConnectorName(fqn: string, displayName?: string): string {
  const raw = displayName?.trim() || fqn.split('.').pop() || fqn
  const ident = raw.replace(/_MCP$/i, '')
  const words = ident.split(/_+/).filter(Boolean)
  if (words.length === 0) return 'Connector'
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
}

export function formatTurnWarning(
  warning: TurnWarning,
  connections?: { fqn: string; displayName: string }[],
): string {
  const fqn = mcpServerFqnFromWarning(warning)
  if (fqn) {
    const displayName = connections?.find((c) => c.fqn === fqn)?.displayName
    return `${friendlyConnectorName(fqn, displayName)} ${MCP_UNAVAILABLE}`
  }
  if (isMcpTurnWarning(warning)) {
    return `A connector is unavailable. Open Connectors and authenticate in Snowflake CoWork.`
  }
  const message = warning.message?.trim()
  if (!message) return 'This answer may be based on incomplete results.'
  // Split only on ". " so FQN dots (DEMO_DB.AGENTS.X) stay intact.
  return message.split(/(?<=[.!?])\s+/)[0]?.trim() || message
}
