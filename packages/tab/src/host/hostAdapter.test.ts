// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { tabHostAdapter, setTabOnUnauthorized, setTabEdgeSession } from './hostAdapter'

afterEach(() => { vi.unstubAllGlobals() })

describe('tabHostAdapter', () => {
  it('sends no Snowflake credential in production, only the edge session', () => {
    setTabEdgeSession('sess')
    const headers = tabHostAdapter.headers('tok')
    expect(headers.Authorization).toBeUndefined()
    expect(headers['X-User-Access-Token']).toBeUndefined()
    expect(headers['X-Edge-Session']).toBe('sess')
    setTabEdgeSession(null)
  })

  it('local-pat sends Authorization and X-User-Access-Token directly', () => {
    vi.stubEnv('VITE_AUTH_MODE', 'local-pat')
    const headers = tabHostAdapter.headers('tok')
    expect(headers.Authorization).toBe('Snowflake Token="tok"')
    expect(headers['X-User-Access-Token']).toBe('tok')
    vi.unstubAllEnvs()
  })

  it('adds X-Edge-Session only once a session is set', () => {
    expect(tabHostAdapter.headers('tok')['X-Edge-Session']).toBeUndefined()
    setTabEdgeSession('sess')
    expect(tabHostAdapter.headers('tok')['X-Edge-Session']).toBe('sess')
    setTabEdgeSession(null)
    expect(tabHostAdapter.headers('tok')['X-Edge-Session']).toBeUndefined()
  })

  it('merges extra headers without dropping the auth headers', () => {
    setTabEdgeSession('sess')
    const headers = tabHostAdapter.headers('tok', { Accept: 'text/event-stream' })
    expect(headers.Accept).toBe('text/event-stream')
    expect(headers['X-Edge-Session']).toBe('sess')
    setTabEdgeSession(null)
  })

  it('telemetry POSTs to /api/telemetry with the event and fields, swallowing failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    tabHostAdapter.telemetry!('tok', 'agent_run', { ttftMs: 200 })
    await Promise.resolve() // let the fire-and-forget microtask run
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/telemetry')
    expect(JSON.parse(opts.body)).toEqual({ event: 'agent_run', fields: { ttftMs: 200 } })

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(() => tabHostAdapter.telemetry!('tok', 'agent_run', {})).not.toThrow()
  })

  it('onUnauthorized forwards to the handler installed by useTeamsAuth', async () => {
    expect(await tabHostAdapter.onUnauthorized!()).toBeNull()
    setTabOnUnauthorized(async () => 'fresh')
    expect(await tabHostAdapter.onUnauthorized!()).toBe('fresh')
    setTabOnUnauthorized(undefined)
    expect(await tabHostAdapter.onUnauthorized!()).toBeNull()
  })

  it('openExternalUrl opens an https URL in a new tab', () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    tabHostAdapter.openExternalUrl!('https://acct.snowflakecomputing.com/oauth/start')
    expect(open).toHaveBeenCalledWith(
      'https://acct.snowflakecomputing.com/oauth/start',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('openExternalUrl ignores a non-https URL', () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    tabHostAdapter.openExternalUrl!('javascript:alert(1)')
    expect(open).not.toHaveBeenCalled()
  })
})
