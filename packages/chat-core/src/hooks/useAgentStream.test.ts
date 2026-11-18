// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAgentStream } from './useAgentStream'
import { useChatStore } from '../store/chatStore'
import * as api from '../api/agentRun.js'
import * as agentsApi from '../api/agents.js'
import { setHostAdapter } from '../host/hostAdapter.js'
import { ApiError } from '../api/apiError.js'

afterEach(() => { vi.restoreAllMocks() })

describe('useAgentStream parent_message_id chaining', () => {
  it('chains lastAssistantMessageId from the assistant metadata id, ignoring the user one', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'metadata', messageId: 111, role: 'user' }      // must be ignored
      yield { kind: 'text.delta', text: 'hi' }
      yield { kind: 'metadata', messageId: 222, role: 'assistant' } // this one chains
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG', threadId: 999 })
    })

    const t = useChatStore.getState().openThreads[tempId]
    expect(t.thread.threadId).toBe(999)
    expect(t.thread.lastAssistantMessageId).toBe(222)
  })

  it('leaves lastAssistantMessageId undefined when only a user metadata event arrives', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'metadata', messageId: 111, role: 'user' }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG', threadId: 999 })
    })

    const t = useChatStore.getState().openThreads[tempId]
    expect(t.thread.lastAssistantMessageId).toBeUndefined()
  })
})

describe('useAgentStream new event kinds (Phase 2)', () => {
  it('patches the matching step with tool_result.status narration', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'tool_use', id: 'step1', toolType: 'system_execute_sql' }
      yield { kind: 'tool_result.status', id: 'step1', message: 'Running Sales_Analyst' }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.steps[0].statusMessage).toBe('Running Sales_Analyst')
  })

  it('sets suggestions immediately from a standalone suggested_queries event', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'suggested_queries', suggestions: ['Tell me more'] }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.suggestions).toEqual(['Tell me more'])
  })

  it('sets pendingQuestion instead of a running step for an ask_user_question tool_use', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield {
        kind: 'tool_use',
        id: 'ask1',
        toolType: 'ask_user_question',
        input: { question: 'Which region?', options: ['Central', 'North'] },
      }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.pendingQuestion).toEqual({
      toolUseId: 'ask1', toolType: 'ask_user_question', prompt: 'Which region?', options: ['Central', 'North'],
    })
    expect(turn.steps).toEqual([])
  })

  it('attaches response.warning events to the turn instead of discarding them', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'warning', code: '003001', message: 'User authentication required for MCP server.' }
      yield { kind: 'text', text: 'answer' }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.warnings).toEqual([{ code: '003001', message: 'User authentication required for MCP server.' }])
  })

  it('replaces (not appends) text on the consolidated non-delta event', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'partial ' }
      yield { kind: 'text', text: 'full answer' }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.text).toBe('full answer')
  })

  // Regression: one answer arrives as several text blocks keyed by content_index, interleaved
  // with the table/chart they describe (indices 12/14/16 in test/fixtures/agent-run-sse.txt).
  // Assigning each consolidated block to the whole turn let the last one wipe the body, so the
  // answer rendered — and copied — as just its closing sentence.
  it('keeps every text block of a multi-block answer, in content_index order', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'Here are the total ', contentIndex: 12 }
      yield { kind: 'text.delta', text: 'sales by region:\n\n', contentIndex: 12 }
      yield { kind: 'text', text: 'Here are the total sales by region:\n\n', contentIndex: 12 }
      yield { kind: 'table', rowType: [], data: [] }
      yield { kind: 'text', text: '\n\n', contentIndex: 14 }
      yield { kind: 'chart', spec: { mark: 'bar' } }
      yield { kind: 'text.delta', text: '\n\nThe Central region leads.', contentIndex: 16 }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    // The consolidated block for index 12 replaces its own deltas rather than doubling them.
    expect(turn.text).toBe('Here are the total sales by region:\n\n\n\n\n\nThe Central region leads.')
  })

  it('orders text blocks by content_index even if they arrive out of order', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'text', text: 'second', contentIndex: 16 }
      yield { kind: 'text', text: 'first ', contentIndex: 12 }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(useChatStore.getState().openThreads[tempId].turns.at(-1)!.text).toBe('first second')
  })

  // Regression: the first reasoning burst per turn can carry real narration, while bursts after
  // each subsequent tool round are reliably empty (signature-only). A scalar `thinking` field
  // overwritten by each new event would let the later empty burst wipe the earlier real one.
  it('keeps real thinking text from index 0 after a later empty thinking burst at a higher index', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'thinking.delta', text: 'This question looks ', contentIndex: 0 }
      yield { kind: 'thinking.delta', text: 'like a verified query.', contentIndex: 0 }
      yield { kind: 'thinking', text: 'This question looks like a verified query.', contentIndex: 0 }
      yield { kind: 'tool_use', id: 't1', toolType: 'system_execute_sql' }
      yield { kind: 'tool_result', id: 't1', status: 'success' }
      yield { kind: 'thinking', text: '', contentIndex: 3 }
      yield { kind: 'text', text: 'Here is the answer.' }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.thinking).toBe('This question looks like a verified query.')
  })

  it('leaves thinking unset when every thinking burst is empty', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'thinking', text: '', contentIndex: 0 }
      yield { kind: 'thinking', text: '', contentIndex: 3 }
      yield { kind: 'text', text: 'Here is the answer.' }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    // undefined, not '': the flush only writes `thinking` when there is something to show, so
    // ThinkingSteps sees "no reasoning" rather than "empty reasoning".
    expect(turn.thinking).toBeUndefined()
  })
})

