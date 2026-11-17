// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout, fetchWithTimeoutStreaming, UpstreamTimeoutError } from './fetch-timeout.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A fetch that never settles on its own - it only ever rejects via the abort signal. */
function hangingFetch() {
  return vi.fn(
    (_url: string | URL, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  )
}

describe('fetchWithTimeout', () => {
  it('resolves with the upstream response when it arrives in time', async () => {
    const stub = vi.fn(async () => new Response('body', { status: 201 }))
    vi.stubGlobal('fetch', stub)

    const res = await fetchWithTimeout('https://example.test/x')

    expect(res.status).toBe(201)
    expect(await res.text()).toBe('body')
  })

  it('aborts the upstream call once the timeout elapses', async () => {
    vi.stubGlobal('fetch', hangingFetch())

    await expect(fetchWithTimeout('https://example.test/x', {}, 5))
      .rejects.toBeInstanceOf(UpstreamTimeoutError)
  })

  it('rethrows a caller-supplied abort instead of an UpstreamTimeoutError', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const caller = new AbortController()
    const pending = fetchWithTimeout('https://example.test/x', { signal: caller.signal }, 60_000)
    caller.abort()
    await expect(pending).rejects.not.toBeInstanceOf(UpstreamTimeoutError)
  })

  it('passes an abort signal through to fetch without dropping caller init', async () => {
    const stub = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => new Response('ok'))
    vi.stubGlobal('fetch', stub)

    await fetchWithTimeout('https://example.test/x', {
      method: 'POST',
      headers: { 'X-Test': '1' },
      body: '{}',
    })

    const [url, init = {}] = stub.mock.calls[0]
    expect(url).toBe('https://example.test/x')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'X-Test': '1' })
    expect(init.body).toBe('{}')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not abort after a successful response, so the caller can read the body', async () => {
    let captured: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init: RequestInit = {}) => {
        captured = init.signal ?? undefined
        return new Response('ok')
      }),
    )

    // A timeout shorter than this assertion's own delay would fire mid-read if the
    // timer were not cleared in the finally block.
    const res = await fetchWithTimeout('https://example.test/x', {}, 10)
    await new Promise((r) => setTimeout(r, 30))

    expect(captured?.aborted).toBe(false)
    expect(await res.text()).toBe('ok')
  })
})

describe('fetchWithTimeoutStreaming', () => {
  it('keeps the abort controller armed after headers arrive until dispose', async () => {
    let captured: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init: RequestInit = {}) => {
        captured = init.signal ?? undefined
        return new Response('chunk')
      }),
    )
    const { response, dispose } = await fetchWithTimeoutStreaming('https://example.test/x', {}, {
      firstByteMs: 50,
      totalMs: 20,
    })
    expect(await response.text()).toBe('chunk')
    await new Promise((r) => setTimeout(r, 40))
    expect(captured?.aborted).toBe(true)
    dispose()
  })

  it('aborts at the first-byte bound and throws UpstreamTimeoutError', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    await expect(fetchWithTimeoutStreaming('https://example.test/x', {}, { firstByteMs: 5, totalMs: 60_000 }))
      .rejects.toBeInstanceOf(UpstreamTimeoutError)
  })
})
