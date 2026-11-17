// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleApi, normalizeOrigin, onRequest } from './api-proxy'
import { signEdgeSession } from './edge-session'
import { defaultRuntime } from './runtime'

const SECRET = 'test-secret-test-secret-test-secret'
const ORIGIN = 'https://tab.example.com'
const env = { SPCS_BASE: 'https://spcs.example.com', SPCS_PAT: 'pat-value', EDGE_SESSION_SECRET: SECRET }
const BOT_JWT = 'Bearer aaa.bbb.ccc'

let upstream: ReturnType<typeof vi.fn>

function call(path: string, headers: Record<string, string> = {}, method = 'POST') {
  const request = new Request(`${ORIGIN}${path}`, { method, headers, body: method === 'GET' ? undefined : '{}' })
  return onRequest({ request, env } as any)
}

beforeEach(() => {
  upstream = vi.fn(async () => new Response('ok'))
  vi.stubGlobal('fetch', upstream)
})
afterEach(() => vi.unstubAllGlobals())

describe('/api proxy gate', () => {
  it('rejects a request with no Origin', async () => {
    const res = await call('/api/config', {}, 'GET')
    expect(res.status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('rejects a cross-site GET with no Origin', async () => {
    const res = await call('/api/config', { 'Sec-Fetch-Site': 'cross-site' }, 'GET')
    expect(res.status).toBe(403)
  })

  it('rejects a same-origin POST with no Origin', async () => {
    const res = await call('/api/config', { 'Sec-Fetch-Site': 'same-origin' }, 'POST')
    expect(res.status).toBe(403)
  })

  it('accepts a same-origin GET with no Origin and a valid edge session', async () => {
    const session = await signEdgeSession({ tid: 't', oid: 'o', snowflakeToken: 'sf-token' }, SECRET)
    const res = await call('/api/config', { 'Sec-Fetch-Site': 'same-origin', 'X-Edge-Session': session }, 'GET')
    expect(res.status).toBe(200)
  })

  it('rejects a foreign Origin', async () => {
    const res = await call('/api/config', { Origin: 'https://evil.example' }, 'GET')
    expect(res.status).toBe(403)
  })

  it('rejects a valid Origin with no edge session', async () => {
    const res = await call('/api/config', { Origin: ORIGIN }, 'GET')
    expect(res.status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('rejects a forged edge session', async () => {
    const res = await call('/api/config', { Origin: ORIGIN, 'X-Edge-Session': 'junk' }, 'GET')
    expect(res.status).toBe(401)
  })

  it('forwards with the PAT when the session is valid, stripping client-supplied internals', async () => {
    const session = await signEdgeSession({ tid: 't', oid: 'o', snowflakeToken: 'sf-from-session' }, SECRET)
    const res = await call('/api/config', {
      Origin: ORIGIN,
      'X-Edge-Session': session,
      'X-Bot-Auth': 'Bearer spoofed',
      'X-User-Access-Token': 'browser-supplied',
    }, 'GET')
    expect(res.status).toBe(200)
    const req = upstream.mock.calls[0][0] as Request
    expect(req.headers.get('Authorization')).toBe('Snowflake Token="pat-value"')
    expect(req.headers.get('X-Bot-Auth')).toBeNull()
    expect(req.headers.get('X-Edge-Session')).toBeNull()
    expect(req.headers.get('X-User-Access-Token')).toBe('sf-from-session')
  })

  it.each([
    '/api/token/exchange',
    '/api/token/exchange/',
    '/api/token/exch%61nge',
    '/api/token/%65xchange',
    '/api/%74oken/exchange',
    '/API/TOKEN/EXCHANGE',
    '/api/token/exchange/',
    '/api/token/%65xchange/',
    '/api/token/exch%2561nge',
  ])('returns 404 for %s and never reaches upstream', async (path) => {
    const res = await call(path, { Origin: ORIGIN })
    expect(res.status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('turns an upstream 3xx into 502 and forwards no headers', async () => {
    const session = await signEdgeSession({ tid: 't', oid: 'o', snowflakeToken: 'sf-token' }, SECRET)
    upstream.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'https://evil.example/steal', 'Set-Cookie': 'sf=token' },
    }))
    const res = await call('/api/config', { Origin: ORIGIN, 'X-Edge-Session': session }, 'GET')
    expect(res.status).toBe(502)
    expect(res.headers.get('Location')).toBeNull()
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(await res.json()).toEqual({ error: 'Bad gateway' })
  })

  it('strips Set-Cookie and CORS headers from an upstream 200', async () => {
    const session = await signEdgeSession({ tid: 't', oid: 'o', snowflakeToken: 'sf-token' }, SECRET)
    upstream.mockResolvedValue(new Response('ok', {
      headers: {
        'Set-Cookie': 'sf=token',
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain',
      },
    }))
    const res = await call('/api/config', { Origin: ORIGIN, 'X-Edge-Session': session }, 'GET')
    expect(res.status).toBe(200)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Content-Type')).toBe('text/plain')
  })

  it('returns 400 for an invalid percent-encoding in the path', async () => {
    const res = await call('/api/token/exch%zz', { Origin: ORIGIN })
    expect(res.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })
})

describe('/api/bot/messages', () => {
  const rtOff = () => ({ ...defaultRuntime, requireBotVerify: false, upstreamFetch: upstream })

  function botCall(headers: Record<string, string> = {}) {
    const request = new Request(`${ORIGIN}/api/bot/messages`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    return handleApi(request, env as any, rtOff())
  }

  it('never forwards a client-supplied X-User-Access-Token', async () => {
    await botCall({ Authorization: BOT_JWT, 'X-User-Access-Token': 'spoof' })
    const req = upstream.mock.calls[0][0] as Request
    expect(req.headers.get('X-User-Access-Token')).toBeNull()
  })

  it('rejects a request without a Bearer JWT', async () => {
    const res = await botCall()
    expect(res.status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('moves the Bot Framework JWT into X-Bot-Auth', async () => {
    const res = await botCall({ Authorization: BOT_JWT })
    expect(res.status).toBe(200)
    const req = upstream.mock.calls[0][0] as Request
    expect(req.headers.get('X-Bot-Auth')).toBe(BOT_JWT)
    expect(req.headers.get('Authorization')).toBe('Snowflake Token="pat-value"')
  })
})

describe('normalizeOrigin', () => {
  it('accepts a bare https origin', () => {
    expect(normalizeOrigin('https://a.example.com')).toBe('https://a.example.com')
    expect(normalizeOrigin('https://a.example.com/')).toBe('https://a.example.com')
  })

  it.each(['http://a.example.com', '*', 'https://*.example.com', 'https://a.example.com/path', 'https://u:p@a.example.com', ''])(
    'rejects %s',
    (v) => expect(normalizeOrigin(v)).toBeNull(),
  )
})