describe('useAgentStream error translation (Phase 6)', () => {
  it('translates a thrown ApiError into a user-facing sentence, keeping the raw one out of view', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      const err: any = new Error('Agent run error: 429')
      err.status = 429
      throw err
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.status).toBe('error')
    expect(turn.errorMessage).toBe("You're sending messages too quickly. Please wait a moment and try again.")
  })

  it('translates an SSE error event, keeping the raw code/requestId for support', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'error', code: '399518', message: 'thread_id must be provided', requestId: 'aa8e6f4b' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.status).toBe('error')
    expect(turn.errorMessage).toBe('thread_id must be provided')
    expect(turn.errorCode).toBe('399518')
    expect(turn.requestId).toBe('aa8e6f4b')
  })
})

describe('useAgentStream automation steps', () => {
  it('attaches parsed automation info to a schedule_snowflake_task step', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'tool_use', id: 'step1', toolType: 'schedule_snowflake_task', input: { action: 'setup', schedule: '0 9 * * *', target: 'nightly_refresh' } }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const step = useChatStore.getState().openThreads[tempId].turns.at(-1)!.steps[0]
    expect(step.automation).toEqual({ action: 'setup', schedule: '0 9 * * *', target: 'nightly_refresh' })
  })

  it('leaves automation undefined for a non-automation tool_use', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'tool_use', id: 'step1', toolType: 'system_execute_sql', sql: 'SELECT 1' }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const step = useChatStore.getState().openThreads[tempId].turns.at(-1)!.steps[0]
    expect(step.automation).toBeUndefined()
  })
})

