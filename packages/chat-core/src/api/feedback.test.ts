// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { submitFeedback } from './feedback'
import { setHostAdapter, resetHostAdapter, type HostAdapter } from '../host/hostAdapter'

const fakeAdapter: HostAdapter = {
  baseUrl: () => '',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
}

beforeEach(() => { setHostAdapter(fakeAdapter) })
afterEach(() => { vi.restoreAllMocks(); resetHostAdapter() })

describe('submitFeedback', () => {
  it('POSTs to /api/feedback with the auth header and full body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await submitFeedback('tok', {
      agentFqn: 'DB.SCH.AG', positive: true, feedbackMessage: 'great', categories: ['Accurate'], threadId: 5,
    })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/feedback')
    expect((opts as RequestInit).method).toBe('POST')
    expect((opts as RequestInit).headers).toMatchObject({ 'X-User-Access-Token': 'tok' })
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      agentFqn: 'DB.SCH.AG', positive: true, feedbackMessage: 'great', categories: ['Accurate'], threadId: 5,
    })
  })

  it('swallows a failed request rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(submitFeedback('tok', { agentFqn: 'DB.SCH.AG', positive: false })).resolves.toBeUndefined()
  })

  it('swallows a non-ok response rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await expect(submitFeedback('tok', { agentFqn: 'DB.SCH.AG', positive: false })).resolves.toBeUndefined()
  })
})
