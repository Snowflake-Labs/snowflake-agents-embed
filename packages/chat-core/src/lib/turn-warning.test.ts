// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  friendlyConnectorName,
  formatTurnWarning,
  isMcpTurnWarning,
  latestAssistantWarnings,
  mcpServerFqnFromWarning,
  uniqueTurnWarnings,
} from './turn-warning'

const JIRA_FQN = 'DEMO_DB.AGENTS.JIRA_MCP'

const TOOL_NOT_ACCESSIBLE = {
  message: "TOOL_NOT_ACCESSIBLE: JIRA_MCP (mcp_server) - mcp_server DEMO_DB.AGENTS.JIRA_MCP: MCP server 'DEMO_DB.AGENTS.JIRA_MCP' does not exist or access is not authorized for the current role. This is most commonly caused by the current role lacking the required privilege on the referenced object. Ask your administrator to grant USAGE on MCP server DEMO_DB.AGENTS.JIRA_MCP to your role (or to a role you can use).",
}

const OAUTH_003001 = {
  code: '003001',
  message: "User authentication required for MCP server 'DEMO_DB.AGENTS.JIRA_MCP'. Complete OAuth flow to access all tools.",
}

describe('mcpServerFqnFromWarning', () => {
  it('parses the FQN out of Cortex warning 003001', () => {
    expect(mcpServerFqnFromWarning(OAUTH_003001)).toBe(JIRA_FQN)
  })

  it('parses the FQN out of a TOOL_NOT_ACCESSIBLE mcp_server dump', () => {
    expect(mcpServerFqnFromWarning(TOOL_NOT_ACCESSIBLE)).toBe(JIRA_FQN)
  })

  it('parses a quoted MCP server even when the code is not 003001', () => {
    expect(mcpServerFqnFromWarning({ code: '000', message: "MCP server 'A.B.C' ignored" })).toBe('A.B.C')
  })

  it('returns null when there is no three-part FQN', () => {
    expect(mcpServerFqnFromWarning({ code: '003001', message: 'something else' })).toBeNull()
    expect(mcpServerFqnFromWarning({ message: 'TOOL_NOT_ACCESSIBLE: search (cortex_search) - missing' })).toBeNull()
  })
})

describe('friendlyConnectorName', () => {
  it('turns JIRA_MCP into Jira', () => {
    expect(friendlyConnectorName(JIRA_FQN)).toBe('Jira')
  })

  it('prefers a connections displayName and still strips _MCP', () => {
    expect(friendlyConnectorName(JIRA_FQN, 'JIRA_MCP')).toBe('Jira')
  })
})

describe('formatTurnWarning', () => {
  it('rewrites the screenshot TOOL_NOT_ACCESSIBLE dump', () => {
    expect(formatTurnWarning(TOOL_NOT_ACCESSIBLE)).toBe(
      'Jira connector unavailable. Open Connectors and authenticate in Snowflake CoWork.',
    )
  })

  it('rewrites 003001 the same way', () => {
    expect(formatTurnWarning(OAUTH_003001)).toBe(
      'Jira connector unavailable. Open Connectors and authenticate in Snowflake CoWork.',
    )
  })

  it('uses the connections displayName when provided', () => {
    expect(formatTurnWarning(OAUTH_003001, [{ fqn: JIRA_FQN, displayName: 'JIRA_MCP' }])).toBe(
      'Jira connector unavailable. Open Connectors and authenticate in Snowflake CoWork.',
    )
  })

  it('keeps a non-MCP warning to its first sentence', () => {
    expect(formatTurnWarning({ message: 'SQL query queued. Waiting for warehouse to become available.' }))
      .toBe('SQL query queued.')
  })

  it('falls back when the message is empty', () => {
    expect(formatTurnWarning({})).toBe('This answer may be based on incomplete results.')
  })
})

describe('isMcpTurnWarning', () => {
  it('treats 003001 and TOOL_NOT_ACCESSIBLE mcp_server as MCP', () => {
    expect(isMcpTurnWarning(OAUTH_003001)).toBe(true)
    expect(isMcpTurnWarning(TOOL_NOT_ACCESSIBLE)).toBe(true)
    expect(isMcpTurnWarning({ message: 'SQL query queued.' })).toBe(false)
  })
})

describe('uniqueTurnWarnings / latestAssistantWarnings', () => {
  it('drops duplicate code+message pairs', () => {
    expect(uniqueTurnWarnings([OAUTH_003001, OAUTH_003001, TOOL_NOT_ACCESSIBLE])).toEqual([
      OAUTH_003001,
      TOOL_NOT_ACCESSIBLE,
    ])
  })

  it('reads the latest assistant turn', () => {
    expect(latestAssistantWarnings([
      { role: 'user' },
      { role: 'assistant', warnings: [OAUTH_003001] },
      { role: 'user' },
      { role: 'assistant', warnings: [TOOL_NOT_ACCESSIBLE] },
    ])).toEqual([TOOL_NOT_ACCESSIBLE])
  })
})
