// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { registerThreadRoutes } from './threads.routes.js'
import type { CortexRouteDeps } from './deps.js'
import type { SnowflakeCredential } from '../snowflake/credential.js'
import type { CredentialFailure } from '../host/credentialResolver.js'

const OAUTH: SnowflakeCredential = { token: 'mytoken', tokenType: 'OAUTH' }

function depsWith(
  resolve: () => Promise<SnowflakeCredential | CredentialFailure>,
  configOverrides: Partial<CortexRouteDeps['config']> = {},
  originApp = 'agents_test',
): CortexRouteDeps {
  return {
    config: { snowflakeAccount: 'testacct', ...configOverrides } as CortexRouteDeps['config'],
    host: { originApp, credentials: { resolve } },
  }
}

function makeApp(deps: CortexRouteDeps) {
  const app = new Hono()
  registerThreadRoutes(app, deps)
  return app
}

afterEach(() => { vi.restoreAllMocks() })

describe('GET /api/threads', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const app = makeApp(depsWith(async () => ({ error: 'Unauthorized', status: 401 })))
    const res = await app.request('/api/threads')
    expect(res.status).toBe(401)
  })

  it('forwards the resolved credential headers and origin_application filter to Cortex', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ thread_id: 1 }]), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH, {}, 'agents_teams'))
    await app.request('/api/threads')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('origin_application=agents_teams')
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer mytoken',
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
    })
  })

  it('passes through page_size and after query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH))
    await app.request('/api/threads?page_size=10&after=5')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('page_size=10')
    expect(url).toContain('after=5')
  })
})

describe('GET /api/threads/:id', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const app = makeApp(depsWith(async () => ({ error: 'Unauthorized', status: 401 })))
    const res = await app.request('/api/threads/42')
    expect(res.status).toBe(401)
  })

  it('forwards page_size and last_message_id, and returns the upstream body verbatim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ thread_id: 42 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/threads/42?page_size=5&last_message_id=7')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ thread_id: 42 })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/v2/cortex/threads/42')
    expect(url).toContain('page_size=5')
    expect(url).toContain('last_message_id=7')
  })
})

describe('POST /api/threads/:id (rename)', () => {
  it('forwards the rename body and returns the upstream status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/threads/42', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_name: 'New name' }),
    })
    expect(res.status).toBe(200)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/v2/cortex/threads/42')
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ thread_name: 'New name' })
  })
})

describe('DELETE /api/threads/:id', () => {
  it('forwards DELETE to Cortex with the resolved credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/threads/42', { method: 'DELETE' })
    expect(res.status).toBe(204)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/v2/cortex/threads/42')
    expect((opts as RequestInit).method).toBe('DELETE')
  })
})