describe('useAgentStream telemetry (Phase 13)', () => {
  afterEach(() => {
    // Restore the default test adapter so later tests in this file aren't affected.
    setHostAdapter({ baseUrl: () => '', headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }) })
  })

  it('emits split first-token timings and tool names once the stream finishes', async () => {
    const telemetry = vi.fn()
    setHostAdapter({ baseUrl: () => '', headers: () => ({}), telemetry })
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'thinking.delta', text: 'looks like' }
      yield { kind: 'tool_use', id: 't1', toolType: 'system_execute_sql', sql: 'SELECT 1' }
      yield { kind: 'text.delta', text: 'Phones' }
      yield { kind: 'table', rowType: [], data: [], queryId: 'q1', numRows: 1 }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(telemetry).toHaveBeenCalledWith('tok', 'agent_run', expect.objectContaining({
      ttfbMs: expect.any(Number),
      ttftMs: expect.any(Number),
      firstThinkingMs: expect.any(Number),
      firstAnswerTokenMs: expect.any(Number),
      firstTableMs: expect.any(Number),
      toolNames: ['system_execute_sql'],
      aborted: false,
    }))
    const fields = telemetry.mock.calls[0][2]
    expect(fields.firstThinkingMs).toBeLessThanOrEqual(fields.firstAnswerTokenMs)
    expect(fields.firstAnswerTokenMs).toBeLessThanOrEqual(fields.firstTableMs)
  })

  it('emits ttft/duration/aborted/errorClass once the stream finishes', async () => {
    const telemetry = vi.fn()
    setHostAdapter({ baseUrl: () => '', headers: () => ({}), telemetry })
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'hi' }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(telemetry).toHaveBeenCalledWith('tok', 'agent_run', expect.objectContaining({
      ttfbMs: expect.any(Number),
      ttftMs: expect.any(Number),
      firstAnswerTokenMs: expect.any(Number),
      durationMs: expect.any(Number),
      aborted: false,
      errorClass: undefined,
    }))
  })

  it('reports errorClass from a thrown, non-abort error', async () => {
    const telemetry = vi.fn()
    setHostAdapter({ baseUrl: () => '', headers: () => ({}), telemetry })
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      const err: any = new Error('boom')
      err.code = 'rate_limited'
      throw err
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(telemetry).toHaveBeenCalledWith('tok', 'agent_run', expect.objectContaining({ aborted: false, errorClass: 'rate_limited' }))
  })

  it('reports aborted:true without an errorClass on an AbortError', async () => {
    const telemetry = vi.fn()
    setHostAdapter({ baseUrl: () => '', headers: () => ({}), telemetry })
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      throw new DOMException('Aborted', 'AbortError')
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(telemetry).toHaveBeenCalledWith('tok', 'agent_run', expect.objectContaining({ aborted: true, errorClass: undefined }))
    expect(useChatStore.getState().openThreads[tempId].turns.at(-1)!).toMatchObject({
      status: 'done', interrupted: true,
    })
  })

  it('reports stream_eof_no_terminal and unknownEvents when the stream ends without a terminal event', async () => {
    const telemetry = vi.fn()
    setHostAdapter({ baseUrl: () => '', headers: () => ({}), telemetry })
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'partial' }
      yield { kind: 'unknown', event: 'response.future' }
      yield { kind: 'parse_failure', event: 'response.text' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(telemetry).toHaveBeenCalledWith('tok', 'agent_run', expect.objectContaining({
      errorClass: 'stream_eof_no_terminal',
      unknownEvents: ['response.future'],
      parseFailures: 1,
    }))
  })

  it('keeps a completed answer as done when the connection drops before the terminal event', async () => {
    const telemetry = vi.fn()
    setHostAdapter({ baseUrl: () => '', headers: () => ({}), telemetry })
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')
    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'text', text: 'full answer' }
      throw new TypeError('network error')
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.status).toBe('done')
    expect(turn.errorMessage).toBeUndefined()
    expect(telemetry).toHaveBeenCalledWith('tok', 'agent_run', expect.objectContaining({ errorClass: 'stream_cut_after_answer' }))
  })

  it('still errors on a network failure before any final answer text', async () => {
    setHostAdapter({ baseUrl: () => '', headers: () => ({}) })
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')
    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'part' }
      throw new TypeError('network error')
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(useChatStore.getState().openThreads[tempId].turns.at(-1)!.status).toBe('error')
  })

  it('never throws when the host adapter has no telemetry method', async () => {
    setHostAdapter({ baseUrl: () => '', headers: () => ({}) })
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')
    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await expect(act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })).resolves.toBeUndefined()
  })
})

