// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchMcpConnections, invalidateMcpConnectionsCache } from './mcpConnections'
import { setHostAdapter, resetHostAdapter, type HostAdapter } from '../host/hostAdapter'

const fakeAdapter: HostAdapter = {
  baseUrl: () => 'https://relay.example',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
}

const ATLASSIAN = {
  fqn: 'DEMO_DB.AGENTS.JIRA_MCP',
  displayName: 'JIRA',
  connected: true as boolean | null,
}

beforeEach(() => {
  setHostAdapter(fakeAdapter)
  invalidateMcpConnectionsCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetHostAdapter()
  invalidateMcpConnectionsCache()
})

describe('fetchMcpConnections', () => {
  it('GETs /api/mcp/connections and returns coworkUrl + servers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      coworkUrl: 'https://ai.snowflake.com/myorg/myaccount/#/capabilities/connectors',
      servers: [ATLASSIAN],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchMcpConnections('tok', 'DB.SCH.A')).resolves.toEqual({
      coworkUrl: 'https://ai.snowflake.com/myorg/myaccount/#/capabilities/connectors',
      servers: [ATLASSIAN],
    })
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://relay.example/api/mcp/connections?fqn=DB.SCH.A',
    )
  })

  it('reuses a short TTL cache keyed on token + agent', async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({
      coworkUrl: 'https://ai.snowflake.com/#/capabilities/connectors',
      servers: [],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMcpConnections('tok', 'DB.SCH.A')
    await fetchMcpConnections('tok', 'DB.SCH.A')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await fetchMcpConnections('tok', 'DB.SCH.B')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
