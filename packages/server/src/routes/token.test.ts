// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { registerTokenRoutes } from './token.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const loopback = (addr: string) => ({ incoming: { socket: { remoteAddress: addr } } })

describe('POST /api/token/exchange', () => {
  it('does not register the exchange route in production mode', async () => {
    const app = new Hono()
    registerTokenRoutes(app, { authMode: 'production', jwksUri: 'https://login.microsoftonline.com/test/discovery/v2.0/keys', oboClientId: 'client', tenantId: 'test' } as any)
    const res = await app.request('/api/token/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entraToken: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 200 with snowflakeToken in local-pat mode after a successful probe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }))
    const app = new Hono()
    registerTokenRoutes(app, { authMode: 'local-pat', snowflakeAccount: 'acct' } as any)
    const res = await app.request('/api/token/exchange', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Snowflake-Pat': 'my-pat',
      },
      body: JSON.stringify({}),
    }, loopback('127.0.0.1'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.snowflakeToken).toBe('my-pat')
    expect(data.expiresIn).toBe(300)
  })

  it('returns 401 when the local-pat probe is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false }))
    const app = new Hono()
    registerTokenRoutes(app, { authMode: 'local-pat', snowflakeAccount: 'acct' } as any)
    const res = await app.request('/api/token/exchange', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Snowflake-Pat': 'dead-pat',
      },
      body: JSON.stringify({}),
    }, loopback('::1'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'PAT rejected or expired' })
  })

  it.each([['remote peer', loopback('10.1.2.3')], ['no connection info', undefined]])(
    'refuses local-pat exchange for a non-loopback caller (%s) without probing',
    async (_name, env) => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const app = new Hono()
      registerTokenRoutes(app, { authMode: 'local-pat', snowflakeAccount: 'acct' } as any)
      const res = await app.request('/api/token/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Snowflake-Pat': 'stolen-pat' },
        body: '{}',
      }, env)
      expect(res.status).toBe(403)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )
})