describe('thread id validation', () => {
  it.each(['GET', 'POST', 'DELETE'] as const)('%s rejects a traversal id before fetching', async (method) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/threads/..%2F..%2Fstatements', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    })
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/threads with agentsSecondaryOrigin', () => {
  it('makes two parallel Cortex calls and merges results sorted by updated_at desc', async () => {
    const primaryThreads = [{ thread_id: 1, thread_name: 'Primary chat', updated_at: '2024-01-02T00:00:00Z' }]
    const secondaryThreads = [{ thread_id: 2, thread_name: 'CoWork chat', updated_at: '2024-01-03T00:00:00Z' }]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(primaryThreads), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondaryThreads), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const app = makeApp(depsWith(async () => OAUTH, { agentsSecondaryOrigin: 'snowflake_cowork' }, 'agents_teams'))
    const res = await app.request('/api/threads')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const urls = fetchMock.mock.calls.map((call) => call[0] as string)
    expect(urls.some((u: string) => u.includes('origin_application=agents_teams'))).toBe(true)
    expect(urls.some((u: string) => u.includes('origin_application=snowflake_cowork'))).toBe(true)

    const body = await res.json()
    expect(body.threads).toHaveLength(2)
    expect(body.threads[0].thread_id).toBe(2)
    expect(body.threads[0].source).toBe('cowork')
    expect(body.threads[1].thread_id).toBe(1)
    expect(body.threads[1].source).toBeUndefined()
  })

  it('skips the secondary origin when an after cursor is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ threads: [{ thread_id: 3 }], after: 'p2' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH, { agentsSecondaryOrigin: 'snowflake_cowork' }, 'agents_teams'))
    const res = await app.request('/api/threads?page_size=10&after=p1')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('after=p1')
    expect(fetchMock.mock.calls[0][0]).not.toContain('snowflake_cowork')
    const body = await res.json()
    expect(body.threads).toHaveLength(1)
    expect(body.after).toBe('p2')
  })

  it('returns primary threads only when secondary fetch fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ thread_id: 1 }]), { status: 200 }))
      .mockRejectedValueOnce(new Error('network error'))
    vi.stubGlobal('fetch', fetchMock)

    const app = makeApp(depsWith(async () => OAUTH, { agentsSecondaryOrigin: 'snowflake_cowork' }))
    const res = await app.request('/api/threads')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.threads).toHaveLength(1)
    expect(body.threads[0].thread_id).toBe(1)
  })

  it('calls without origin_application filter when secondary origin is "*"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ thread_id: 1 }, { thread_id: 2 }]), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH, { agentsSecondaryOrigin: '*' }))
    await app.request('/api/threads')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url] = fetchMock.mock.calls[0]
    expect(url).not.toContain('origin_application')
  })

  it('propagates primary fetch error status when primary fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const app = makeApp(depsWith(async () => OAUTH, { agentsSecondaryOrigin: 'snowflake_cowork' }))
    const res = await app.request('/api/threads')

    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('upstream_error')
  })

  it('degrades a non-JSON 200 on the dual-origin primary to an empty list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<html>ingress</html>', { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const app = makeApp(depsWith(async () => OAUTH, { agentsSecondaryOrigin: 'snowflake_cowork' }))
    const res = await app.request('/api/threads')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ threads: [] })
  })
})

