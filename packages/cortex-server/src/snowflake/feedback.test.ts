// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { submitFeedback } from './feedback.js'
import type { SnowflakeCredential } from './credential.js'

const OAUTH: SnowflakeCredential = { token: 'tok', tokenType: 'OAUTH' }
const PAT: SnowflakeCredential = { token: 'tok', tokenType: 'PROGRAMMATIC_ACCESS_TOKEN' }

afterEach(() => { vi.restoreAllMocks() })

describe('submitFeedback', () => {
  it('POSTs to the native Cortex Feedback endpoint with credential-derived headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await submitFeedback('acct', OAUTH, 'DB.SCH.AG', { positive: true, threadId: 42 })

    expect(result).toEqual({ ok: true, status: 200 })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://acct.snowflakecomputing.com/api/v2/databases/DB/schemas/SCH/agents/AG:feedback')
    expect(opts.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
    })
    expect(JSON.parse(opts.body)).toEqual({ positive: true, thread_id: 42 })
  })

  // The reason this module takes a credential rather than a host auth-mode enum: the
  // Salesforce relay's phase-1 token is a PAT, the Teams server forwards OAUTH.
  it('sends the PAT token type when given a PAT credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await submitFeedback('acct', PAT, 'DB.SCH.AG', { positive: true })

    expect(fetchMock.mock.calls[0][1].headers['X-Snowflake-Authorization-Token-Type'])
      .toBe('PROGRAMMATIC_ACCESS_TOKEN')
  })

  it('includes feedback_message and categories only when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await submitFeedback('acct', OAUTH, 'DB.SCH.AG', {
      positive: false,
      feedbackMessage: 'wrong numbers',
      categories: ['Incorrect answer'],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ positive: false, feedback_message: 'wrong numbers', categories: ['Incorrect answer'] })
  })

  it('returns ok:false on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })))
    expect(await submitFeedback('acct', OAUTH, 'DB.SCH.AG', { positive: true })).toEqual({ ok: false, status: 403 })
  })

  it('returns ok:false when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(await submitFeedback('acct', OAUTH, 'DB.SCH.AG', { positive: true })).toEqual({ ok: false })
  })

  it('propagates parseAgentRef errors on a malformed FQN', async () => {
    await expect(submitFeedback('acct', OAUTH, 'not-a-fqn', { positive: true })).rejects.toThrow()
  })
})
