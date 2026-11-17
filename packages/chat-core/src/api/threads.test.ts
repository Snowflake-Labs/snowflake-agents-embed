// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createThread, searchThreads, listThreads } from './threads'
import { setHostAdapter, resetHostAdapter, type HostAdapter } from '../host/hostAdapter'

const fakeAdapter: HostAdapter = {
  baseUrl: () => '',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
}

beforeEach(() => { setHostAdapter(fakeAdapter) })
afterEach(() => { vi.restoreAllMocks(); resetHostAdapter() })

describe('createThread', () => {
  it('POSTs to /api/threads with the auth header and returns the thread summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ thread_id: 123, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const created = await createThread('tok')
    expect(created.thread_id).toBe(123)
    expect(created.created_at).toBe('2026-01-01T00:00:00.000Z')
    expect(created.updated_at).toBe('2026-01-01T00:00:00.000Z')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/threads')
    expect((opts as RequestInit).method).toBe('POST')
    expect((opts as RequestInit).headers).toMatchObject({
      'X-User-Access-Token': 'tok',
    })
  })

  it('tolerates an { id } alias', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 7 }), { status: 200 }),
    ))
    expect((await createThread('tok')).thread_id).toBe(7)
  })

  // Relay/server normalize created_on/updated_on -> created_at/updated_at server-side (see
  // normalizeThread in both threads.ts route files) - but relay and the SPA deploy
  // independently, so an un-upgraded relay can still return the raw Cortex shape. Without
  // this fallback, a thread created during that window would sit in dateGroups' "Undated"
  // bucket even after the fix ships.
  it('falls back to created_on/updated_on (epoch ms) when the relay has not normalized yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ thread_id: 9, created_on: 1788253663157, updated_on: 1788253663157 }), { status: 200 }),
    ))
    const created = await createThread('tok')
    expect(created.thread_id).toBe(9)
    expect(created.created_at).toBe(new Date(1788253663157).toISOString())
    expect(created.updated_at).toBe(new Date(1788253663157).toISOString())
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await expect(createThread('tok')).rejects.toThrow(/Failed to create thread: 500/)
  })
})

describe('listThreads', () => {
  it('sends page_size and after and returns the cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ threads: [{ thread_id: 1 }], after: 'n2' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await listThreads('tok', { pageSize: 20, after: 'n1' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('page_size=20')
    expect(String(fetchMock.mock.calls[0][0])).toContain('after=n1')
    expect(result).toEqual({ threads: [{ thread_id: 1 }], after: 'n2' })
  })

  it('maps Cortex created_on/updated_on epochs (number or numeric string) to ISO', async () => {
    const createdOn = 1788253663157
    const updatedOn = 1788253669999
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        threads: [
          { thread_id: 1, created_on: createdOn, updated_on: String(updatedOn) },
          { thread_id: 2, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' },
        ],
      }), { status: 200 }),
    ))
    const result = await listThreads('tok')
    expect(result.threads[0]).toEqual({
      thread_id: 1,
      created_at: new Date(createdOn).toISOString(),
      updated_at: new Date(updatedOn).toISOString(),
    })
    expect(result.threads[1]).toEqual({
      thread_id: 2,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    })
  })
})

describe('searchThreads', () => {
  it('returns empty array immediately for blank query without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await searchThreads('tok', '')
    expect(result).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('encodes the query and hits /api/threads/search', async () => {
    const threads = [{ thread_id: 1, thread_name: 'Sales' }]
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ threads }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await searchThreads('tok', 'sales Q1')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/threads/search')
    expect(decodeURIComponent(String(url))).toContain('q=sales Q1')
    expect(result).toHaveLength(1)
    expect(result[0].thread_id).toBe(1)
  })

  it('maps epoch created_on/updated_on to ISO and keeps source and existing ISO', async () => {
    const createdOn = 1788253663157
    const updatedOn = 1788253669999
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        threads: [
          {
            thread_id: 1,
            thread_name: 'Sales',
            created_on: createdOn,
            updated_on: String(updatedOn),
            source: 'cowork',
          },
          {
            thread_id: 2,
            thread_name: 'Already ISO',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-02T00:00:00.000Z',
          },
        ],
      }), { status: 200 }),
    ))
    const result = await searchThreads('tok', 'sales')
    expect(result).toEqual([
      {
        thread_id: 1,
        thread_name: 'Sales',
        created_at: new Date(createdOn).toISOString(),
        updated_at: new Date(updatedOn).toISOString(),
        source: 'cowork',
      },
      {
        thread_id: 2,
        thread_name: 'Already ISO',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ])
  })

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 500 })))
    await expect(searchThreads('tok', 'test')).rejects.toThrow(/500/)
  })
})
