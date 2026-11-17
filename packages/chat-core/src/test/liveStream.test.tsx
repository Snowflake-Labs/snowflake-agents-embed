// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { useAgentStream } from '../hooks/useAgentStream.js'
import { useChatStore } from '../store/chatStore.js'
import { parseSseStream } from '../api/sseParser.js'
import { ConversationTurn } from '../components/Chat/ConversationTurn.js'
import * as api from '../api/agentRun.js'
import type { ShareButtonSlotProps } from '../components/Chat/MessageActions.js'

/**
 * End-to-end over a real captured stream, rather than hand-written events.
 *
 * The fixture is a verbatim capture of `POST /api/agent/run` through the relay against
 * DEMO_DB.AGENTS.SALES_AGENT ("Top 3 products by revenue?") - 110 events, 79
 * text deltas averaging 10.7 characters, 12 response.status events, a table and a
 * suggested_queries block. It runs the actual parser and the actual hook, so it covers the
 * things unit tests with synthetic events can't: that real multi-block text reassembles in
 * content_index order, that the status narration Cortex really sends survives to the turn, and
 * that per-frame coalescing doesn't reorder prose against the table it introduces.
 */
// Resolved from cwd (the package root under vitest), not import.meta.url - the happy-dom
// environment rewrites module URLs to a non-file scheme, which fileURLToPath rejects.
const FIXTURE = readFileSync(resolve('src/test/fixtures/agent-run-live.txt'), 'utf8')

/**
 * A second capture, from the Teams host against SALES_AGENT ("Compare return rates and
 * negative review rates across the three regions"). It exercises three things the first fixture
 * doesn't: the `sandbox_provisioning`/`sandbox_ready` pair, the six-event
 * `response.tool_result.status` lifecycle of a SQL round (including the `SUCCESS` event whose
 * message is still "Executing SQL", and the one whose message is a bare `Query ID: …`), and the
 * long gap where `planning` is the last status before 99 text deltas.
 */
const SANDBOX_FIXTURE = readFileSync(resolve('src/test/fixtures/agent-run-sandbox.txt'), 'utf8')

function FakeShareButton(_: ShareButtonSlotProps) { return null }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { cb([{ isIntersecting: true }]) }
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

// Replays the fixture as a streaming Response so parseSseStream does the real framing work.
function fixtureResponse(text = FIXTURE): Response {
  const bytes = new TextEncoder().encode(text)
  // Chunked at a boundary that deliberately splits events mid-line, which is exactly the case
  // parseSseStream's line buffering exists for.
  const CHUNK = 997
  let i = 0
  return new Response(new ReadableStream({
    pull(c) {
      if (i >= bytes.length) { c.close(); return }
      c.enqueue(bytes.slice(i, i + CHUNK))
      i += CHUNK
    },
  }))
}

afterEach(() => { vi.restoreAllMocks(); cleanup() })

describe('live captured agent-run stream', () => {
  it('reassembles the answer, artifacts, steps and suggestions', async () => {
    const tempId = useChatStore.getState().newThread('DEMO_DB.AGENTS.SALES_AGENT')
    vi.spyOn(api, 'streamAgentRun').mockImplementation(() => parseSseStream(fixtureResponse()) as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'Top 3 products by revenue?', agentFqn: 'A.B.C' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    expect(turn.status).toBe('done')
    // Both text blocks present, in content_index order (5 then 7), with the intro not clobbered
    // by the consolidated block for the later index.
    expect(turn.text.startsWith('Here are the top 3 products by revenue')).toBe(true)
    expect(turn.text).toContain('Nokia Smart Phone, Full Size')
    expect(turn.text).toContain('the most profitable per pound of sales')
    // The table the prose introduces.
    expect(turn.artifacts.filter((a) => a.type === 'table')).toHaveLength(1)
    // Two tool rounds, both resolved.
    expect(turn.steps).toHaveLength(2)
    expect(turn.steps.every((s) => s.status === 'done')).toBe(true)
    expect(turn.suggestions?.length).toBeGreaterThan(0)
    // Narration is cleared once the turn finishes - it describes work in flight.
    expect(turn.statusLabel).toBeUndefined()
  })

  it('surfaces the narration Cortex actually sends before the answer begins', async () => {
    const tempId = useChatStore.getState().newThread('DEMO_DB.AGENTS.SALES_AGENT')

    // Cut the stream at the first answer-side event, so the turn is observed in the window this
    // narration exists for.
    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      for await (const e of parseSseStream(fixtureResponse())) {
        if (e.kind === 'text' || e.kind === 'text.delta') return
        yield e
      }
    } as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'A.B.C' })
    })

    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!
    // Cortex's own statusMessage, not the raw code, because sseParser prefers `message` over
    // `status`. 'planning' is the last status before the answer in this capture too.
    expect(turn.statusLabel).toBe('Planning the next steps')
  })

  it('renders the finished turn with its reasoning panel collapsed', async () => {
    const tempId = useChatStore.getState().newThread('DEMO_DB.AGENTS.SALES_AGENT')
    vi.spyOn(api, 'streamAgentRun').mockImplementation(() => parseSseStream(fixtureResponse()) as any)

    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'A.B.C' })
    })
    const turn = useChatStore.getState().openThreads[tempId].turns.at(-1)!

    render(<ConversationTurn turn={turn} ShareButton={FakeShareButton} />)

    // Answer prose is rendered through react-markdown (bold survives as <strong>).
    expect(screen.getByText(/top 3 products by revenue/i)).toBeTruthy()
    expect(document.querySelector('.md-message strong')).toBeTruthy()
    // Folded to the summary, not showing the individual steps. The header reads 'Thinking
    // complete' rather than a duration: the turn was rendered from the store after it finished,
    // which is the same position a rehydrated thread is in.
    expect(screen.getByText('Thinking complete')).toBeTruthy()
    expect(document.querySelector('.steps-list')).toBeNull()
    // No stale live-progress affordances on a finished turn.
    expect(document.querySelector('.spinner')).toBeNull()
    expect(document.querySelector('.cursor')).toBeNull()
  })
})