describe('GET /api/threads/search', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const app = makeApp(depsWith(async () => ({ error: 'Unauthorized', status: 401 })))
    const res = await app.request('/api/threads/search?q=test')
    expect(res.status).toBe(401)
  })

  it.each([[401, 401], [403, 403], [500, 502], [503, 502], [429, 502]])(
    'maps upstream %i to %i instead of an empty history',
    async (upstream, expected) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom SECRET_OBJ', { status: upstream })))
      const app = makeApp(depsWith(async () => OAUTH))
      const res = await app.request('/api/threads/search?q=sales')
      expect(res.status).toBe(expected)
      const text = await res.text()
      expect(text).not.toContain('SECRET_OBJ')
      expect(text).toContain('error')
    },
  )

  it('treats an upstream 404 as an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/threads/search?q=sales')
    expect(res.status).toBe(200)
    expect((await res.json()).threads).toEqual([])
  })

  it('returns empty array for blank query without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/threads/search?q=')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.threads).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('filters threads by title substring', async () => {
    const threads = [
      { thread_id: 1, thread_name: 'Sales forecast Q1', updated_at: '2024-01-01T00:00:00Z' },
      { thread_id: 2, thread_name: 'Operations review', updated_at: '2024-01-02T00:00:00Z' },
      { thread_id: 3, thread_name: '', updated_at: '2024-01-03T00:00:00Z' },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ threads }), { status: 200 }),
    ))
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/threads/search?q=sales')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.threads).toHaveLength(1)
    expect(body.threads[0].thread_id).toBe(1)
  })

  it('drops threads with empty names', async () => {
    const threads = [
      { thread_id: 1, thread_name: 'Good thread', updated_at: '2024-01-01T00:00:00Z' },
      { thread_id: 2, thread_name: '', updated_at: '2024-01-02T00:00:00Z' },
      { thread_id: 3, updated_at: '2024-01-03T00:00:00Z' },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ threads }), { status: 200 }),
    ))
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/threads/search?q=good')
    const body = await res.json()
    expect(body.threads).toHaveLength(1)
    expect(body.threads[0].thread_id).toBe(1)
  })

  it('normalizes, sorts, and tags merged dual-origin results', async () => {
    const primaryThreads = [{
      thread_id: 1,
      thread_name: 'Primary query',
      updated_on: Date.parse('2024-01-01T00:00:00Z'),
    }]
    const secondaryThreads = [{
      thread_id: 2,
      thread_name: 'CoWork query',
      updated_on: Date.parse('2024-01-02T00:00:00Z'),
    }]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ threads: primaryThreads }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ threads: secondaryThreads }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH, { agentsSecondaryOrigin: 'snowflake_cowork' }))
    const res = await app.request('/api/threads/search?q=query')
    const body = await res.json()
    expect(body.threads).toHaveLength(2)
    expect(body.threads.map((t: { thread_id: number }) => t.thread_id)).toEqual([2, 1])
    expect(body.threads[0].updated_at).toBe('2024-01-02T00:00:00.000Z')
    expect(body.threads[1].updated_at).toBe('2024-01-01T00:00:00.000Z')
    const coworkThread = body.threads.find((t: { thread_id: number; source?: string }) => t.thread_id === 2)
    expect(coworkThread?.source).toBe('cowork')
  })

  it('normalizes numeric-string created_on/updated_on epochs into ISO', async () => {
    const createdOn = Date.parse('2024-01-01T00:00:00Z')
    const updatedOn = Date.parse('2024-01-02T00:00:00Z')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        threads: [{
          thread_id: 1,
          thread_name: 'String epochs',
          created_on: String(createdOn),
          updated_on: String(updatedOn),
        }],
      }), { status: 200 }),
    ))
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/threads/search?q=string')
    const body = await res.json()
    expect(body.threads).toHaveLength(1)
    expect(body.threads[0].created_at).toBe('2024-01-01T00:00:00.000Z')
    expect(body.threads[0].updated_at).toBe('2024-01-02T00:00:00.000Z')
  })
})

describe('POST /api/threads (create)', () => {
  it('injects the host originApp into the Cortex create request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ thread_id: 99 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH, {}, 'agents_sfdc'))
    await app.request('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_name: 'My Thread' }),
    })
    const [, opts] = fetchMock.mock.calls[0]
    const sent = JSON.parse((opts as RequestInit).body as string)
    expect(sent.origin_application).toBe('agents_sfdc')
    expect(sent.thread_name).toBe('My Thread')
  })

  it('forwards only thread_name from the client body and drops extra keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ thread_id: 1 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp(depsWith(async () => OAUTH, {}, 'agents_sfdc'))
    await app.request('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thread_name: 'Keep',
        statement: 'DROP TABLE t',
        origin_application: 'spoofed',
        __proto__: { polluted: true },
        extra: 1,
      }),
    })
    const [, opts] = fetchMock.mock.calls[0]
    const sent = JSON.parse((opts as RequestInit).body as string)
    expect(sent).toEqual({ thread_name: 'Keep', origin_application: 'agents_sfdc' })
    expect(sent.statement).toBeUndefined()
    expect(sent.extra).toBeUndefined()
  })

  it('normalizes epoch created_on/updated_on into ISO created_at/updated_at on the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ thread_id: 99, created_on: 1700000000000 }), { status: 200 }),
    ))
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = await res.json()
    expect(body.created_at).toBe(new Date(1700000000000).toISOString())
  })

  it('redacts an upstream error body instead of forwarding it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad request: role SYSADMIN', { status: 400 })))
    const app = makeApp(depsWith(async () => OAUTH))
    const res = await app.request('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('upstream_error')
    expect(JSON.stringify(body)).not.toContain('SYSADMIN')
  })
})
