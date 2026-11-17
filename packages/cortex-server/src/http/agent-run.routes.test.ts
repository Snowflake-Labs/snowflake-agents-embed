// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { registerAgentRunRoutes, wrapUpstreamSse } from './agent-run.routes.js'
import type { CortexRouteDeps } from './deps.js'
import type { SnowflakeCredential } from '../snowflake/credential.js'
import type { CredentialFailure } from '../host/credentialResolver.js'

const OAUTH: SnowflakeCredential = { token: 'mytoken', tokenType: 'OAUTH' }

function depsWith(
  resolve: () => Promise<SnowflakeCredential | CredentialFailure>,
  configOverrides: Partial<CortexRouteDeps['config']> = {},
): CortexRouteDeps {
  return {
    config: {
      snowflakeAccount: 'testacct',
      defaultAgentFqn: 'DB.SCH.AG',
      agentAllowList: [{ fqn: 'DB.SCH.AG', displayName: 'Test Agent' }],
      agentDiscovery: 'static',
      ...configOverrides,
    } as CortexRouteDeps['config'],
    host: { originApp: 'agents_test', credentials: { resolve } },
  }
}

function makeApp(deps: CortexRouteDeps) {
  const app = new Hono()
  registerAgentRunRoutes(app, deps)
  return app
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('POST /api/agent/run', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const app = makeApp(depsWith(async () => ({ error: 'Unauthorized', status: 401 })))
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'DB.SCH.AG', messages: [] }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 413 when body exceeds 5 MB', async () => {
    const app = makeApp(depsWith(async () => OAUTH))
    const oversized = 'x'.repeat(5_242_881)
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    })
    expect(res.status).toBe(413)
  })

  it('counts bytes, not UTF-16 units, for the 5 MB cap', async () => {
    const app = makeApp(depsWith(async () => OAUTH))
    // 3-byte chars: 1.8M code units but ~5.4 MB on the wire.
    const body = JSON.stringify({ messages: [], pad: '€'.repeat(1_800_000) })
    expect(body.length).toBeLessThan(5_242_880)
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    expect(res.status).toBe(413)
  })

  it('drops unknown client keys instead of forwarding them to Cortex', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: response\ndata: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH))
    await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentFqn: 'DB.SCH.AG', messages: [], thread_id: 3, parent_message_id: 0,
        tool_choice: { type: 'auto' }, statement: 'DROP TABLE x', stream: false,
      }),
    })
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(sent).toEqual({
      messages: [], thread_id: 3, parent_message_id: 0, tool_choice: { type: 'auto' }, stream: true,
    })
  })

  it('returns 403 when agentFqn is not on the allow-list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'DB.SCH.EVIL', messages: [] }),
    })
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('in dynamic mode forwards any well-formed FQN (RBAC enforced by Snowflake)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: response\ndata: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH, { agentDiscovery: 'dynamic' }))
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'DB.SCH.NOT_LISTED', messages: [] }),
    })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('DB/schemas/SCH/agents/NOT_LISTED:run')
  })

  it('returns 400 on a malformed FQN', async () => {
    const app = makeApp(depsWith(async () => OAUTH, { agentDiscovery: 'dynamic' }))
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'not-a-valid-fqn', messages: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 500 when neither the body nor config supplies an agent FQN', async () => {
    const app = makeApp(depsWith(async () => OAUTH, { defaultAgentFqn: '' }))
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })
    expect(res.status).toBe(500)
  })

  it('forwards allowed requests to Cortex with stream:true and strips agentFqn and origin_application', async () => {
    // This is the regression the shared route factory closes: the Teams-only version of
    // this route stripped only agentFqn. If a caller (or a client bug) sends
    // origin_application in the body, Cortex's :run endpoint rejects it outright
    // (400/390142) - the field belongs only on the /threads endpoints.
    const streamBody = 'event: response\ndata: {}\n\n'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(streamBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH))
    await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'DB.SCH.AG', origin_application: 'agents_teams', messages: [] }),
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('DB/schemas/SCH/agents/AG:run')
    const sent = JSON.parse((opts as RequestInit).body as string)
    expect(sent.stream).toBe(true)
    expect(sent.origin_application).toBeUndefined()
    expect(sent.agentFqn).toBeUndefined()
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer mytoken',
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
    })
  })

  it('sets X-Accel-Buffering: no on the streamed response', async () => {
    // Without this, an nginx-family proxy in front of the container (SPCS ingress
    // included) buffers the whole body before forwarding it - turning a live
    // stream into one late dump. Previously only relay set this; now both hosts do.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: response\ndata: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'DB.SCH.AG', messages: [] }),
    })
    expect(res.headers.get('X-Accel-Buffering')).toBe('no')
  })

  it('redacts an upstream failure and omits the detail field', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('agent not found in DB.SCH.AG', { status: 404 })))
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'DB.SCH.AG', messages: [] }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.detail).toBeUndefined()
    expect(body.code).toBe('thread_not_found')
    expect(JSON.stringify(body)).not.toContain('DB.SCH.AG')
  })

  it('injects a synthetic error frame when the upstream stream ends without a terminal event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('event: response.text.delta\ndata: {"text":"hi"}\n\n', {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      }),
    ))
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'DB.SCH.AG', messages: [] }),
    })
    const text = await res.text()
    expect(text).toContain('event: error')
    expect(text).toContain('upstream_stream_truncated')
  })

  it('does not inject a truncate frame when a terminal response event arrived', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('event: response\ndata: {}\n\n', {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      }),
    ))
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentFqn: 'DB.SCH.AG', messages: [] }),
    })
    expect(await res.text()).not.toContain('upstream_stream_truncated')
  })

  it('redacts event: error frames to code and message', async () => {
    const frame = 'event: error\ndata: {"code":"x","message":"boom","detail":{"sql":"SELECT secret"}}\n\n'
    const wrapped = wrapUpstreamSse(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(frame))
        c.close()
      },
    }), { pingMs: 60_000 })
    const text = new TextDecoder().decode((await wrapped.getReader().read()).value)
    expect(text).toContain('event: error')
    expect(text).toContain('"code":"x"')
    expect(text).toContain('"message":"boom"')
    expect(text).not.toContain('SELECT secret')
  })

  it('injects an SSE comment ping while the upstream is silent', async () => {
    vi.useFakeTimers()
    const upstream = new ReadableStream<Uint8Array>({
      start() { /* hang open, no chunks */ },
    })
    const wrapped = wrapUpstreamSse(upstream, { pingMs: 15_000 })
    const reader = wrapped.getReader()
    const pending = reader.read()
    await vi.advanceTimersByTimeAsync(15_000)
    const first = await pending
    expect(new TextDecoder().decode(first.value)).toBe(':ping\n\n')
    await reader.cancel()
    vi.useRealTimers()
  })

  it('returns 400 on invalid JSON', async () => {
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })
})
