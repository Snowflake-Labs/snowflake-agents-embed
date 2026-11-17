// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { canonicalizePath, isApiPath, isDeniedTokenApiPath, route, type EdgeEnv } from './router'
import type { EdgeRuntime } from './runtime'

const rt: EdgeRuntime = { upstreamFetch: vi.fn(), clientIp: () => null, requireBotVerify: false }

function call(path: string, method = 'GET') {
  return route(new Request(`https://tab.example.com${path}`, { method }), {} as EdgeEnv, rt)
}

describe('edge router', () => {
  it.each(['/api', '/api/', '/api/config', '/api/bot/messages'])('sends %s to the proxy', async (path) => {
    const res = await call(path)
    // An empty env proves the proxy ran: it is the only handler that checks SPCS_BASE.
    expect(res?.status).toBe(500)
    expect(await res!.json()).toEqual({ error: 'Proxy misconfigured: missing SPCS_BASE' })
  })

  it.each(['/apix', '/apis/x', '/config', '/', '/token', '/token/exchange/x', '/__proto__', '/constructor'])(
    'leaves %s to static assets',
    (path) => {
      expect(call(path)).toBeNull()
    },
  )

  it.each([
    ['/token/exchange', 'GET'],
    ['/token/exchange', 'PUT'],
    ['/token/link', 'GET'],
    ['/token/link', 'DELETE'],
  ])('rejects %s %s with 405 and Allow: POST', async (path, method) => {
    const res = await call(path, method)
    expect(res?.status).toBe(405)
    expect(res!.headers.get('Allow')).toBe('POST')
  })

  it.each(['/token/exchange', '/token/link'])('runs the %s handler on POST', async (path) => {
    const res = await call(path, 'POST')
    expect(res?.status).toBe(500)
    expect(await res!.json()).toEqual({ error: 'Edge misconfigured' })
  })

  it('matches /api only as a whole path segment', () => {
    expect(isApiPath('/api')).toBe(true)
    expect(isApiPath('/api/x')).toBe(true)
    expect(isApiPath('/apix')).toBe(false)
    expect(isApiPath('/x/api')).toBe(false)
  })

  it.each([
    '/api/token',
    '/api/token/exchange',
    '/api/token/exchange/',
    '/api/token/exch%61nge',
    '/api/token/%65xchange',
    '/api/%74oken/exchange',
    '/API/TOKEN/EXCHANGE',
    '/api//token/exchange',
  ])('denies %s with 404 and never reaches the proxy', async (path) => {
    const res = await call(path, 'POST')
    expect(res?.status).toBe(404)
    expect(rt.upstreamFetch).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid percent-encoding', async () => {
    const res = await call('/api/token/exch%zz', 'POST')
    expect(res?.status).toBe(400)
  })
})

describe('canonicalizePath', () => {
  it('decodes, lowercases, collapses slashes and strips a trailing slash', () => {
    expect(canonicalizePath('/api/token/exch%61nge')).toBe('/api/token/exchange')
    expect(canonicalizePath('/API/TOKEN/EXCHANGE/')).toBe('/api/token/exchange')
    expect(canonicalizePath('/api//token/exchange')).toBe('/api/token/exchange')
    expect(canonicalizePath('/api/%74oken/%65xchange')).toBe('/api/token/exchange')
    expect(canonicalizePath('/')).toBe('/')
  })

  it('returns null on an invalid percent-encoding', () => {
    expect(canonicalizePath('/api/token/exch%zz')).toBeNull()
  })
})

describe('isDeniedTokenApiPath', () => {
  it.each(['/api/token', '/api/token/exchange', '/api/token/x'])('denies %s', (p) => {
    expect(isDeniedTokenApiPath(p)).toBe(true)
  })

  it.each(['/api/config', '/token/exchange', '/api/tokens'])('allows %s', (p) => {
    expect(isDeniedTokenApiPath(p)).toBe(false)
  })
})
