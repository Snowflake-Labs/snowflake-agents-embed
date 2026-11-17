// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseAgents, listAgentsForUser, resetListAgentsCache } from './list-agents.js'
import type { SnowflakeCredential } from './credential.js'
import { SQL_API_STATEMENT_TIMEOUT_SEC, UpstreamTimeoutError } from './fetch-timeout.js'

const OAUTH: SnowflakeCredential = { token: 'tok', tokenType: 'OAUTH' }
const PAT: SnowflakeCredential = { token: 'tok', tokenType: 'PROGRAMMATIC_ACCESS_TOKEN' }

// Mirrors the Snowflake SQL API (/api/v2/statements) SHOW AGENTS response:
// column defs under resultSetMetaData.rowType, rows in `data` (arrays of
// stringified cells positionally aligned to the columns).
function showResult(rows: string[][], columns = ['created_on', 'name', 'database_name', 'schema_name', 'comment']) {
  return {
    resultSetMetaData: { rowType: columns.map((name) => ({ name })) },
    data: rows,
  }
}

afterEach(() => { resetListAgentsCache(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('parseAgents', () => {
  it('maps columns by name into fqn / displayName / description', () => {
    const agents = parseAgents(showResult([
      ['2026-01-01', 'SALES_AGENT', 'SNOWFLAKE_INTELLIGENCE', 'AGENTS', 'Sales helper'],
      ['2026-01-02', 'OPS_AGENT', 'SNOWFLAKE_INTELLIGENCE', 'AGENTS', ''],
    ]))
    expect(agents).toEqual([
      { fqn: 'SNOWFLAKE_INTELLIGENCE.AGENTS.SALES_AGENT', displayName: 'SALES_AGENT', description: 'Sales helper' },
      { fqn: 'SNOWFLAKE_INTELLIGENCE.AGENTS.OPS_AGENT', displayName: 'OPS_AGENT' },
    ])
  })

  it('is column-order independent (looks up by name, not position)', () => {
    const agents = parseAgents(showResult(
      [['MY_AGENT', 'A description', 'DB1', 'SCH1']],
      ['name', 'comment', 'database_name', 'schema_name'],
    ))
    expect(agents[0]).toEqual({ fqn: 'DB1.SCH1.MY_AGENT', displayName: 'MY_AGENT', description: 'A description' })
  })

  it('returns [] when required columns are missing', () => {
    expect(parseAgents(showResult([['x']], ['name']))).toEqual([])
    expect(parseAgents({})).toEqual([])
  })

  it('skips rows with blank identity cells', () => {
    const agents = parseAgents(showResult([['2026', '', 'DB', 'SCH', 'c']]))
    expect(agents).toEqual([])
  })
})

describe('listAgentsForUser', () => {
  it('queries both the SNOWFLAKE_INTELLIGENCE.AGENTS scope and account-wide, always', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(showResult([['2026', 'A', 'SNOWFLAKE_INTELLIGENCE', 'AGENTS', '']])), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(showResult([['2026', 'A', 'SNOWFLAKE_INTELLIGENCE', 'AGENTS', '']])), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const agents = await listAgentsForUser('acct', OAUTH)
    expect(agents).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).statement).toContain('SNOWFLAKE_INTELLIGENCE.AGENTS')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).timeout).toBe(SQL_API_STATEMENT_TIMEOUT_SEC)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).statement).toContain('IN ACCOUNT')
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer tok',
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
    })
  })

  // Discovery under a PAT is why this stopped defaulting to 'OAUTH': the Salesforce
  // relay needs PROGRAMMATIC_ACCESS_TOKEN here or SHOW AGENTS returns nothing.
  it('uses the credential token type on both scans', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(showResult([])), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await listAgentsForUser('acct', PAT)
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers['X-Snowflake-Authorization-Token-Type']).toBe('PROGRAMMATIC_ACCESS_TOKEN')
    }
  })

  it('merges scoped + account-wide agents even when the schema scope is non-empty (regression: previously short-circuited and hid agents outside SNOWFLAKE_INTELLIGENCE.AGENTS)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(showResult([['2026', 'SI_AGENT', 'SNOWFLAKE_INTELLIGENCE', 'AGENTS', '']])), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(showResult([
        ['2026', 'SI_AGENT', 'SNOWFLAKE_INTELLIGENCE', 'AGENTS', ''],
        ['2026', 'SALES_AGENT', 'DEMO_DB', 'AGENTS', ''],
      ])), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const agents = await listAgentsForUser('acct', OAUTH)
    expect(agents.map((a) => a.fqn).sort()).toEqual([
      'DEMO_DB.AGENTS.SALES_AGENT',
      'SNOWFLAKE_INTELLIGENCE.AGENTS.SI_AGENT',
    ])
  })

  it('dedupes by fqn (case-insensitive) when both scopes return the same agent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(showResult([['2026', 'A', 'DB', 'SCH', '']])), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const agents = await listAgentsForUser('acct', OAUTH)
    expect(agents).toHaveLength(1)
  })

  it('sorts results by displayName', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(showResult([
      ['2026', 'Zebra', 'DB', 'SCH', ''],
      ['2026', 'Alpha', 'DB', 'SCH', ''],
    ])), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const agents = await listAgentsForUser('acct', OAUTH)
    expect(agents.map((a) => a.displayName)).toEqual(['Alpha', 'Zebra'])
  })

  it('returns [] when both scopes fail', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await listAgentsForUser('acct', OAUTH)).toEqual([])
  })

  it('rethrows an upstream timeout instead of collapsing it to an empty list', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(
      (_url: string | URL, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ))
    const pending = listAgentsForUser('acct', OAUTH)
    const expectation = expect(pending).rejects.toBeInstanceOf(UpstreamTimeoutError)
    await vi.advanceTimersByTimeAsync(40_000)
    await expectation
    vi.useRealTimers()
  })

  it('coalesces concurrent identical calls and does not cache an empty result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(showResult([['2026', 'A', 'DB', 'SCH', '']])), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(showResult([['2026', 'A', 'DB', 'SCH', '']])), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b] = await Promise.all([listAgentsForUser('acct', OAUTH), listAgentsForUser('acct', OAUTH)])
    expect(a).toEqual(b)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await listAgentsForUser('acct', OAUTH)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
