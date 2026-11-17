// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { parseCortexRuntimeConfig, requireEnv } from './runtime.js'

describe('parseCortexRuntimeConfig', () => {
  it('throws when SNOWFLAKE_ACCOUNT is missing', () => {
    expect(() => parseCortexRuntimeConfig({})).toThrow('SNOWFLAKE_ACCOUNT')
  })

  it('defaults port to 3000 and reads PORT when set', () => {
    expect(parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev' }).port).toBe(3000)
    expect(parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev', PORT: '8080' }).port).toBe(8080)
  })

  it('defaults to dynamic discovery when no explicit AGENT_ALLOW_LIST', () => {
    const cfg = parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev', DEFAULT_AGENT_FQN: 'DB.SCH.AG' })
    expect(cfg.agentDiscovery).toBe('dynamic')
    // defaultAgentFqn seeds the allow-list as an initial-selection hint, not a
    // static restriction - discovery stays dynamic even though the list is non-empty.
    expect(cfg.agentAllowList).toEqual([{ fqn: 'DB.SCH.AG', displayName: 'DB.SCH.AG' }])
  })

  it('uses static discovery when an explicit non-empty AGENT_ALLOW_LIST is set', () => {
    const cfg = parseCortexRuntimeConfig({
      SNOWFLAKE_ACCOUNT: 'dev',
      AGENT_ALLOW_LIST: JSON.stringify([{ fqn: 'DB.SCH.AG', displayName: 'A' }]),
    })
    expect(cfg.agentDiscovery).toBe('static')
    expect(cfg.agentAllowList).toHaveLength(1)
  })

  it('stays dynamic when AGENT_ALLOW_LIST is an empty array', () => {
    expect(parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev', AGENT_ALLOW_LIST: '[]' }).agentDiscovery).toBe('dynamic')
  })

  it('starts with an empty allow-list rather than throwing on malformed AGENT_ALLOW_LIST JSON', () => {
    const cfg = parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev', AGENT_ALLOW_LIST: 'not json' })
    expect(cfg.agentAllowList).toEqual([])
    expect(cfg.agentDiscovery).toBe('dynamic')
  })

  it('defaults every feature flag to false, and reads FF_* env vars independently', () => {
    expect(parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev' }).featureFlags).toEqual({
      fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false,
    })
    expect(parseCortexRuntimeConfig({
      SNOWFLAKE_ACCOUNT: 'dev', FF_FILE_UPLOAD: 'true', FF_DEEP_RESEARCH: 'true',
    }).featureFlags).toEqual({
      fileUpload: true, deepResearch: true, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false,
    })
  })

  it('validates SNOWFLAKE_HOST_MODE and SNOWFLAKE_HOST at boot', () => {
    expect(() => parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev', SNOWFLAKE_HOST_MODE: 'nope' })).toThrow(
      /SNOWFLAKE_HOST_MODE/,
    )
    expect(() => parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev', SNOWFLAKE_HOST_MODE: 'internal' })).toThrow(
      /SNOWFLAKE_HOST/,
    )
    expect(
      parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev', SNOWFLAKE_HOST_MODE: 'internal', SNOWFLAKE_HOST: 'sf.internal' })
        .snowflakeAccount,
    ).toBe('dev')
  })

  it('warns when internal host mode is combined with an auth mode that forwards user tokens', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const base = { SNOWFLAKE_ACCOUNT: 'dev', SNOWFLAKE_HOST_MODE: 'internal', SNOWFLAKE_HOST: 'sf.internal' }
      parseCortexRuntimeConfig({ ...base, AUTH_MODE: 'local-pat' })
      expect(warn).not.toHaveBeenCalled()
      parseCortexRuntimeConfig({ ...base, AUTH_MODE: 'production' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('395090'))
      warn.mockClear()
      parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev', AUTH_MODE: 'production' })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('warns when SNOWFLAKE_ACCOUNT is a PrivateLink host', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'org-acct.privatelink' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('.privatelink'))
      warn.mockClear()
      parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'org-acct' })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves agentsSecondaryOrigin undefined unless set', () => {
    expect(parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev' }).agentsSecondaryOrigin).toBeUndefined()
    expect(parseCortexRuntimeConfig({ SNOWFLAKE_ACCOUNT: 'dev', AGENTS_SECONDARY_ORIGIN: 'x' }).agentsSecondaryOrigin).toBe('x')
  })
})

describe('requireEnv', () => {
  it('returns the value when present', () => {
    expect(requireEnv({ FOO: 'bar' }, 'FOO')).toBe('bar')
  })
  it('throws naming the missing key', () => {
    expect(() => requireEnv({}, 'FOO')).toThrow('FOO')
  })
})