// Cortex sends character-level text deltas (~10 chars, hundreds per answer). Applying each one
// individually meant a store write + a full markdown re-parse per event; these pin the
// per-frame coalescing that replaced that, including the ordering guarantee it must not break.
describe('useAgentStream delta coalescing', () => {
  it('applies a burst of text deltas in a single store update', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      for (const ch of 'Hello there, world') yield { kind: 'text.delta', text: ch }
      yield { kind: 'final' }
    } as any)

    const updateSpy = vi.spyOn(useChatStore.getState(), 'updateTurn')
    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.text).toBe('Hello there, world')
    // 18 deltas, but far fewer writes - the exact count depends on frame timing, so assert the
    // property that matters rather than a brittle number. The lower bound keeps this from
    // passing vacuously if the spy ever stops intercepting.
    expect(updateSpy.mock.calls.length).toBeGreaterThan(0)
    expect(updateSpy.mock.calls.length).toBeLessThan(18)
  })

  it('caps scheduled flushes at ~30/s rather than one per delta', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')
    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      for (let i = 0; i < 15; i++) {
        yield { kind: 'text.delta', text: 'x' }
        await new Promise((r) => setTimeout(r, 5))
      }
      yield { kind: 'final' }
    } as any)

    const texts: string[] = []
    const unsub = useChatStore.subscribe((s) => {
      const t = s.openThreads[tempId]?.turns.at(-1)
      if (t?.role === 'assistant' && t.text) texts.push(t.text)
    })

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })
    unsub()

    const uniqueFlushes = new Set(texts).size
    // 15 deltas over ~75 ms. A 33 ms gate allows a handful of scheduled flushes plus the
    // mandatory first-token and terminal flushes — not one write per delta.
    expect(uniqueFlushes).toBeGreaterThan(0)
    expect(uniqueFlushes).toBeLessThan(15)
    expect(useChatStore.getState().openThreads[tempId].turns.at(-1)!.text).toBe('x'.repeat(15))
  })

  it('keeps pending text ahead of the artifact that follows it', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    // A table arriving mid-burst must see the prose before it already applied, or the answer
    // renders with its artifacts in the wrong place.
    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'Sales by region:', contentIndex: 0 }
      yield { kind: 'table', rowType: [{ name: 'R', type: 'TEXT' }], data: [['Central']] }
      yield { kind: 'text.delta', text: 'Central leads.', contentIndex: 2 }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.text).toBe('Sales by region:Central leads.')
    expect(turn.artifacts).toHaveLength(1)
  })

  it('appends a map artifact from a response.map event', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')
    const spec = {
      version: 1 as const,
      layer: { type: 'latlon' as const, encoding: { latColumn: 'lat', lonColumn: 'lon' } },
      data: { values: [{ lat: 1, lon: 2 }] },
    }
    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'map', spec }
      yield { kind: 'final' }
    } as any)
    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })
    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.artifacts).toEqual([expect.objectContaining({ type: 'map', spec })])
  })

  it('flushes the last deltas even when no final event arrives', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'truncated answer' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.text).toBe('truncated answer')
    expect(turn.status).toBe('error')
    expect(turn.interrupted).toBe(true)
  })

  it('keeps status:error when an error event is followed by a final event', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'partial' }
      yield { kind: 'error', code: '399518', message: 'thread_id must be provided', requestId: 'aa8e6f4b' }
      yield { kind: 'final', suggestions: ['retry?'] }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('399518')
    expect(turn.requestId).toBe('aa8e6f4b')
    expect(turn.suggestions).toEqual(['retry?'])
  })

  it('marks an AbortError as interrupted rather than a clean done', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'partial' }
      throw new DOMException('Aborted', 'AbortError')
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.status).toBe('done')
    expect(turn.interrupted).toBe(true)
    expect(turn.text).toBe('partial')
  })

  it('does not abort an in-flight stream on another thread', async () => {
    const a = useChatStore.getState().newThread('DB.SCH.AG')
    const b = useChatStore.getState().newThread('DB.SCH.AG')
    let aAborted = false

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* (opts: any) {
      yield { kind: 'text.delta', text: opts.query }
      if (opts.query === 'first') {
        try {
          await new Promise<void>((_resolve, reject) => {
            if (opts.signal?.aborted) {
              reject(new DOMException('Aborted', 'AbortError'))
              return
            }
            opts.signal?.addEventListener('abort', () => {
              aAborted = true
              reject(new DOMException('Aborted', 'AbortError'))
            })
          })
        } catch (err) {
          throw err
        }
      }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    let first!: Promise<void>
    await act(async () => {
      first = result.current.stream({ tempId: a, query: 'first', agentFqn: 'DB.SCH.AG' })
    })
    await act(async () => {
      await result.current.stream({ tempId: b, query: 'second', agentFqn: 'DB.SCH.AG' })
    })

    expect(aAborted).toBe(false)
    expect(useChatStore.getState().openThreads[a].isStreaming).toBe(true)
    expect(useChatStore.getState().openThreads[b].turns.at(-1)!).toMatchObject({ status: 'done', text: 'second' })

    await act(async () => {
      result.current.stop(a)
      await first.catch(() => {})
    })
    expect(aAborted).toBe(true)
    expect(useChatStore.getState().openThreads[a].turns.at(-1)!.interrupted).toBe(true)
  })

  it('prefers tool_result.sql over the tool_use placeholder', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'tool_use', id: 's1', toolType: 'system_execute_sql', sql: 'SELECT * FROM __orders' }
      yield { kind: 'tool_result', id: 's1', status: 'success', sql: 'WITH __orders AS (SELECT 1) SELECT * FROM __orders' }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(useChatStore.getState().openThreads[tempId].turns.at(-1)!.steps[0].sql)
      .toBe('WITH __orders AS (SELECT 1) SELECT * FROM __orders')
  })
})

