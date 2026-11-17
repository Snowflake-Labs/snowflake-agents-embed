// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { fetchFullTableResult } from './statements'
import { setHostAdapter, resetHostAdapter, type HostAdapter } from '../host/hostAdapter'

const fakeAdapter: HostAdapter = {
  baseUrl: () => '',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
}

beforeEach(() => { setHostAdapter(fakeAdapter) })
afterEach(() => { vi.restoreAllMocks(); resetHostAdapter() })

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('fetchFullTableResult', () => {
  it('returns the single partition as-is when there is only one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [['Central', 100]], resultSetMetaData: { partitionInfo: [{ rowCount: 1 }] } }))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchFullTableResult('tok', 'handle-1')

    expect(rows).toEqual([['Central', 100]])
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('/api/statements/handle-1')
    expect(opts.headers).toMatchObject({ 'X-User-Access-Token': 'tok' })
  })

  it('fetches and concatenates every partition beyond the first', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [['Central', 100]], resultSetMetaData: { partitionInfo: [{}, {}, {}] } }))
      .mockResolvedValueOnce(jsonResponse({ data: [['East', 200]] }))
      .mockResolvedValueOnce(jsonResponse({ data: [['West', 300]] }))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchFullTableResult('tok', 'handle-1')

    expect(rows).toEqual([['Central', 100], ['East', 200], ['West', 300]])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/statements/handle-1?partition=1')
    expect(String(fetchMock.mock.calls[2][0])).toBe('/api/statements/handle-1?partition=2')
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await expect(fetchFullTableResult('tok', 'handle-1')).rejects.toThrow('HTTP 500')
  })
})
