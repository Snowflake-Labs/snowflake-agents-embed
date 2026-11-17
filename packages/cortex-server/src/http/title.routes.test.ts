// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { registerTitleRoutes } from './title.routes.js'
import type { CortexRouteDeps } from './deps.js'
import type { SnowflakeCredential } from '../snowflake/credential.js'
import type { CredentialFailure } from '../host/credentialResolver.js'

function depsWith(resolve: () => Promise<SnowflakeCredential | CredentialFailure>): CortexRouteDeps {
  return {
    config: { snowflakeAccount: 'testacct' } as CortexRouteDeps['config'],
    host: { originApp: 'agents_test', credentials: { resolve } },
  }
}

const OAUTH: SnowflakeCredential = { token: 'tok', tokenType: 'OAUTH' }

function sseBody(...deltas: string[]) {
  return deltas
    .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}`)
    .concat('data: [DONE]')
    .join('\n\n')
}

afterEach(() => { vi.restoreAllMocks() })

describe('POST /api/generate-title', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const deps = depsWith(async () => ({ error: 'Unauthorized', status: 401 }))
    const app = new Hono()
    registerTitleRoutes(app, deps)
    const res = await app.request('/api/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'hi' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns an empty title without calling fetch when firstMessage is blank', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerTitleRoutes(app, deps)
    const res = await app.request('/api/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: '   ' }),
    })
    expect(await res.json()).toEqual({ title: '' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('generates a cleaned title from the aggregated SSE deltas, using the resolved credential headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(sseBody('"Sales', ' Trends', ' Overview"  '), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerTitleRoutes(app, deps)
    const res = await app.request('/api/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'What are the sales trends?' }),
    })
    expect(await res.json()).toEqual({ title: 'Sales Trends Overview' })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://testacct.snowflakecomputing.com/api/v2/cortex/inference:complete')
    expect(opts.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
      Accept: 'text/event-stream',
    })
  })

  it('truncates to 60 characters', async () => {
    const long = 'word '.repeat(30).trim()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sseBody(long), { status: 200 })))
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerTitleRoutes(app, deps)
    const res = await app.request('/api/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'x' }),
    })
    const { title } = await res.json()
    expect(title.length).toBeLessThanOrEqual(60)
  })

  it('returns an empty title, not an error, when the upstream call is non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerTitleRoutes(app, deps)
    const res = await app.request('/api/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'hi' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ title: '' })
  })

  it('returns an empty title when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerTitleRoutes(app, deps)
    const res = await app.request('/api/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'hi' }),
    })
    expect(await res.json()).toEqual({ title: '' })
  })

  it('skips non-JSON keepalive lines rather than throwing', async () => {
    const body = 'data: not-json\n\n' + sseBody('Real title')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerTitleRoutes(app, deps)
    const res = await app.request('/api/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'hi' }),
    })
    expect(await res.json()).toEqual({ title: 'Real title' })
  })

  it('handles a missing/unparseable body by treating firstMessage as blank', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerTitleRoutes(app, deps)
    const res = await app.request('/api/generate-title', { method: 'POST' })
    expect(await res.json()).toEqual({ title: '' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
