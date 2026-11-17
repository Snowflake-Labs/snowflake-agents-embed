// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { parseConfig } from './config.js'

describe('parseConfig', () => {
  it('throws on missing SNOWFLAKE_ACCOUNT in production mode', () => {
    expect(() => parseConfig({ AUTH_MODE: 'production' })).toThrow('SNOWFLAKE_ACCOUNT')
  })
  it('accepts local-pat mode with minimal env', () => {
    const cfg = parseConfig({ AUTH_MODE: 'local-pat', SNOWFLAKE_ACCOUNT: 'dev' })
    expect(cfg.authMode).toBe('local-pat')
  })

  it('prefers TEAMS_AUTH_MODE over the legacy AUTH_MODE var', () => {
    const cfg = parseConfig({ AUTH_MODE: 'local-pat', TEAMS_AUTH_MODE: 'local-oauth', SNOWFLAKE_ACCOUNT: 'dev', AZURE_TENANT_ID: 't', OBO_CLIENT_ID: 'c', OBO_CLIENT_SECRET: 's', SNOWFLAKE_SCOPE: 'sc' })
    expect(cfg.authMode).toBe('local-oauth')
  })

  it('falls back to AUTH_MODE when TEAMS_AUTH_MODE is absent (relay reads the same var under a different name)', () => {
    const cfg = parseConfig({ AUTH_MODE: 'local-pat', SNOWFLAKE_ACCOUNT: 'dev' })
    expect(cfg.authMode).toBe('local-pat')
  })

  it('refuses to start when neither TEAMS_AUTH_MODE nor AUTH_MODE is set', () => {
    expect(() => parseConfig({ SNOWFLAKE_ACCOUNT: 'dev' })).toThrow(/TEAMS_AUTH_MODE/)
  })

  it('rejects an unrecognized auth mode', () => {
    expect(() => parseConfig({ TEAMS_AUTH_MODE: 'bogus', SNOWFLAKE_ACCOUNT: 'dev' })).toThrow(/TEAMS_AUTH_MODE/)
  })

  it('reports the missing SNOWFLAKE_ACCOUNT before the Azure fields when both are absent', () => {
    expect(() => parseConfig({ TEAMS_AUTH_MODE: 'production' })).toThrow('SNOWFLAKE_ACCOUNT')
  })

  it('defaults to dynamic discovery when no explicit AGENT_ALLOW_LIST', () => {
    const cfg = parseConfig({ AUTH_MODE: 'local-pat', SNOWFLAKE_ACCOUNT: 'dev', DEFAULT_AGENT_FQN: 'DB.SCH.AG' })
    expect(cfg.agentDiscovery).toBe('dynamic')
  })

  it('uses static discovery when an explicit non-empty AGENT_ALLOW_LIST is set', () => {
    const cfg = parseConfig({
      AUTH_MODE: 'local-pat',
      SNOWFLAKE_ACCOUNT: 'dev',
      AGENT_ALLOW_LIST: JSON.stringify([{ fqn: 'DB.SCH.AG', displayName: 'A' }]),
    })
    expect(cfg.agentDiscovery).toBe('static')
    expect(cfg.agentAllowList).toHaveLength(1)
  })

  it('stays dynamic when AGENT_ALLOW_LIST is an empty array', () => {
    const cfg = parseConfig({ AUTH_MODE: 'local-pat', SNOWFLAKE_ACCOUNT: 'dev', AGENT_ALLOW_LIST: '[]' })
    expect(cfg.agentDiscovery).toBe('dynamic')
  })

  it('fails in production when ALLOWED_ORIGINS is empty', () => {
    expect(() => parseConfig({
      TEAMS_AUTH_MODE: 'production',
      SNOWFLAKE_ACCOUNT: 'dev',
      AZURE_TENANT_ID: 't',
      OBO_CLIENT_ID: 'c',
      OBO_CLIENT_SECRET: 's',
      SNOWFLAKE_SCOPE: 'sc',
    })).toThrow(/ALLOWED_ORIGINS/)
  })

  it('parses ALLOWED_ORIGINS and does not inject localhost in production', () => {
    const cfg = parseConfig({
      TEAMS_AUTH_MODE: 'production',
      SNOWFLAKE_ACCOUNT: 'dev',
      AZURE_TENANT_ID: 't',
      OBO_CLIENT_ID: 'c',
      OBO_CLIENT_SECRET: 's',
      SNOWFLAKE_SCOPE: 'sc',
      ALLOWED_ORIGINS: 'https://example-app.pages.dev, https://other.example',
    })
    expect(cfg.allowedOrigins).toEqual(['https://example-app.pages.dev', 'https://other.example'])
  })

  it('appends localhost:5173 in non-production when missing', () => {
    const cfg = parseConfig({
      TEAMS_AUTH_MODE: 'local-pat',
      SNOWFLAKE_ACCOUNT: 'dev',
      ALLOWED_ORIGINS: 'https://example-app.pages.dev',
    })
    expect(cfg.allowedOrigins).toEqual(['https://example-app.pages.dev', 'http://localhost:5173'])
  })

  it('does not duplicate localhost:5173 when already listed', () => {
    const cfg = parseConfig({
      TEAMS_AUTH_MODE: 'local-pat',
      SNOWFLAKE_ACCOUNT: 'dev',
      ALLOWED_ORIGINS: 'http://localhost:5173',
    })
    expect(cfg.allowedOrigins).toEqual(['http://localhost:5173'])
  })

  it('defaults botStateTable and lets it be overridden', () => {
    expect(parseConfig({ AUTH_MODE: 'local-pat', SNOWFLAKE_ACCOUNT: 'dev' }).botStateTable).toBe('SNOWFLAKE_INTELLIGENCE.AGENTS.COWORK_BOT_STATE')
    expect(parseConfig({ AUTH_MODE: 'local-pat', SNOWFLAKE_ACCOUNT: 'dev', BOT_STATE_TABLE: 'MY_DB.MY_SCH.BOT_STATE' }).botStateTable).toBe('MY_DB.MY_SCH.BOT_STATE')
  })

  it('defaults every feature flag to false, and reads FF_* env vars when set', () => {
    expect(parseConfig({ AUTH_MODE: 'local-pat', SNOWFLAKE_ACCOUNT: 'dev' }).featureFlags).toEqual({
      fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false,
    })
    expect(parseConfig({
      AUTH_MODE: 'local-pat', SNOWFLAKE_ACCOUNT: 'dev', FF_FILE_UPLOAD: 'true',
    }).featureFlags).toEqual({ fileUpload: true, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    expect(parseConfig({
      AUTH_MODE: 'local-pat', SNOWFLAKE_ACCOUNT: 'dev', FF_SKILLS: 'true',
    }).featureFlags).toEqual({ fileUpload: false, deepResearch: false, skills: true, webSearch: false, richComposer: false, nativeStreamFlags: false })
    expect(parseConfig({
      AUTH_MODE: 'local-pat', SNOWFLAKE_ACCOUNT: 'dev', FF_WEB_SEARCH: 'true',
    }).featureFlags).toEqual({ fileUpload: false, deepResearch: false, skills: false, webSearch: true, richComposer: false, nativeStreamFlags: false })
    expect(parseConfig({
      AUTH_MODE: 'local-pat', SNOWFLAKE_ACCOUNT: 'dev', FF_RICH_COMPOSER: 'true',
    }).featureFlags).toEqual({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: true, nativeStreamFlags: false })
  })
})

describe('parseConfig auth-mode guard', () => {
  const base = { SNOWFLAKE_ACCOUNT: 'acct', SNOWFLAKE_PAT: 'pat' }

  it('rejects local-pat under NODE_ENV=production', () => {
    expect(() => parseConfig({ ...base, AUTH_MODE: 'local-pat', NODE_ENV: 'production' })).toThrow(/not allowed/)
  })

  it('allows local-pat under NODE_ENV=production with the explicit override', () => {
    expect(
      parseConfig({ ...base, AUTH_MODE: 'local-pat', NODE_ENV: 'production', ALLOW_INSECURE_AUTH_MODE: '1' }).authMode,
    ).toBe('local-pat')
  })

  it('allows local-pat when NODE_ENV is unset', () => {
    expect(parseConfig({ ...base, AUTH_MODE: 'local-pat' }).authMode).toBe('local-pat')
  })

  it('defaults local modes to 127.0.0.1 and production to 0.0.0.0', () => {
    expect(parseConfig({ ...base, AUTH_MODE: 'local-pat' }).host).toBe('127.0.0.1')
    expect(parseConfig({
      ...base,
      AUTH_MODE: 'production',
      AZURE_TENANT_ID: 't',
      OBO_CLIENT_ID: 'c',
      OBO_CLIENT_SECRET: 's',
      SNOWFLAKE_SCOPE: 'scope',
      ALLOWED_ORIGINS: 'https://tab.example.com',
    }).host).toBe('0.0.0.0')
  })

  it('rejects local-pat bound to a non-loopback host', () => {
    expect(() => parseConfig({ ...base, AUTH_MODE: 'local-pat', HOST: '0.0.0.0' })).toThrow(/cannot bind/)
  })

  it('allows a non-loopback bind for local-pat with the explicit override', () => {
    expect(parseConfig({ ...base, AUTH_MODE: 'local-pat', HOST: '0.0.0.0', ALLOW_INSECURE_AUTH_MODE: '1' }).host).toBe('0.0.0.0')
  })
})
