// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { buildApp } from './index.js'
import type { Config } from './config.js'

/**
 * Route-table regression guard: asserts which endpoints this host's composed app
 * actually serves, so a future shared-route change (packages/cortex-server route
 * factories, once they exist) can't silently add a route to a host that shouldn't
 * have it, or drop one that should. A route present is inferred from the response
 * NOT being Hono's default 404 - every registered handler here returns something
 * else (401, 400, 500, ...) even with no auth/body, since the auth check runs
 * before any Snowflake call. Mirrors packages/relay/src/index.test.ts.
 */
function testConfig(): Config {
  return {
    authMode: 'local-pat',
    host: '127.0.0.1',
    snowflakeAccount: 'testacct',
    // Non-empty botAppId, unlike registerAgentRoutes's own unit-test fixture: bot
    // routes are only registered when this is set (registerBotRoutes short-circuits
    // on `if (!config.botAppId) return`), and this test needs them registered to
    // assert their presence.
    botAppId: 'test-bot-app-id',
    botAppSecret: 'test-bot-app-secret',
    port: 3000,
    oboClientId: '',
    oboClientSecret: '',
    snowflakeScope: '',
    defaultAgentFqn: '',
    teamsAppId: '',
    allowedOrigins: ['http://localhost:5173'],
    agentAllowList: [],
    agentDiscovery: 'dynamic',
    botStateTable: 'TEST_DB.TEST_SCH.BOT_STATE',
    featureFlags: {
      fileUpload: false, deepResearch: false, skills: false,
      webSearch: false, richComposer: false, nativeStreamFlags: false,
    },
  }
}

const ROUTES_PRESENT: Array<[string, string]> = [
  ['GET', '/healthz'],
  ['GET', '/api/config'],
  ['GET', '/api/agents'],
  ['GET', '/api/agents/sample-questions'],
  ['GET', '/api/agents/details'],
  ['POST', '/api/agent/run'],
  ['GET', '/api/statements/some-handle'],
  ['POST', '/api/feedback'],
  ['POST', '/api/generate-title'],
  ['POST', '/api/telemetry'],
  ['GET', '/api/mcp/connections'],
  ['POST', '/api/mcp/oauth/start'],
  ['POST', '/api/mcp/oauth/finish'],
  ['GET', '/api/threads'],
  ['GET', '/api/threads/search'],
  ['GET', '/api/threads/123'],
  ['POST', '/api/threads'],
  ['POST', '/api/threads/123'],
  ['DELETE', '/api/threads/123'],
  ['POST', '/api/bot/messages'],
  ['POST', '/api/token/exchange'],
]

// The endpoint relay exposes for Apex's non-streaming callout; server has no such
// constraint (the Teams tab reads the live SSE stream, and the bot consumes it
// in-process via bot/cortex.ts) and has never had an HTTP equivalent.
const ROUTES_ABSENT: Array<[string, string]> = [
  ['POST', '/api/agent/aggregate'],
]

describe('server route table', () => {
  const app = buildApp(testConfig())

  it.each(ROUTES_PRESENT)('serves %s %s', async (method, path) => {
    const res = await app.request(path, { method })
    expect(res.status).not.toBe(404)
  })

  it.each(ROUTES_ABSENT)('does not serve %s %s', async (method, path) => {
    const res = await app.request(path, { method })
    expect(res.status).toBe(404)
  })

  it('does not register /api/token/exchange in production mode', async () => {
    const app = buildApp({ ...testConfig(), authMode: 'production' })
    const res = await app.request('/api/token/exchange', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('does not register /api/bot/messages when botAppId is unset', async () => {
    const app = buildApp({ ...testConfig(), botAppId: '' })
    const res = await app.request('/api/bot/messages', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('exposes /healthz as a non-sensitive liveness body', async () => {
    const res = await app.request('/healthz')
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('server rate limiting', () => {
  const ip = { 'X-Agents-Client-Ip': '10.0.0.1' }

  it('gives each user token its own bucket behind one shared IP', async () => {
    const app = buildApp(testConfig())
    const call = (tok: string) =>
      app.request('/api/config', { headers: { ...ip, 'X-User-Access-Token': tok } })

    for (let i = 0; i < 60; i++) expect((await call('user-a')).status).not.toBe(429)
    expect((await call('user-a')).status).toBe(429)
    expect((await call('user-b')).status).not.toBe(429)
  })

  it('does not let one shared IP exhaust at 60/min without a token', async () => {
    const app = buildApp(testConfig())
    for (let i = 0; i < 100; i++) {
      expect((await app.request('/healthz', { headers: ip })).status).toBe(200)
      expect((await app.request('/api/config', { headers: ip })).status).not.toBe(429)
    }
  })
})
