// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { rateLimiter } from './rate-limit.js'

const ip = (addr: string) => ({ 'X-Agents-Client-Ip': addr })

describe('rateLimiter', () => {
  it('allows requests under the limit', async () => {
    const app = new Hono()
    app.use('*', rateLimiter({ windowMs: 60_000, max: 2 }))
    app.get('/x', (c) => c.text('ok'))

    const res1 = await app.request('/x', { headers: ip('1.2.3.4') })
    const res2 = await app.request('/x', { headers: ip('1.2.3.4') })
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
  })

  it('rejects once a caller exceeds the limit within the window', async () => {
    const app = new Hono()
    app.use('*', rateLimiter({ windowMs: 60_000, max: 2 }))
    app.get('/x', (c) => c.text('ok'))

    await app.request('/x', { headers: ip('1.2.3.4') })
    await app.request('/x', { headers: ip('1.2.3.4') })
    const res3 = await app.request('/x', { headers: ip('1.2.3.4') })

    expect(res3.status).toBe(429)
    expect(res3.headers.get('Retry-After')).toBeTruthy()
  })

  it('buckets callers independently', async () => {
    const app = new Hono()
    app.use('*', rateLimiter({ windowMs: 60_000, max: 1 }))
    app.get('/x', (c) => c.text('ok'))

    const a1 = await app.request('/x', { headers: ip('1.1.1.1') })
    const b1 = await app.request('/x', { headers: ip('2.2.2.2') })
    const a2 = await app.request('/x', { headers: ip('1.1.1.1') })

    expect(a1.status).toBe(200)
    expect(b1.status).toBe(200)
    expect(a2.status).toBe(429)
  })
})

// The identity cascade is the part a new host integration inherits: whichever of
// these headers it happens to send determines whether local dev buckets per
// caller or collapses everyone together.
describe('rateLimiter caller identity', () => {
  function limited() {
    const app = new Hono()
    app.use('*', rateLimiter({ windowMs: 60_000, max: 1 }))
    app.get('/x', (c) => c.text('ok'))
    return app
  }

  it('prefers X-Agents-Client-Ip over X-Forwarded-For', async () => {
    const app = limited()
    const a = await app.request('/x', {
      headers: { 'X-Agents-Client-Ip': '9.9.9.9', 'X-Forwarded-For': '1.1.1.1' },
    })
    const b = await app.request('/x', {
      headers: { 'X-Agents-Client-Ip': '8.8.8.8', 'X-Forwarded-For': '1.1.1.1' },
    })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
  })

  it('ignores X-Forwarded-For unless RATE_LIMIT_TRUST_XFF=1', async () => {
    const app = limited()
    const first = await app.request('/x', { headers: { 'X-Forwarded-For': '1.1.1.1' } })
    const spoofed = await app.request('/x', { headers: { 'X-Forwarded-For': '9.9.9.9' } })
    expect(first.status).toBe(200)
    expect(spoofed.status).toBe(429)
  })

  it('uses the last X-Forwarded-For hop when RATE_LIMIT_TRUST_XFF=1', async () => {
    const prev = process.env.RATE_LIMIT_TRUST_XFF
    process.env.RATE_LIMIT_TRUST_XFF = '1'
    try {
      const app = limited()
      await app.request('/x', { headers: { 'X-Forwarded-For': '1.1.1.1, 10.0.0.1' } })
      const rotatedClient = await app.request('/x', { headers: { 'X-Forwarded-For': '9.9.9.9, 10.0.0.1' } })
      expect(rotatedClient.status).toBe(429)
      const newIngress = await app.request('/x', { headers: { 'X-Forwarded-For': '1.1.1.1, 10.0.0.9' } })
      expect(newIngress.status).toBe(200)
    } finally {
      if (prev === undefined) delete process.env.RATE_LIMIT_TRUST_XFF
      else process.env.RATE_LIMIT_TRUST_XFF = prev
    }
  })

  it('falls back to X-Agents-Session when there is no proxy header', async () => {
    const app = limited()
    const a = await app.request('/x', { headers: { 'X-Agents-Session': 'sess-a' } })
    const b = await app.request('/x', { headers: { 'X-Agents-Session': 'sess-b' } })
    const a2 = await app.request('/x', { headers: { 'X-Agents-Session': 'sess-a' } })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a2.status).toBe(429)
  })

  it('falls back to X-User-Access-Token when neither of the above is present', async () => {
    const app = limited()
    const a = await app.request('/x', { headers: { 'X-User-Access-Token': 'tok-a' } })
    const b = await app.request('/x', { headers: { 'X-User-Access-Token': 'tok-b' } })
    const a2 = await app.request('/x', { headers: { 'X-User-Access-Token': 'tok-a' } })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a2.status).toBe(429)
  })

  it('collapses unidentifiable callers into one bucket', async () => {
    const app = limited()
    const first = await app.request('/x')
    const second = await app.request('/x')
    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
  })

  it('skips the limiter when skip() returns true', async () => {
    const app = new Hono()
    app.use('*', rateLimiter({ windowMs: 60_000, max: 1, skip: (c) => c.req.path === '/healthz' }))
    app.get('/healthz', (c) => c.text('ok'))
    app.get('/x', (c) => c.text('ok'))

    expect((await app.request('/x')).status).toBe(200)
    expect((await app.request('/x')).status).toBe(429)
    expect((await app.request('/healthz')).status).toBe(200)
    expect((await app.request('/healthz')).status).toBe(200)
  })
})

describe('rateLimiter custom key', () => {
  it('uses key() instead of the IP cascade', async () => {
    const app = new Hono()
    app.use('*', rateLimiter({ windowMs: 60_000, max: 1, key: (c) => c.req.header('X-K') ?? 'none' }))
    app.get('/x', (c) => c.text('ok'))
    const ip = { 'X-Agents-Client-Ip': '9.9.9.9' }

    expect((await app.request('/x', { headers: { ...ip, 'X-K': 'a' } })).status).toBe(200)
    expect((await app.request('/x', { headers: { ...ip, 'X-K': 'b' } })).status).toBe(200)
    expect((await app.request('/x', { headers: { ...ip, 'X-K': 'a' } })).status).toBe(429)
  })
})
