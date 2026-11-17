// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { registerStatementsRoutes } from './statements.routes.js'
import type { CortexRouteDeps } from './deps.js'
import type { SnowflakeCredential } from '../snowflake/credential.js'
import type { CredentialFailure } from '../host/credentialResolver.js'

function depsWith(resolve: () => Promise<SnowflakeCredential | CredentialFailure>): CortexRouteDeps {
  return {
    config: { snowflakeAccount: 'testacct' } as CortexRouteDeps['config'],
    host: { originApp: 'agents_test', credentials: { resolve } },
  }
}

const HANDLE = '550e8400-e29b-41d4-a716-446655440000'

afterEach(() => { vi.restoreAllMocks() })

describe('GET /api/statements/:handle', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const deps = depsWith(async () => ({ error: 'Unauthorized', status: 401 }))
    const app = new Hono()
    registerStatementsRoutes(app, deps)
    const res = await app.request(`/api/statements/${HANDLE}`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('proxies to the SQL Statements API with the resolved credential headers (PAT)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":[]}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'PROGRAMMATIC_ACCESS_TOKEN' }))
    const app = new Hono()
    registerStatementsRoutes(app, deps)
    const res = await app.request(`/api/statements/${HANDLE}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [] })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://testacct.snowflakecomputing.com/api/v2/statements/${HANDLE}`)
    expect(opts.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
    })
  })

  it('proxies with OAUTH headers when the resolver returns an OAUTH credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'OAUTH' }))
    const app = new Hono()
    registerStatementsRoutes(app, deps)
    await app.request(`/api/statements/${HANDLE}`)
    expect(fetchMock.mock.calls[0][1].headers['X-Snowflake-Authorization-Token-Type']).toBe('OAUTH')
  })

  it('forwards the partition query param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'OAUTH' }))
    const app = new Hono()
    registerStatementsRoutes(app, deps)
    await app.request(`/api/statements/${HANDLE}?partition=2`)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://testacct.snowflakecomputing.com/api/v2/statements/${HANDLE}?partition=2`)
  })

  it('propagates a non-200 upstream status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })))
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'OAUTH' }))
    const app = new Hono()
    registerStatementsRoutes(app, deps)
    const res = await app.request(`/api/statements/${HANDLE}`)
    expect(res.status).toBe(404)
  })

  it('rejects a non-UUID handle before fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => ({ token: 'tok', tokenType: 'OAUTH' }))
    const app = new Hono()
    registerStatementsRoutes(app, deps)
    const res = await app.request('/api/statements/..%2F..%2Fsession')
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
