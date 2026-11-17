// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUEST_ALLOW } from '../core/strip-headers'
import { clientIpFrom, createNodeEdge, rebuildRequest, type NodeEdge } from './app'
import { loadNodeConfig } from './config'

let base: string
let dist: string
let upstream: ReturnType<typeof vi.fn>

const env = {
  SPCS_BASE: 'https://spcs.example.test',
  SPCS_PAT: 'pat',
  EDGE_SESSION_SECRET: 'x'.repeat(48),
  BOT_LINK_SECRET: 'y'.repeat(48),
  BOT_APP_ID: 'bot',
} as never

async function mk(hops = 0): Promise<NodeEdge> {
  return createNodeEdge({
    publicOrigin: 'https://edge.example.com',
    tabDistRoot: dist,
    trustedProxyHops: hops,
    env,
    upstreamFetch: upstream as never,
  })
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'edge-app-'))
  dist = join(base, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<html>shell</html>')
  writeFileSync(join(dist, 'assets', 'a.js'), 'console.log(1)')
  writeFileSync(join(base, 'secret.txt'), 'outside')
  upstream = vi.fn(async () => new Response('{"ok":true}', { headers: { 'content-encoding': 'gzip', 'content-length': '999', 'content-type': 'application/json' } }))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const get = (edge: NodeEdge, path: string, init: RequestInit = {}) =>
  edge.handle(new Request('http://attacker.test' + path, init), '10.0.0.9')

describe('static and SPA', () => {
  it('serves health, assets and the shell', async () => {
    const edge = await mk()
    expect(await (await get(edge, '/healthz')).text()).toBe('ok')
    const a = await get(edge, '/assets/a.js')
    expect(a.headers.get('content-type')).toContain('javascript')
    expect(a.headers.get('cache-control')).toContain('immutable')
    expect(await (await get(edge, '/')).text()).toContain('shell')
  })

  it('falls back to index.html for client routes such as /config', async () => {
    const edge = await mk()
    const r = await get(edge, '/config')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('shell')
    expect(r.headers.get('cache-control')).toBe('no-cache')
  })

  it('does not serve files outside the root', async () => {
    const edge = await mk()
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%5c..%5csecret.txt', '/%00']) {
      expect(await (await get(edge, p)).text()).not.toContain('outside')
    }
    symlinkSync(join(base, 'secret.txt'), join(dist, 'link.txt'))
    expect(await (await get(edge, '/link.txt')).text()).not.toContain('outside')
  })

  it('returns JSON 404 for unknown edge paths instead of the shell', async () => {
    const edge = await mk()
    expect((await get(edge, '/api')).status).not.toBe(200)
    const t = await get(edge, '/token/nope')
    expect(t.status).toBe(404)
    expect(t.headers.get('content-type')).toContain('json')
  })

  it('rejects non-GET on static paths', async () => {
    const edge = await mk()
    const r = await get(edge, '/config', { method: 'POST', body: 'x' })
    expect(r.status).toBe(405)
  })
})

describe('request rebuild', () => {
  it('uses PUBLIC_ORIGIN, never Host or X-Forwarded-Host', () => {
    const req = new Request('http://attacker.test/api/x?y=1', {
      headers: { host: 'attacker.test', 'x-forwarded-host': 'attacker.test', 'cf-connecting-ip': '1.1.1.1', connection: 'keep-alive', 'x-keep': 'v' },
    })
    const out = rebuildRequest(req, 'https://edge.example.com')
    expect(out.url).toBe('https://edge.example.com/api/x?y=1')
    expect(out.headers.get('x-forwarded-host')).toBeNull()
    expect(out.headers.get('cf-connecting-ip')).toBeNull()
    expect(out.headers.get('connection')).toBeNull()
    expect(out.headers.get('x-keep')).toBe('v')
  })

  it('forwards a POST body', async () => {
    const out = rebuildRequest(new Request('http://h/token/x', { method: 'POST', body: 'hello' }), 'https://e.test')
    expect(await out.text()).toBe('hello')
  })
})

describe('client ip', () => {
  it('uses the socket when no proxies are trusted', () => {
    expect(clientIpFrom('1.1.1.1, 2.2.2.2', 0, '9.9.9.9')).toBe('9.9.9.9')
  })
  it('takes the Nth entry from the right', () => {
    expect(clientIpFrom('spoof, 1.1.1.1, 2.2.2.2', 1, '9.9.9.9')).toBe('2.2.2.2')
    expect(clientIpFrom('spoof, 1.1.1.1, 2.2.2.2', 2, '9.9.9.9')).toBe('1.1.1.1')
  })
  it('falls back to the socket when the header is short or absent', () => {
    expect(clientIpFrom('1.1.1.1', 2, '9.9.9.9')).toBe('9.9.9.9')
    expect(clientIpFrom(null, 1, '9.9.9.9')).toBe('9.9.9.9')
  })
})

describe('proxy behaviour', () => {
  it('treats the rebuilt origin as the same origin and rejects a spoofed one', async () => {
    const edge = await mk()
    const r = await get(edge, '/api/agents', { headers: { origin: 'http://attacker.test', host: 'attacker.test' } })
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('has the same request allow-list as the Worker adapter (shared core)', () => {
    expect(REQUEST_ALLOW).toContain('content-type')
    expect(REQUEST_ALLOW).not.toContain('cookie')
    expect(REQUEST_ALLOW).not.toContain('x-forwarded-for')
  })
})

describe('config', () => {
  const ok = {
    PUBLIC_ORIGIN: 'https://edge.example.com', SPCS_BASE: 'https://s', SPCS_PAT: 'p', EDGE_SESSION_SECRET: 'e',
    BOT_APP_ID: 'b', BOT_LINK_SECRET: 'l',
  }
  it('accepts a valid config and normalises the origin', () => {
    expect(loadNodeConfig({ ...ok, PUBLIC_ORIGIN: 'https://edge.example.com/' }).publicOrigin).toBe('https://edge.example.com')
  })
  it('requires the bot secrets because the Node edge always verifies the bot', () => {
    expect(() => loadNodeConfig({ ...ok, BOT_APP_ID: undefined })).toThrow(/BOT_APP_ID/)
    expect(() => loadNodeConfig({ ...ok, PUBLIC_ORIGIN: undefined })).toThrow(/PUBLIC_ORIGIN/)
  })
  it('rejects http (except localhost), paths and bad hops', () => {
    expect(() => loadNodeConfig({ ...ok, PUBLIC_ORIGIN: 'http://edge.example.com' })).toThrow(/https/)
    expect(() => loadNodeConfig({ ...ok, PUBLIC_ORIGIN: 'http://localhost:8080' })).not.toThrow()
    expect(() => loadNodeConfig({ ...ok, PUBLIC_ORIGIN: 'https://e.test/app' })).toThrow(/origin only/)
    expect(() => loadNodeConfig({ ...ok, TRUSTED_PROXY_HOPS: '-1' })).toThrow(/TRUSTED_PROXY_HOPS/)
  })
})
