// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getBotUserState, setBotUserState, clearBotUserState } from './bot-state.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const TABLE = 'DB.SCH.COWORK_BOT_STATE'

describe('getBotUserState', () => {
  it('parses a found row into agentFqn/threadId/parentMessageId/conversationReference', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [['DB.SCH.AGENT', '42', '100', '{"user":{"id":"user1"}}']] }), { status: 200 },
    )))
    const result = await getBotUserState('acct', 'tok', 'OAUTH', TABLE, 'user1')
    expect(result).toEqual({
      ok: true,
      state: {
        agentFqn: 'DB.SCH.AGENT', threadId: 42, parentMessageId: 100, conversationReference: '{"user":{"id":"user1"}}',
      },
    })
  })

  it('returns ok with a null state when no row is found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })))
    expect(await getBotUserState('acct', 'tok', 'OAUTH', TABLE, 'user1')).toEqual({ ok: true, state: null })
  })

  it('returns ok:false on a non-OK response or a network error, without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    expect(await getBotUserState('acct', 'tok', 'OAUTH', TABLE, 'user1')).toEqual({ ok: false })

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(await getBotUserState('acct', 'tok', 'OAUTH', TABLE, 'user1')).toEqual({ ok: false })
  })

  it('binds the user id rather than interpolating it into the statement', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await getBotUserState('acct', 'tok', 'OAUTH', TABLE, "user'; DROP TABLE x")
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.statement).not.toContain('DROP TABLE')
    expect(body.bindings['1']).toEqual({ type: 'TEXT', value: "user'; DROP TABLE x" })
    expect(body.timeout).toBe(30)
  })

  it('marks a timed-out hydration distinctly from a generic failure', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(
      (_url: string | URL, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ))
    const pending = getBotUserState('acct', 'tok', 'OAUTH', TABLE, 'user1')
    const expectation = expect(pending).resolves.toEqual({ ok: false, timeout: true })
    await vi.advanceTimersByTimeAsync(40_000)
    await expectation
    vi.useRealTimers()
  })
})

describe('setBotUserState', () => {
  it('MERGEs with bound values for user id, agent, thread, parent message id, and conversation reference', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await setBotUserState('acct', 'tok', 'OAUTH', TABLE, 'user1', {
      agentFqn: 'DB.SCH.A', threadId: 9, parentMessageId: 100, conversationReference: '{"user":{"id":"user1"}}',
    })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://acct.snowflakecomputing.com/api/v2/statements')
    const body = JSON.parse(opts.body)
    expect(body.statement).toContain('MERGE INTO DB.SCH.COWORK_BOT_STATE')
    expect(body.bindings).toEqual({
      '1': { type: 'TEXT', value: 'user1' },
      '2': { type: 'TEXT', value: 'DB.SCH.A' },
      '3': { type: 'TEXT', value: '9' },
      '4': { type: 'TEXT', value: '100' },
      '5': { type: 'TEXT', value: '{"user":{"id":"user1"}}' },
    })
  })

  it('writes empty strings for an absent thread/parent message id/conversation reference rather than throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await setBotUserState('acct', 'tok', 'OAUTH', TABLE, 'user1', { agentFqn: 'DB.SCH.A' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.bindings['3']).toEqual({ type: 'TEXT', value: '' })
    expect(body.bindings['4']).toEqual({ type: 'TEXT', value: '' })
    expect(body.bindings['5']).toEqual({ type: 'TEXT', value: '' })
  })

  it('swallows a failure rather than throwing (best-effort), returning false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(setBotUserState('acct', 'tok', 'OAUTH', TABLE, 'user1', {})).resolves.toBe(false)
  })

  it('returns true on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    await expect(setBotUserState('acct', 'tok', 'OAUTH', TABLE, 'user1', { agentFqn: 'DB.SCH.A' })).resolves.toBe(true)
  })
})

describe('clearBotUserState', () => {
  it('DELETEs the row for the bound user id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await clearBotUserState('acct', 'tok', 'OAUTH', TABLE, 'user1')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.statement).toBe('DELETE FROM DB.SCH.COWORK_BOT_STATE WHERE user_id = :1')
    expect(body.bindings).toEqual({ '1': { type: 'TEXT', value: 'user1' } })
  })

  it('swallows a failure rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(clearBotUserState('acct', 'tok', 'OAUTH', TABLE, 'user1')).resolves.toBeUndefined()
  })
})
