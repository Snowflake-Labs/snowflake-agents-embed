// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hostFetch } from './hostFetch'
import { setHostAdapter, resetHostAdapter, type HostAdapter } from '../host/hostAdapter'

const fakeAdapter: HostAdapter = {
  baseUrl: () => '',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
}

beforeEach(() => { setHostAdapter(fakeAdapter) })
afterEach(() => { vi.unstubAllGlobals(); resetHostAdapter() })

describe('hostFetch', () => {
  it('sends the token and returns a 200 without asking the host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await hostFetch('tok', '/api/threads', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'X-User-Access-Token': 'tok' })
  })

  it('retries once with the reminted token on 401', async () => {
    const onUnauthorized = vi.fn().mockResolvedValue('fresh-tok')
    setHostAdapter({ ...fakeAdapter, onUnauthorized })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await hostFetch('stale', '/api/agents', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ 'X-User-Access-Token': 'fresh-tok' })
  })

  it('does not remint a Cortex agent_forbidden 401', async () => {
    const onUnauthorized = vi.fn().mockResolvedValue('fresh-tok')
    setHostAdapter({ ...fakeAdapter, onUnauthorized })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'You do not have access to that resource.', code: 'agent_forbidden' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await hostFetch('tok', '/api/threads')
    expect(res.status).toBe(401)
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not remint a network_policy_blocked 401 either — reminting a token cannot fix a network policy', async () => {
    const onUnauthorized = vi.fn().mockResolvedValue('fresh-tok')
    setHostAdapter({ ...fakeAdapter, onUnauthorized })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: "Your Snowflake account's network policy is blocking this connection. Contact your Snowflake administrator.",
        code: 'network_policy_blocked',
      }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await hostFetch('tok', '/api/threads')
    expect(res.status).toBe(401)
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not retry when onUnauthorized returns null', async () => {
    setHostAdapter({ ...fakeAdapter, onUnauthorized: async () => null })
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await hostFetch('stale', '/api/threads')
    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
