// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { statementUrl, threadUrl, InvalidPathIdError } from './path-id.js'

describe('statementUrl', () => {
  const base = 'https://acct.snowflakecomputing.com'
  const handle = '550e8400-e29b-41d4-a716-446655440000'

  it('builds a statements URL from a UUID handle', () => {
    expect(statementUrl(base, handle).href).toBe(
      `${base}/api/v2/statements/${handle}`,
    )
  })

  it('forwards a numeric partition', () => {
    expect(statementUrl(base, handle, '2').searchParams.get('partition')).toBe('2')
  })

  it.each(['', 'abc-123', '../../session', '..%2F..%2Fsession', 'not-a-uuid'])(
    'rejects handle %j',
    (value) => {
      expect(() => statementUrl(base, value)).toThrow(InvalidPathIdError)
    },
  )

  it('rejects a non-integer partition', () => {
    expect(() => statementUrl(base, handle, 'x')).toThrow(InvalidPathIdError)
  })
})

describe('threadUrl', () => {
  const base = 'https://acct.snowflakecomputing.com/api/v2/cortex/threads'

  it('builds a threads URL from a numeric id', () => {
    expect(threadUrl(base, '4380301577').href).toBe(`${base}/4380301577`)
  })

  it.each(['', 'abc', '../../statements', '..%2F..%2Fsession', '1e2', '-1'])(
    'rejects id %j',
    (value) => {
      expect(() => threadUrl(base, value)).toThrow(InvalidPathIdError)
    },
  )
})
