// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./bot-link', async (orig) => ({
  ...(await orig<typeof import('./bot-link')>()),
  verifyBotRequest: vi.fn(),
}))

import { onRequest } from './api-proxy'
import { linkKey, mintLinkCode, openLinkCode, saveLink, verifyBotRequest, type KvLike } from './bot-link'

const SECRET = 'bot-link-secret-bot-link-secret-00'
const OBO_ENV = { AZURE_TENANT_ID: 't1', OBO_CLIENT_ID: 'c', OBO_CLIENT_SECRET: 's', SNOWFLAKE_SCOPE: 'api://sf/x' }

function memKv(): KvLike & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v) },
    delete: async (k) => { store.delete(k) },
  }
}

let upstream: ReturnType<typeof vi.fn>
let kv: ReturnType<typeof memKv>
const env = () => ({
  SPCS_BASE: 'https://spcs.example.com', SPCS_PAT: 'pat', EDGE_SESSION_SECRET: 'x'.repeat(32),
  BOT_LINKS: kv, BOT_LINK_SECRET: SECRET, BOT_APP_ID: 'bot-app', ...OBO_ENV,
})

function post(headers: Record<string, string> = {}) {
  const request = new Request('https://tab.example.com/api/bot/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer aaa.bbb.ccc', ...headers },
    body: JSON.stringify({ type: 'message', from: { aadObjectId: 'o1' }, channelData: { tenant: { id: 't1' } } }),
  })
  return onRequest({ request, env: env() } as any)
}

beforeEach(() => {
  kv = memKv()
  upstream = vi.fn(async () => new Response('ok'))
  vi.stubGlobal('fetch', upstream)
  vi.mocked(verifyBotRequest).mockResolvedValue({ tid: 't1', oid: 'o1' })
})
afterEach(() => vi.unstubAllGlobals())

describe('/api/bot/messages per-user identity', () => {
  it('rejects a request whose Bot Framework JWT fails verification', async () => {
    vi.mocked(verifyBotRequest).mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('injects a link code bound to the verified identity when unlinked, never a client-supplied one', async () => {
    const res = await post({ 'X-Link-Code': 'spoofed', 'X-User-Access-Token': 'spoofed' })
    expect(res.status).toBe(200)
    const req = upstream.mock.calls[0][0] as Request
    expect(req.headers.get('X-User-Access-Token')).toBeNull()
    const code = req.headers.get('X-Link-Code')!
    expect(code).not.toBe('spoofed')
    expect(await openLinkCode(code, SECRET)).toMatchObject({ tid: 't1', oid: 'o1' })
    expect(JSON.parse(await req.text()).from.aadObjectId).toBe('o1')
  })

  it('injects the linked user token and no link code', async () => {
    await saveLink(kv, 't1', 'o1', { rt: 'r', at: 'user-sf', atExp: Math.floor(Date.now() / 1000) + 3000 }, SECRET)
    await post()
    const req = upstream.mock.calls[0][0] as Request
    expect(req.headers.get('X-User-Access-Token')).toBe('user-sf')
    expect(req.headers.get('X-Link-Code')).toBeNull()
  })

  it('deletes the link and strips X-Unlink when the server signs the user out', async () => {
    await saveLink(kv, 't1', 'o1', { rt: 'r', at: 'user-sf', atExp: Math.floor(Date.now() / 1000) + 3000 }, SECRET)
    upstream.mockResolvedValue(new Response('ok', { headers: { 'X-Unlink': '1' } }))
    const res = await post()
    expect(res.headers.get('X-Unlink')).toBeNull()
    expect(kv.store.has(linkKey('t1', 'o1'))).toBe(false)
  })

  it('mints distinct codes per call', async () => {
    expect(await mintLinkCode('t1', 'o1', SECRET)).not.toBe(await mintLinkCode('t1', 'o1', SECRET))
  })
})
