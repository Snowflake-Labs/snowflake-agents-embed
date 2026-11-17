// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
// requireBotVerify (private ingress): the edge verifies the Bot Connector JWT even when bot
// links are off, because nothing public sits in front of the PAT besides this edge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./bot-link', async (orig) => ({
  ...(await orig<typeof import('./bot-link')>()),
  verifyBotRequest: vi.fn(),
}))

import { handleApi, type ApiEnv } from './api-proxy'
import { verifyBotRequest } from './bot-link'
import type { EdgeRuntime } from './runtime'

const BOT_JWT = 'Bearer aaa.bbb.ccc'
const ACTIVITY = { type: 'message', from: { aadObjectId: 'o1' }, channelData: { tenant: { id: 't1' } } }
const baseEnv: ApiEnv = {
  SPCS_BASE: 'https://pl.example.privatelink.snowflakecomputing.app',
  SPCS_PAT: 'pat',
  EDGE_SESSION_SECRET: 'x'.repeat(32),
  BOT_APP_ID: 'bot-app',
}

let upstreamFetch: ReturnType<typeof vi.fn>
let globalFetch: ReturnType<typeof vi.fn>

function rt(requireBotVerify: boolean): EdgeRuntime {
  return { upstreamFetch, clientIp: () => '203.0.113.9', requireBotVerify }
}

function post(env: ApiEnv, requireBotVerify = true, body = JSON.stringify(ACTIVITY), headers: Record<string, string> = {}) {
  const request = new Request('https://tab.example.com/api/bot/messages', {
    method: 'POST',
    headers: { Authorization: BOT_JWT, ...headers },
    body,
  })
  return handleApi(request, env, rt(requireBotVerify))
}

beforeEach(() => {
  upstreamFetch = vi.fn(async () => new Response('ok'))
  globalFetch = vi.fn(async () => new Response('global'))
  vi.stubGlobal('fetch', globalFetch)
  vi.mocked(verifyBotRequest).mockReset().mockResolvedValue({ tid: 't1', oid: 'o1' })
})
afterEach(() => vi.unstubAllGlobals())

describe('/api/bot/messages with requireBotVerify', () => {
  it('rejects a JWT that fails verification without calling SPCS', async () => {
    vi.mocked(verifyBotRequest).mockResolvedValue(null)
    const res = await post(baseEnv)
    expect(res.status).toBe(401)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('verifies against BOT_APP_ID and relays through upstreamFetch with no link code', async () => {
    const res = await post(baseEnv, true, JSON.stringify(ACTIVITY), {
      'X-Link-Code': 'spoofed',
      'X-User-Access-Token': 'spoofed',
      'X-Bot-Auth': 'spoofed',
    })
    expect(res.status).toBe(200)
    expect(verifyBotRequest).toHaveBeenCalledWith(BOT_JWT, 'bot-app', ACTIVITY)
    expect(globalFetch).not.toHaveBeenCalled()
    const req = upstreamFetch.mock.calls[0][0] as Request
    expect(req.url).toBe('https://pl.example.privatelink.snowflakecomputing.app/api/bot/messages')
    expect(req.headers.get('X-Bot-Auth')).toBe(BOT_JWT)
    expect(req.headers.get('Authorization')).toBe('Snowflake Token="pat"')
    expect(req.headers.get('X-Link-Code')).toBeNull()
    expect(req.headers.get('X-User-Access-Token')).toBeNull()
    expect(req.headers.get('X-Agents-Client-Ip')).toBe('203.0.113.9')
    expect(JSON.parse(await req.text())).toEqual(ACTIVITY)
  })

  it('fails closed with 500 when BOT_APP_ID is missing', async () => {
    const { BOT_APP_ID: _, ...env } = baseEnv
    const res = await post(env)
    expect(res.status).toBe(500)
    expect(verifyBotRequest).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects an oversized body with 413', async () => {
    const res = await post(baseEnv, true, 'x'.repeat(1_000_001))
    expect(res.status).toBe(413)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects a body that is not JSON with 400', async () => {
    const res = await post(baseEnv, true, 'not json')
    expect(res.status).toBe(400)
    expect(verifyBotRequest).not.toHaveBeenCalled()
  })

  it('leaves the public path unchanged: no edge verify without links or requireBotVerify', async () => {
    const { BOT_APP_ID: _, ...env } = baseEnv
    const res = await post(env, false)
    expect(res.status).toBe(200)
    expect(verifyBotRequest).not.toHaveBeenCalled()
    expect((upstreamFetch.mock.calls[0][0] as Request).headers.get('X-Bot-Auth')).toBe(BOT_JWT)
  })
})
