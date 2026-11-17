// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  authorizationsStatement,
  integrationFromDescribeResult,
  parseUserIntegrationAuthorizations,
  resolveMcpConnectionStatus,
} from './mcp-authorizations.js'
import type { SnowflakeCredential } from './credential.js'

const OAUTH: SnowflakeCredential = { token: 'tok', tokenType: 'OAUTH' }
const MCP = 'DEMO_DB.AGENTS.JIRA_MCP'
const INTEGRATION = 'JIRA_MCP_INTEGRATION'

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseUserIntegrationAuthorizations', () => {
  it('marks CONNECTED as true', () => {
    const map = parseUserIntegrationAuthorizations(JSON.stringify([
      { integrationName: INTEGRATION, status: 'CONNECTED' },
    ]))
    expect(map.get(INTEGRATION)).toBe(true)
  })

  it('marks NOT_CONNECTED and NEEDS_REAUTH as false', () => {
    const map = parseUserIntegrationAuthorizations(JSON.stringify([
      { integrationName: 'A', status: 'NOT_CONNECTED' },
      { integrationName: 'B', status: 'NEEDS_REAUTH' },
    ]))
    expect(map.get('A')).toBe(false)
    expect(map.get('B')).toBe(false)
  })

  it('returns an empty map on invalid JSON', () => {
    expect(parseUserIntegrationAuthorizations('not-json').size).toBe(0)
    expect(parseUserIntegrationAuthorizations('{}').size).toBe(0)
  })
})

describe('integrationFromDescribeResult', () => {
  it('reads INTEGRATION', () => {
    expect(integrationFromDescribeResult({
      resultSetMetaData: { rowType: [{ name: 'NAME' }, { name: 'INTEGRATION' }] },
      data: [['JIRA_MCP', INTEGRATION]],
    })).toBe(INTEGRATION)
  })

  it('reads API_INTEGRATION', () => {
    expect(integrationFromDescribeResult({
      resultSetMetaData: { rowType: [{ name: 'api_integration' }] },
      data: [[INTEGRATION]],
    })).toBe(INTEGRATION)
  })

  it('returns null for a missing or unsafe ident', () => {
    expect(integrationFromDescribeResult({ data: [] })).toBeNull()
    expect(integrationFromDescribeResult({
      resultSetMetaData: { rowType: [{ name: 'INTEGRATION' }] },
      data: [["O'REILLY"]],
    })).toBeNull()
  })
})

describe('authorizationsStatement', () => {
  it('single-quotes the JSON array of integration names', () => {
    expect(authorizationsStatement([INTEGRATION]))
      .toBe(`SELECT SYSTEM$GET_USER_INTEGRATION_AUTHORIZATIONS('["${INTEGRATION}"]')`)
  })

  it('drops names that are not unquoted identifiers', () => {
    expect(authorizationsStatement(["O'REILLY", INTEGRATION]))
      .toBe(`SELECT SYSTEM$GET_USER_INTEGRATION_AUTHORIZATIONS('["${INTEGRATION}"]')`)
  })
})

describe('resolveMcpConnectionStatus', () => {
  const server = { fqn: MCP, displayName: 'JIRA' }

  it('returns connected true when the integration status is CONNECTED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const statement = JSON.parse(String(init.body)).statement as string
      if (statement.includes('DESCRIBE EXTERNAL MCP SERVER')) {
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'INTEGRATION' }] },
          data: [[INTEGRATION]],
        })
      }
      if (statement.includes('GET_USER_INTEGRATION_AUTHORIZATIONS')) {
        expect(statement).toContain(`'["${INTEGRATION}"]'`)
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'SYSTEM$GET_USER_INTEGRATION_AUTHORIZATIONS' }] },
          data: [[JSON.stringify([{ integrationName: INTEGRATION, status: 'CONNECTED' }])]],
        })
      }
      return jsonRes({}, 500)
    }))

    await expect(resolveMcpConnectionStatus('acct', OAUTH, [server])).resolves.toEqual([
      { ...server, connected: true },
    ])
  })

  it('leaves a server disconnected when both DESCRIBE variants fail', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolveMcpConnectionStatus('acct', OAUTH, [server])).resolves.toEqual([
      { ...server, connected: false },
    ])
    // EXTERNAL fails first, then the native fallback is tried and also fails.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const statements = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1].body)).statement as string)
    expect(statements[0]).toContain('DESCRIBE EXTERNAL MCP SERVER')
    expect(statements[1]).toContain('DESCRIBE MCP SERVER')
  })

  it('omits a native (Snowflake-managed) MCP server from the result', async () => {
    const native = { fqn: 'DEMO_DB.AGENTS.DEMO_MCP', displayName: 'DEMO_MCP' }
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const statement = JSON.parse(String(init.body)).statement as string
      if (statement.includes('DESCRIBE EXTERNAL MCP SERVER')) return new Response('nope', { status: 404 })
      if (statement.includes('DESCRIBE MCP SERVER')) {
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'name' }] },
          data: [['DEMO_MCP']],
        })
      }
      return jsonRes({}, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveMcpConnectionStatus('acct', OAUTH, [native])).resolves.toEqual([])
    // No integration to check for a native server, so the authorizations SQL
    // is never issued - just the two DESCRIBE attempts.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('drops a native server from a mixed external+native list', async () => {
    const native = { fqn: 'DEMO_DB.AGENTS.DEMO_MCP', displayName: 'DEMO_MCP' }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const statement = JSON.parse(String(init.body)).statement as string
      if (statement.includes('DESCRIBE EXTERNAL MCP SERVER')) {
        if (statement.includes(server.fqn)) {
          return jsonRes({
            resultSetMetaData: { rowType: [{ name: 'INTEGRATION' }] },
            data: [[INTEGRATION]],
          })
        }
        return new Response('nope', { status: 404 })
      }
      if (statement.includes('DESCRIBE MCP SERVER')) {
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'name' }] },
          data: [['DEMO_MCP']],
        })
      }
      if (statement.includes('GET_USER_INTEGRATION_AUTHORIZATIONS')) {
        expect(statement).toContain(`'["${INTEGRATION}"]'`)
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'SYSTEM$GET_USER_INTEGRATION_AUTHORIZATIONS' }] },
          data: [[JSON.stringify([{ integrationName: INTEGRATION, status: 'CONNECTED' }])]],
        })
      }
      return jsonRes({}, 500)
    }))

    await expect(resolveMcpConnectionStatus('acct', OAUTH, [server, native])).resolves.toEqual([
      { ...server, connected: true },
    ])
  })

  it('leaves a server disconnected when authorizations SQL fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const statement = JSON.parse(String(init.body)).statement as string
      if (statement.includes('DESCRIBE EXTERNAL MCP SERVER')) {
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'INTEGRATION' }] },
          data: [[INTEGRATION]],
        })
      }
      return new Response('nope', { status: 500 })
    }))
    await expect(resolveMcpConnectionStatus('acct', OAUTH, [server])).resolves.toEqual([
      { ...server, connected: false },
    ])
  })

  it('skips an invalid FQN without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolveMcpConnectionStatus('acct', OAUTH, [
      { fqn: 'not-a-fqn', displayName: 'X' },
    ])).resolves.toEqual([{ fqn: 'not-a-fqn', displayName: 'X', connected: false }])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
