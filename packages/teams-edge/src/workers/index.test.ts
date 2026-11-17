// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../core/bot-link', async (orig) => ({
  ...(await orig<typeof import('../core/bot-link')>()),
  verifyBotRequest: vi.fn(),
}))

import worker, { workerRuntime, type WorkerEnv } from './index'
import { saveLink, verifyBotRequest, type KvLike } from '../core/bot-link'
import { defaultRuntime } from '../core/runtime'

const SECRET = 'bot-link-secret-bot-link-secret-00'
const SPCS_BASE = 'https://pl.example.privatelink.snowflakecomputing.app'

function memKv(): KvLike {
  const store = new Map<string, string>()
  return {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v) },
    delete: async (k) => { store.delete(k) },
  }
}

let assets: { fetch: ReturnType<typeof vi.fn> }
let vpc: { fetch: ReturnType<typeof vi.fn> }
let globalFetch: ReturnType<typeof vi.fn>
let kv: KvLike

function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    ASSETS: assets,
    SPCS_UPSTREAM: 'vpc',
    SPCS_VPC: vpc,
    SPCS_BASE,
    SPCS_PAT: 'pat',
    EDGE_SESSION_SECRET: 'x'.repeat(32),
    BOT_LINKS: kv,
    BOT_LINK_SECRET: SECRET,
    BOT_APP_ID: 'bot-app',
    AZURE_TENANT_ID: 't1',
    OBO_CLIENT_ID: 'c',
    OBO_CLIENT_SECRET: 's',
    SNOWFLAKE_SCOPE: 'api://sf/x',
    ...overrides,
  } as unknown as WorkerEnv
}

function botPost() {
  return new Request('https://tab.example.com/api/bot/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer aaa.bbb.ccc', 'CF-Connecting-IP': '198.51.100.7' },
    body: JSON.stringify({ type: 'message' }),
  })
}

const run = (request: Request, e: WorkerEnv) => worker.fetch(request as any, e, {} as any) as Promise<Response>

beforeEach(async () => {
  assets = { fetch: vi.fn(async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } })) }
  vpc = { fetch: vi.fn(async () => new Response('from-spcs')) }
  globalFetch = vi.fn(async () =>
    Response.json({ access_token: 'fresh-sf', expires_in: 3600, scope: 'api://sf/x offline_access', refresh_token: 'r2' }),
  )
  vi.stubGlobal('fetch', globalFetch)
  kv = memKv()
  vi.mocked(verifyBotRequest).mockReset().mockResolvedValue({ tid: 't1', oid: 'o1' })
})
afterEach(() => vi.unstubAllGlobals())

describe('workerRuntime', () => {
  it('uses the default (global fetch) runtime when SPCS_UPSTREAM is unset or public', () => {
    expect(workerRuntime(env({ SPCS_UPSTREAM: undefined }))).toBe(defaultRuntime)
    expect(workerRuntime(env({ SPCS_UPSTREAM: 'public' }))).toBe(defaultRuntime)
  })

  it('requires the bot verify and uses the VPC binding in vpc mode', () => {
    const rt = workerRuntime(env())
    expect(rt.requireBotVerify).toBe(true)
    expect(rt.clientIp(botPost())).toBe('198.51.100.7')
  })

  it('throws on vpc without the binding, and on an unknown mode', () => {
    expect(() => workerRuntime(env({ SPCS_VPC: undefined }))).toThrow(/SPCS_VPC/)
    expect(() => workerRuntime(env({ SPCS_UPSTREAM: 'VPC' }))).toThrow(/Unknown SPCS_UPSTREAM/)
  })
})

describe('Worker fetch', () => {
  it('sends SPCS calls through SPCS_VPC and Entra calls through global fetch', async () => {
    // An expired cached token forces an Entra refresh before the SPCS call.
    await saveLink(kv, 't1', 'o1', { rt: 'r1', at: 'stale', atExp: 0 }, SECRET)
    const res = await run(botPost(), env())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('from-spcs')

    expect(globalFetch).toHaveBeenCalledTimes(1)
    expect(String(globalFetch.mock.calls[0][0])).toBe('https://login.microsoftonline.com/t1/oauth2/v2.0/token')

    expect(vpc.fetch).toHaveBeenCalledTimes(1)
    const req = vpc.fetch.mock.calls[0][0] as Request
    expect(req.url).toBe(`${SPCS_BASE}/api/bot/messages`)
    expect(req.headers.get('X-User-Access-Token')).toBe('fresh-sf')
    expect(req.headers.get('Authorization')).toBe('Snowflake Token="pat"')
    expect(assets.fetch).not.toHaveBeenCalled()
  })

  it('verifies the bot at the edge in vpc mode even with bot links off', async () => {
    vi.mocked(verifyBotRequest).mockResolvedValue(null)
    const res = await run(botPost(), env({ BOT_LINKS: undefined, BOT_LINK_SECRET: undefined }))
    expect(res.status).toBe(401)
    expect(vpc.fetch).not.toHaveBeenCalled()
  })

  it('uses global fetch for SPCS in public mode', async () => {
    const res = await run(botPost(), env({ SPCS_UPSTREAM: undefined, SPCS_VPC: undefined, BOT_LINKS: undefined }))
    expect(res.status).toBe(200)
    expect(globalFetch).toHaveBeenCalledTimes(1)
    expect((globalFetch.mock.calls[0][0] as Request).url).toBe(`${SPCS_BASE}/api/bot/messages`)
  })

  it.each([
    ['a missing SPCS_VPC binding', { SPCS_VPC: undefined }],
    ['an unknown SPCS_UPSTREAM', { SPCS_UPSTREAM: 'tunnel' }],
  ])('fails closed with 500 on %s, before any fetch', async (_label, overrides) => {
    const res = await run(botPost(), env(overrides))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Edge misconfigured' })
    expect(globalFetch).not.toHaveBeenCalled()
    expect(vpc.fetch).not.toHaveBeenCalled()
    expect(assets.fetch).not.toHaveBeenCalled()
  })

  it('serves non-edge paths from static assets', async () => {
    const request = new Request('https://tab.example.com/config')
    const res = await run(request, env())
    expect(res.headers.get('Content-Type')).toBe('text/html')
    expect(assets.fetch).toHaveBeenCalledWith(request)
    expect(vpc.fetch).not.toHaveBeenCalled()
  })

  it('answers GET /token/exchange with 405 instead of the SPA', async () => {
    const res = await run(new Request('https://tab.example.com/token/exchange'), env())
    expect(res.status).toBe(405)
    expect(assets.fetch).not.toHaveBeenCalled()
  })
})
