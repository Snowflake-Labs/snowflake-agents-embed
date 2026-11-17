// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { registerFeedbackRoutes } from './feedback.routes.js'
import type { CortexRouteDeps } from './deps.js'
import type { SnowflakeCredential } from '../snowflake/credential.js'
import type { CredentialFailure } from '../host/credentialResolver.js'

function depsWith(
  resolve: () => Promise<SnowflakeCredential | CredentialFailure>,
  configOverrides: Partial<CortexRouteDeps['config']> = {},
): CortexRouteDeps {
  return {
    config: { snowflakeAccount: 'testacct', defaultAgentFqn: 'DB.SCH.AG', ...configOverrides } as CortexRouteDeps['config'],
    host: { originApp: 'agents_test', credentials: { resolve } },
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('POST /api/feedback', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const deps = depsWith(async () => ({ error: 'Unauthorized', status: 401 }))
    const app = new Hono()
    registerFeedbackRoutes(app, deps)
    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positive: true }),
    })
    expect(res.status).toBe(401)
  })

  it('forwards to the native Feedback endpoint using the default agent FQN when the body omits one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'OAUTH' }))
    const app = new Hono()
    registerFeedbackRoutes(app, deps)
    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positive: true, threadId: 7, categories: ['Accurate'] }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://testacct.snowflakecomputing.com/api/v2/databases/DB/schemas/SCH/agents/AG:feedback')
    expect(JSON.parse(opts.body)).toEqual({ positive: true, categories: ['Accurate'], thread_id: 7 })
  })

  it('uses an explicit agentFqn from the body over the default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'OAUTH' }))
    const app = new Hono()
    registerFeedbackRoutes(app, deps)
    await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'OTHER.DB.AGENT', positive: true }),
    })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://testacct.snowflakecomputing.com/api/v2/databases/OTHER/schemas/DB/agents/AGENT:feedback')
  })

  it('returns 500 when neither the body nor config supplies an agent FQN', async () => {
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'OAUTH' }), { defaultAgentFqn: '' })
    const app = new Hono()
    registerFeedbackRoutes(app, deps)
    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positive: true }),
    })
    expect(res.status).toBe(500)
  })

  it('returns 403 in static mode for an FQN outside the allow-list', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'OAUTH' }), {
      agentDiscovery: 'static',
      agentAllowList: [{ fqn: 'DB.SCH.AG', displayName: 'Allowed' }],
    })
    const app = new Hono()
    registerFeedbackRoutes(app, deps)
    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'OTHER.DB.AGENT', positive: true }),
    })
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 400 on a malformed agentFqn', async () => {
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'OAUTH' }))
    const app = new Hono()
    registerFeedbackRoutes(app, deps)
    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'not-a-fqn', positive: true }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 on invalid JSON', async () => {
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'OAUTH' }))
    const app = new Hono()
    registerFeedbackRoutes(app, deps)
    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('propagates a Cortex failure status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })))
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'OAUTH' }))
    const app = new Hono()
    registerFeedbackRoutes(app, deps)
    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positive: false }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false })
  })
})
