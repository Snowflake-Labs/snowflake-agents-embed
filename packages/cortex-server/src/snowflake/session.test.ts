// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { loginNameFromToken, openSnowflakeSession, parseSessionQuery } from './session.js'
import type { SnowflakeCredential } from './credential.js'

const OAUTH: SnowflakeCredential = { token: 'tok', tokenType: 'OAUTH' }

afterEach(() => { vi.restoreAllMocks() })

function jwtWithSub(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url')
  return `eyJhbGciOiJub25lIn0.${payload}.x`
}

describe('loginNameFromToken', () => {
  it('reads sub from a JWT', () => {
    expect(loginNameFromToken(jwtWithSub('COWORK_TEST_USER'))).toBe('COWORK_TEST_USER')
  })

  it('returns empty for a PAT (not a JWT)', () => {
    expect(loginNameFromToken('not-a-jwt')).toBe('')
  })
})

describe('parseSessionQuery', () => {
  it('maps rowtype/rowset into columns and string rows', () => {
    expect(parseSessionQuery({
      data: {
        rowtype: [{ name: 'INTEGRATION' }, { name: 'URL' }],
        rowset: [['JIRA_MCP_INTEGRATION', 'https://mcp.atlassian.com/v1/mcp']],
      },
    })).toEqual({
      columns: ['INTEGRATION', 'URL'],
      rows: [['JIRA_MCP_INTEGRATION', 'https://mcp.atlassian.com/v1/mcp']],
    })
  })
})

describe('openSnowflakeSession', () => {
  it('logs in, executes SQL on the session token, and logs out on close', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { token: 'sess', masterToken: 'mast' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { rowtype: [{ name: 'COL' }], rowset: [['ok']] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const session = await openSnowflakeSession('testacct', {
      token: jwtWithSub('USER1'),
      tokenType: 'OAUTH',
    })
    const result = await session.execute('SELECT 1')
    expect(result).toEqual({ columns: ['COL'], rows: [['ok']] })
    await session.close()

    const loginReq = fetchMock.mock.calls[0]
    expect(String(loginReq[0])).toContain('https://testacct.snowflakecomputing.com/session/v1/login-request')
    const loginBody = JSON.parse(loginReq[1].body)
    expect(loginBody.data.AUTHENTICATOR).toBe('OAUTH')
    expect(loginBody.data.LOGIN_NAME).toBe('USER1')
    expect(loginBody.data.TOKEN).toBe(jwtWithSub('USER1'))

    const queryReq = fetchMock.mock.calls[1]
    expect(String(queryReq[0])).toContain('/queries/v1/query-request')
    expect(queryReq[1].headers.Authorization).toBe('Snowflake Token="sess"')
    expect(JSON.parse(queryReq[1].body)).toEqual({ sqlText: 'SELECT 1', asyncExec: false })

    expect(String(fetchMock.mock.calls[2][0])).toContain('/session/v1/logout-request')
  })

  it('uses PROGRAMMATIC_ACCESS_TOKEN as the login authenticator for a PAT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { token: 'sess' },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await openSnowflakeSession('testacct', { token: 'pat-value', tokenType: 'PROGRAMMATIC_ACCESS_TOKEN' })
    const patBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(patBody.data.AUTHENTICATOR).toBe('PROGRAMMATIC_ACCESS_TOKEN')
  })

  it('throws when login is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      message: 'Invalid OAuth access token',
    }), { status: 200 })))
    await expect(openSnowflakeSession('testacct', OAUTH)).rejects.toThrow(/session login failed/)
  })
})
