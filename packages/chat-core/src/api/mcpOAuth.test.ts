// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { finishMcpOAuth, mcpServerFqnFromWarning, openMcpAuthorizationUrl, startMcpOAuth } from './mcpOAuth'
import { setHostAdapter, resetHostAdapter, type HostAdapter } from '../host/hostAdapter'

const fakeAdapter: HostAdapter = {
  baseUrl: () => 'https://relay.example',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
}

beforeEach(() => { setHostAdapter(fakeAdapter) })
afterEach(() => { vi.unstubAllGlobals(); resetHostAdapter() })

describe('mcpServerFqnFromWarning', () => {
  it('parses the FQN out of Cortex warning 003001', () => {
    expect(mcpServerFqnFromWarning({
      code: '003001',
      message: "User authentication required for MCP server 'DEMO_DB.AGENTS.JIRA_MCP'. Complete OAuth flow to access all tools.",
    })).toBe('DEMO_DB.AGENTS.JIRA_MCP')
  })

  it('parses a quoted MCP server even when the code is not 003001', () => {
    expect(mcpServerFqnFromWarning({ code: '000', message: "MCP server 'A.B.C' ignored" })).toBe('A.B.C')
  })

  it('returns null when there is no three-part FQN', () => {
    expect(mcpServerFqnFromWarning({ code: '003001', message: 'something else' })).toBeNull()
  })
})

describe('startMcpOAuth / finishMcpOAuth', () => {
  it('POSTs start and returns the authorization URL and flowId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      authorizationUrl: 'https://acct.snowflakecomputing.com/oauth/start?sfc_code=1',
      flowId: 'flow-1',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await startMcpOAuth('tok', 'DEMO_DB.AGENTS.JIRA_MCP')
    expect(result).toEqual({
      authorizationUrl: 'https://acct.snowflakecomputing.com/oauth/start?sfc_code=1',
      flowId: 'flow-1',
    })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://relay.example/api/mcp/oauth/start')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      mcpServer: 'DEMO_DB.AGENTS.JIRA_MCP',
    })
  })

  it('POSTs finish with the flowId and pasted redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await finishMcpOAuth('tok', 'flow-1', 'https://acct.example/cb?state=1')
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://relay.example/api/mcp/oauth/finish')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      flowId: 'flow-1',
      redirect: 'https://acct.example/cb?state=1',
    })
  })
})

describe('openMcpAuthorizationUrl', () => {
  it('prefers HostAdapter.openExternalUrl', () => {
    const openExternalUrl = vi.fn()
    setHostAdapter({ ...fakeAdapter, openExternalUrl })
    openMcpAuthorizationUrl('https://acct.snowflakecomputing.com/oauth/start')
    expect(openExternalUrl).toHaveBeenCalledWith('https://acct.snowflakecomputing.com/oauth/start')
  })

  it('ignores a non-https URL', () => {
    const openExternalUrl = vi.fn()
    setHostAdapter({ ...fakeAdapter, openExternalUrl })
    openMcpAuthorizationUrl('javascript:alert(1)')
    expect(openExternalUrl).not.toHaveBeenCalled()
  })
})
