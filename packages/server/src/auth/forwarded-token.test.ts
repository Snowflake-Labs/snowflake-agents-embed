// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { forwardedTokenResolver, isCredentialFailure } from './forwarded-token.js'

describe('forwardedTokenResolver', () => {
  it('resolves an OAUTH credential from X-User-Access-Token in production mode', async () => {
    const resolver = forwardedTokenResolver('production')
    const app = new Hono()
    app.get('/x', async (c) => c.json(await resolver.resolve(c)))
    const res = await app.request('/x', { headers: { 'X-User-Access-Token': 'tok' } })
    expect(await res.json()).toEqual({ token: 'tok', tokenType: 'OAUTH' })
  })

  it('resolves a PROGRAMMATIC_ACCESS_TOKEN credential in local-pat mode', async () => {
    const resolver = forwardedTokenResolver('local-pat')
    const app = new Hono()
    app.get('/x', async (c) => c.json(await resolver.resolve(c)))
    const res = await app.request('/x', { headers: { 'X-User-Access-Token': 'tok' } })
    expect(await res.json()).toEqual({ token: 'tok', tokenType: 'PROGRAMMATIC_ACCESS_TOKEN' })
  })

  it('fails with 401 when the header is absent', async () => {
    const resolver = forwardedTokenResolver('production')
    const app = new Hono()
    app.get('/x', async (c) => {
      const result = await resolver.resolve(c)
      return isCredentialFailure(result) ? c.json({ error: result.error }, result.status) : c.json(result)
    })
    const res = await app.request('/x')
    expect(res.status).toBe(401)
  })
})