describe('useAgentStream status narration', () => {
  it('maps a response.status event onto statusLabel while the turn is still working', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'status', label: 'planning', code: 'planning' }
      yield { kind: 'thinking.delta', text: 'hmm' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    // No 'final' arrived and no answer content, so the narration is still on the turn.
    expect(useChatStore.getState().openThreads[tempId].turns.at(-1)!.statusLabel)
      .toBe('Planning the next steps')
  })

  it('stops narrating once answer content starts, and clears what was already there', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'status', label: 'planning', code: 'planning' }
      yield { kind: 'text.delta', text: 'answer' }
      // Cortex sends this *after* the answer is fully written - showing it would describe work
      // that has already happened.
      yield { kind: 'status', label: 'Forming the answer', code: 'proceeding_to_answer' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.text).toBe('answer')
    expect(turn.statusLabel).toBeUndefined()
  })

  it('drops the status codes the tool steps already narrate, and sandbox_ready', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      for (const code of ['extracting_tool_calls', 'executing_tools', 'executing_tool', 'client_tool_use_request', 'sandbox_ready']) {
        yield { kind: 'status', label: `prose for ${code}`, code }
      }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(useChatStore.getState().openThreads[tempId].turns.at(-1)!.statusLabel).toBeUndefined()
  })

  it('keeps sandbox_provisioning, which explains a real multi-second wait', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'status', label: 'Provisioning sandbox', code: 'sandbox_provisioning' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(useChatStore.getState().openThreads[tempId].turns.at(-1)!.statusLabel)
      .toBe('Provisioning sandbox')
  })

  it('does not re-render for a status repeated verbatim', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'status', label: 'planning', code: 'planning' }
      yield { kind: 'status', label: 'planning', code: 'planning' }
      yield { kind: 'status', label: 'planning', code: 'planning' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    // Count how many times the streaming turn's object identity changes: one write per applied
    // status, so a deduped repeat costs nothing.
    const seen = new Set<unknown>()
    const unsub = useChatStore.subscribe((s) => {
      const t = s.openThreads[tempId]?.turns.at(-1)
      if (t?.role === 'assistant') seen.add(t)
    })
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })
    unsub()

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.statusLabel).toBe('Planning the next steps')
    // The appended turn, one status update, and the EOF-without-terminal downgrade.
    // The three identical status events still collapse to a single write.
    expect(seen.size).toBe(3)
    expect(turn.status).toBe('error')
    expect(turn.interrupted).toBe(true)
  })

  it('clears statusLabel on final', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'status', label: 'planning' }
      yield { kind: 'final' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.statusLabel).toBeUndefined()
    expect(turn.status).toBe('done')
  })

  it('clears statusLabel on error', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'status', label: 'executing_tool' }
      yield { kind: 'error', code: '399504', message: 'boom' }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.statusLabel).toBeUndefined()
    expect(turn.status).toBe('error')
  })
})

