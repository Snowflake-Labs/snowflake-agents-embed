// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  parseSnowflakeHost,
  resolveSnowflakeHostMode,
  snowflakeBase,
  snowflakeHeaders,
  type SnowflakeCredential,
} from './credential.js'

describe('snowflakeHeaders', () => {
  it('carries the credential token and its token type', () => {
    const cred: SnowflakeCredential = { token: 'tok', tokenType: 'PROGRAMMATIC_ACCESS_TOKEN' }
    expect(snowflakeHeaders(cred)).toEqual({
      Authorization: 'Bearer tok',
      'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    })
  })

  it.each(['OAUTH', 'PROGRAMMATIC_ACCESS_TOKEN', 'KEYPAIR_JWT'] as const)(
    'passes through token type %s verbatim',
    (tokenType) => {
      const headers = snowflakeHeaders({ token: 't', tokenType })
      expect(headers['X-Snowflake-Authorization-Token-Type']).toBe(tokenType)
    },
  )

  it('defaults Accept to application/json and allows text/event-stream for streaming', () => {
    const cred: SnowflakeCredential = { token: 't', tokenType: 'OAUTH' }
    expect(snowflakeHeaders(cred).Accept).toBe('application/json')
    expect(snowflakeHeaders(cred, 'text/event-stream').Accept).toBe('text/event-stream')
  })
})

describe('snowflakeBase', () => {
  // The input contract is the bare organization-account name (ORG-ACCOUNT), per
  // .env.example and both service specs - NOT a full host. Passing an already-suffixed
  // value double-appends; that is a misconfiguration to catch in config, not something
  // this function should paper over, because the locator/host form is exactly what SPCS
  // injects and routes internally (private 10.x source IP, unallowlistable).
  it('builds the account URL from an ORG-ACCOUNT name', () => {
    expect(snowflakeBase('myorg-myaccount', {})).toBe(
      'https://myorg-myaccount.snowflakecomputing.com',
    )
  })

  it('ignores the injected SNOWFLAKE_HOST unless SNOWFLAKE_HOST_MODE=internal', () => {
    const env = { SNOWFLAKE_HOST: 'internal.example' }
    expect(snowflakeBase('a-b', env)).toBe('https://a-b.snowflakecomputing.com')
    expect(snowflakeBase('a-b', { ...env, SNOWFLAKE_HOST_MODE: 'account' })).toBe(
      'https://a-b.snowflakecomputing.com',
    )
  })

  it('uses SNOWFLAKE_HOST in internal mode', () => {
    expect(snowflakeBase('a-b', { SNOWFLAKE_HOST_MODE: 'internal', SNOWFLAKE_HOST: 'Sf.Region.Internal' })).toBe(
      'https://sf.region.internal',
    )
    expect(snowflakeBase('a-b', { SNOWFLAKE_HOST_MODE: ' Internal ', SNOWFLAKE_HOST: 'https://sf.internal' })).toBe(
      'https://sf.internal',
    )
  })

  it('throws in internal mode when SNOWFLAKE_HOST is missing', () => {
    expect(() => snowflakeBase('a-b', { SNOWFLAKE_HOST_MODE: 'internal' })).toThrow(/SNOWFLAKE_HOST/)
  })

  it('throws on an unknown SNOWFLAKE_HOST_MODE', () => {
    expect(() => snowflakeBase('a-b', { SNOWFLAKE_HOST_MODE: 'privatelink' })).toThrow(/SNOWFLAKE_HOST_MODE/)
  })
})

describe('resolveSnowflakeHostMode', () => {
  it('defaults to account', () => {
    expect(resolveSnowflakeHostMode({})).toBe('account')
    expect(resolveSnowflakeHostMode({ SNOWFLAKE_HOST_MODE: '' })).toBe('account')
  })
})

describe('parseSnowflakeHost', () => {
  it.each(['sf.internal', 'a_b-c.d.snowflakecomputing.com', 'HTTPS://x.y','  x.y  '])(
    'accepts %j',
    (raw) => {
      expect(() => parseSnowflakeHost(raw)).not.toThrow()
    },
  )

  // Anything that could redirect the bearer token: a second scheme, a port, a path,
  // userinfo, whitespace, or an empty label.
  it.each([
    undefined,
    '',
    'http://sf.internal',
    'sf.internal:443',
    'sf.internal/x',
    'evil@sf.internal',
    'sf .internal',
    'sf..internal',
    '-sf.internal',
    'sf.internal.',
    'https://sf.internal/',
  ])('rejects %j', (raw) => {
    expect(() => parseSnowflakeHost(raw)).toThrow(/SNOWFLAKE_HOST/)
  })
})
