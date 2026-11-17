// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { parseAgentRef, buildAgentRunUrl, isAllowedAgent, resolveAuthorizedAgent } from './agent-ref.js'

describe('parseAgentRef', () => {
  it('parses a valid db.schema.name FQN', () => {
    expect(parseAgentRef('MY_DB.MY_SCHEMA.MY_AGENT')).toEqual({
      database: 'MY_DB',
      schema: 'MY_SCHEMA',
      name: 'MY_AGENT',
    })
  })

  it('trims surrounding whitespace on each segment', () => {
    expect(parseAgentRef(' A . B . C ')).toEqual({
      database: 'A',
      schema: 'B',
      name: 'C',
    })
  })

  it.each([
    '%2e%2e.B.C',
    'A.%2e%2e%2fstatements%3fx.C',
    'A.B/../C.D',
    'A.B?x.C',
    'A.B#x.C',
    'A.B.C%2fD',
    'A.B.C D',
    'A."B".C',
  ])('rejects path-injection FQN %j', (fqn) => {
    expect(() => parseAgentRef(fqn)).toThrow(/Invalid agent FQN/)
  })

  it.each(['', 'A.B', 'A.B.C.D', 'A..C', '.B.C', 'A.B.'])(
    'throws on malformed FQN %j',
    (fqn) => {
      expect(() => parseAgentRef(fqn)).toThrow(/Invalid agent FQN/)
    },
  )
})

describe('buildAgentRunUrl', () => {
  it('builds the named-agent run endpoint', () => {
    const url = buildAgentRunUrl('acct123', {
      database: 'DB',
      schema: 'SCH',
      name: 'AG',
    })
    expect(url).toBe(
      'https://acct123.snowflakecomputing.com/api/v2/databases/DB/schemas/SCH/agents/AG:run',
    )
  })

  it('follows SNOWFLAKE_HOST_MODE=internal', () => {
    vi.stubEnv('SNOWFLAKE_HOST_MODE', 'internal')
    vi.stubEnv('SNOWFLAKE_HOST', 'sf.internal')
    try {
      expect(buildAgentRunUrl('acct123', { database: 'DB', schema: 'SCH', name: 'AG' })).toBe(
        'https://sf.internal/api/v2/databases/DB/schemas/SCH/agents/AG:run',
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('isAllowedAgent', () => {
  const list = [
    { fqn: 'MY_DB.MY_SCHEMA.MY_AGENT', displayName: 'My Agent' },
    { fqn: 'DB2.SCH.OTHER', displayName: 'Other' },
  ]

  it('allows an FQN in the list', () => {
    expect(isAllowedAgent('MY_DB.MY_SCHEMA.MY_AGENT', list)).toBe(true)
  })
  it('is case-insensitive', () => {
    expect(isAllowedAgent('my_db.my_schema.my_agent', list)).toBe(true)
  })
  it('rejects an FQN not in the list', () => {
    expect(isAllowedAgent('BAD_DB.BAD_SCH.BAD_AGENT', list)).toBe(false)
  })
  it('rejects empty FQN', () => {
    expect(isAllowedAgent('', list)).toBe(false)
  })
  it('rejects when allow-list is empty', () => {
    expect(isAllowedAgent('MY_DB.MY_SCHEMA.MY_AGENT', [])).toBe(false)
  })
})

describe('resolveAuthorizedAgent', () => {
  const list = [{ fqn: 'DB.SCH.AG', displayName: 'Allowed' }]

  it('returns the parsed ref in dynamic mode for any well-formed FQN', () => {
    const result = resolveAuthorizedAgent('OTHER.DB.AGENT', 'dynamic', list)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ref.name).toBe('AGENT')
  })

  it('returns 403 in static mode for an FQN outside the list', () => {
    const result = resolveAuthorizedAgent('OTHER.DB.AGENT', 'static', list)
    expect(result).toEqual({ ok: false, status: 403, error: 'Agent not allowed: OTHER.DB.AGENT' })
  })

  it('returns 400 for a malformed FQN', () => {
    const result = resolveAuthorizedAgent('nope', 'static', list)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })
})