describe('useAgentStream web search toggle', () => {
  afterEach(() => { useChatStore.setState({ webSearch: true }); agentsApi.clearAgentDetailsCache() })

  function mockStream() {
    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      yield { kind: 'final' }
    } as any)
  }

  it('sends no tool_choice when the toggle is on', async () => {
    useChatStore.setState({ webSearch: true })
    mockStream()
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(api.streamAgentRun).toHaveBeenCalledWith(expect.objectContaining({ toolChoice: undefined }))
  })

  it('restricts tool_choice to every other tool when off and the agent has web_search', async () => {
    useChatStore.setState({ webSearch: false })
    mockStream()
    vi.spyOn(agentsApi, 'fetchAgentDetailsCached').mockResolvedValue({
      sampleQuestions: [], dataSources: [], skills: [],
      tools: [
        { name: 'web_search', type: 'web_search' },
        { name: 'Sales_Analyst', type: 'cortex_analyst_text_to_sql' },
      ],
    })
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(api.streamAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      toolChoice: { type: 'tool', name: ['Sales_Analyst'] },
    }))
  })

  it('sends no tool_choice when off but the agent has no web_search tool', async () => {
    useChatStore.setState({ webSearch: false })
    mockStream()
    vi.spyOn(agentsApi, 'fetchAgentDetailsCached').mockResolvedValue({
      sampleQuestions: [], dataSources: [], skills: [],
      tools: [{ name: 'Sales_Analyst', type: 'cortex_analyst_text_to_sql' }],
    })
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(api.streamAgentRun).toHaveBeenCalledWith(expect.objectContaining({ toolChoice: undefined }))
  })
})

describe('useAgentStream unauthorized retry', () => {
  it('re-issues the run once when onUnauthorized returns a new token', async () => {
    const onUnauthorized = vi.fn().mockResolvedValue('fresh-tok')
    setHostAdapter({ baseUrl: () => '', headers: () => ({}), onUnauthorized })
    const stream = vi.spyOn(api, 'streamAgentRun')
    stream
      .mockImplementationOnce(async function* () {
        throw new ApiError('Agent run error: 401', 401)
      } as any)
      .mockImplementationOnce(async function* () {
        yield { kind: 'text', text: 'ok' }
        yield { kind: 'final' }
      } as any)

    const tempId = useChatStore.getState().newThread('DB.SCH.AG')
    const { result } = renderHook(() => useAgentStream('stale-tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(stream).toHaveBeenCalledTimes(2)
    expect(stream.mock.calls[1][0]).toEqual(expect.objectContaining({ snowflakeToken: 'fresh-tok' }))
    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.status).toBe('done')
    expect(turn.text).toBe('ok')
  })

  it('surfaces the session-expired copy when a second 401 arrives', async () => {
    const onUnauthorized = vi.fn().mockResolvedValue('fresh-tok')
    setHostAdapter({ baseUrl: () => '', headers: () => ({}), onUnauthorized })
    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      throw new ApiError('Agent run error: 401', 401)
    } as any)

    const tempId = useChatStore.getState().newThread('DB.SCH.AG')
    const { result } = renderHook(() => useAgentStream('stale-tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'DB.SCH.AG' })
    })

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.status).toBe('error')
    expect(turn.errorMessage).toMatch(/session has expired/)
  })
})