describe('live captured stream with a sandbox and a full SQL lifecycle', () => {
  async function replay(tempId: string, stopAtFirstAnswer = false) {
    vi.spyOn(api, 'streamAgentRun').mockImplementation(async function* () {
      for await (const e of parseSseStream(fixtureResponse(SANDBOX_FIXTURE))) {
        if (stopAtFirstAnswer && (e.kind === 'text' || e.kind === 'text.delta')) return
        yield e
      }
    } as any)
    const { result } = renderHook(() => useAgentStream('tok'))
    await act(async () => {
      await result.current.stream({ tempId, query: 'q', agentFqn: 'A.B.C' })
    })
    return useChatStore.getState().openThreads[tempId].turns.at(-1)!
  }

  it('reads the finished SQL step in the past tense, not as still executing', async () => {
    const tempId = useChatStore.getState().newThread('DEMO_DB.AGENTS.SALES_AGENT')
    const turn = await replay(tempId)

    render(<ConversationTurn turn={turn} ShareButton={FakeShareButton} />)
    // Finished turns start collapsed; open it to read the rows.
    fireEvent.click(screen.getAllByRole('button', { name: /Thinking/ })[0])

    const sql = turn.steps.find((s) => s.toolType === 'system_execute_sql')!
    expect(sql.status).toBe('done')
    // The six tool_result.status events left "Executing SQL" on the step - our own label wins.
    expect(sql.statusMessage).toBe('Executing SQL')
    expect(screen.getByText('Retrieved data')).toBeTruthy()
    expect(screen.getByText('Reviewed context')).toBeTruthy()
    expect(document.querySelector('.steps-list')!.textContent).not.toContain('Executing SQL')
    // One of those six events was a bare query id, which must never be the visible step text.
    expect(document.body.textContent).not.toContain('Query ID')
  })

  it('stops narrating orchestration once the answer is being written', async () => {
    const tempId = useChatStore.getState().newThread('DEMO_DB.AGENTS.SALES_AGENT')
    const turn = await replay(tempId)

    expect(turn.text.length).toBeGreaterThan(0)
    expect(turn.statusLabel).toBeUndefined()
  })

  it('narrates the sandbox wait but never the literal sandbox_ready', async () => {
    const tempId = useChatStore.getState().newThread('DEMO_DB.AGENTS.SALES_AGENT')
    // Observed mid-flight: 'sandbox_provisioning' is event 3, long before any answer content.
    const turn = await replay(tempId, true)

    // The last surviving status before the answer. Neither of the denied codes
    // (extracting_tool_calls / executing_tools / executing_tool) nor sandbox_ready can be it.
    expect(turn.statusLabel).toBe('Planning the next steps')

    render(<ConversationTurn turn={turn} ShareButton={FakeShareButton} />)
    expect(document.body.textContent).not.toContain('sandbox_ready')
    expect(document.body.textContent).not.toContain('Choosing data sources to use')
    expect(document.body.textContent).not.toContain('Getting additional context')
  })
})
