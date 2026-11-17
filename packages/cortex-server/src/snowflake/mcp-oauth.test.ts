// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  assertMcpServerFqn,
  dollarQuote,
  extractOAuthQueryString,
  finishMcpUserOAuth,
  resetMcpOAuthFlows,
  startMcpUserOAuth,
} from './mcp-oauth.js'
import type { SnowflakeCredential } from './credential.js'

const OAUTH: SnowflakeCredential = { token: 'tok', tokenType: 'OAUTH' }
const MCP = 'DEMO_DB.AGENTS.JIRA_MCP'
const AUTH_URL = 'https://testacct.snowflakecomputing.com/oauth/start?sfc_code=abc'

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function loginOk() {
  return jsonRes({ success: true, data: { token: 'sess', masterToken: 'mast' } })
}

function describeOk(integration = 'JIRA_MCP_INTEGRATION') {
  return jsonRes({
    success: true,
    data: {
      rowtype: [{ name: 'NAME' }, { name: 'INTEGRATION' }],
      rowset: [['JIRA_MCP', integration]],
    },
  })
}

function startOk(url = AUTH_URL) {
  return jsonRes({
    success: true,
    data: { rowtype: [{ name: 'SYSTEM$START_USER_OAUTH_FLOW' }], rowset: [[url]] },
  })
}

function finishOk() {
  return jsonRes({
    success: true,
    data: { rowtype: [{ name: 'SYSTEM$FINISH_OAUTH_FLOW' }], rowset: [['']] },
  })
}

function logoutOk() {
  return jsonRes({})
}

afterEach(async () => {
  await resetMcpOAuthFlows()
  vi.restoreAllMocks()
})

describe('assertMcpServerFqn', () => {
  it('accepts a three-part unquoted FQN', () => {
    expect(assertMcpServerFqn(` ${MCP} `)).toBe(MCP)
  })

  it.each(['nope', "DB.SCH.O'REILLY", 'DB.SCH.A\\B', 'A.B', '1DB.SCH.NAME'])(
    'rejects %j',
    (fqn) => {
      expect(() => assertMcpServerFqn(fqn)).toThrow(/Invalid MCP server name/)
    },
  )
})

describe('dollarQuote', () => {
  it('wraps a value so a nested $$ cannot close the literal', () => {
    expect(dollarQuote('foo')).toBe('$oauth$foo$oauth$')
    expect(dollarQuote('a$oauth$b')).toBe('$oauthx$a$oauth$b$oauthx$')
  })
})

describe('extractOAuthQueryString', () => {
  it('strips the query from a full https URL', () => {
    expect(extractOAuthQueryString('https://acct.snowflakecomputing.com/oauth/complete?state=1&code=2'))
      .toBe('state=1&code=2')
  })

  it('accepts a bare query string, with or without a leading ?', () => {
    expect(extractOAuthQueryString('state=1&code=2')).toBe('state=1&code=2')
    expect(extractOAuthQueryString('?state=1&code=2')).toBe('state=1&code=2')
  })

  it('rejects an empty paste or a URL with no query', () => {
    expect(() => extractOAuthQueryString('')).toThrow(/Paste the URL/)
    expect(() => extractOAuthQueryString('https://acct.snowflakecomputing.com/oauth/complete')).toThrow(/Paste the URL/)
  })
})

describe('startMcpUserOAuth / finishMcpUserOAuth', () => {
  it('describes the MCP server, starts the user OAuth flow, and finishes it in the same session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(describeOk())
      .mockResolvedValueOnce(startOk())
      .mockResolvedValueOnce(finishOk())
      .mockResolvedValueOnce(logoutOk())
    vi.stubGlobal('fetch', fetchMock)

    const started = await startMcpUserOAuth('testacct', OAUTH, MCP)
    expect(started.authorizationUrl).toBe(AUTH_URL)
    expect(started.flowId).toMatch(/^[0-9a-f-]{36}$/)

    const describeSql = JSON.parse(fetchMock.mock.calls[1][1].body).sqlText
    expect(describeSql).toBe(`DESCRIBE EXTERNAL MCP SERVER IDENTIFIER('${MCP}')`)
    const startSql = JSON.parse(fetchMock.mock.calls[2][1].body).sqlText
    expect(startSql).toContain('SYSTEM$START_USER_OAUTH_FLOW')
    expect(startSql).toContain('JIRA_MCP_INTEGRATION')

    await finishMcpUserOAuth(OAUTH, started.flowId, 'https://acct.example/cb?state=1&code=2')
    const finishSql = JSON.parse(fetchMock.mock.calls[3][1].body).sqlText
    expect(finishSql).toBe('SELECT SYSTEM$FINISH_OAUTH_FLOW($oauth$state=1&code=2$oauth$)')
    expect(String(fetchMock.mock.calls[4][0])).toContain('/session/v1/logout-request')
  })

  it('rejects a malformed MCP FQN without opening a session', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(startMcpUserOAuth('testacct', OAUTH, 'not-a-fqn')).rejects.toMatchObject({
      name: 'McpOAuthError',
      status: 400,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not let a different credential finish the flow', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(describeOk())
      .mockResolvedValueOnce(startOk())
    vi.stubGlobal('fetch', fetchMock)
    const started = await startMcpUserOAuth('testacct', OAUTH, MCP)
    await expect(finishMcpUserOAuth({ token: 'other', tokenType: 'OAUTH' }, started.flowId, 'state=1'))
      .rejects.toMatchObject({ status: 403 })
  })

  it('returns 404 for an unknown or expired flowId', async () => {
    await expect(finishMcpUserOAuth(OAUTH, 'missing', 'state=1')).rejects.toMatchObject({ status: 404 })
  })

  it('closes the session and 404s when DESCRIBE returns no integration', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(describeOk(''))
      .mockResolvedValueOnce(logoutOk())
    vi.stubGlobal('fetch', fetchMock)
    await expect(startMcpUserOAuth('testacct', OAUTH, MCP)).rejects.toMatchObject({ status: 404 })
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/session/v1/logout-request')
  })
})
