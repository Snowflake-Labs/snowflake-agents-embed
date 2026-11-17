// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { streamCortexAgent } from './cortex.js'

afterEach(() => { vi.restoreAllMocks() })

function sseBody(frames: string[]): string {
  return frames.join('')
}
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

describe('streamCortexAgent', () => {
  it('yields parsed AgentEvents as they arrive, via the shared chat-core SSE parser', async () => {
    const body = sseBody([
      frame('response.text.delta', { text: 'Hello' }),
      frame('response.text.delta', { text: ' world' }),
      frame('done', {}),
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))

    const events = []
    for await (const e of streamCortexAgent({
      agent: { database: 'DB', schema: 'SCH', name: 'AGENT' },
      query: 'hi', snowflakeToken: 'tok', snowflakeAccount: 'acct',
    })) {
      events.push(e)
    }
    expect(events).toEqual([
      { kind: 'text.delta', text: 'Hello', contentIndex: 0 },
      { kind: 'text.delta', text: ' world', contentIndex: 0 },
      { kind: 'done' },
    ])
  })

  it('sends thread_id/parent_message_id only when a thread is already open', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    const drain = async (threadId?: number, parentMessageId?: number) => {
      const gen = streamCortexAgent({
        agent: { database: 'DB', schema: 'SCH', name: 'AGENT' },
        query: 'hi', snowflakeToken: 'tok', snowflakeAccount: 'acct', threadId, parentMessageId,
      })
      for await (const _e of gen) { /* drain */ }
    }

    await drain()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('thread_id')

    await drain(9, 100)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ thread_id: 9, parent_message_id: 100 })

    // A freshly created thread has no parent yet; Cortex requires parent_message_id: 0 then.
    await drain(9)
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ thread_id: 9, parent_message_id: 0 })
  })

  it('throws on a non-OK response without yielding anything', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    const gen = streamCortexAgent({
      agent: { database: 'DB', schema: 'SCH', name: 'AGENT' },
      query: 'hi', snowflakeToken: 'tok', snowflakeAccount: 'acct',
    })
    await expect(gen.next()).rejects.toThrow('Cortex Agents API error: 500')
  })

  it('uses the given tokenType and Bearer token in the request headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const gen = streamCortexAgent({
      agent: { database: 'DB', schema: 'SCH', name: 'AGENT' },
      query: 'hi', snowflakeToken: 'tok', snowflakeAccount: 'acct', tokenType: 'PROGRAMMATIC_ACCESS_TOKEN',
    })
    for await (const _e of gen) { /* drain */ }
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer tok',
      'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
    })
  })
})
