// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import type { ThinkingStep, FileAttachment, PendingQuestion } from '../types.js'
import { streamAgentRun, INTERACTIVE_TOOLS } from '../api/agentRun.js'
import { fetchAgentDetailsCached } from '../api/agents.js'
import { mergeCitations } from '../api/sseParser.js'
import { toolLabel } from '../api/toolLabel.js'
import { translateError } from '../lib/translateError.js'
import { parseAutomationInput } from '../lib/automationStep.js'
import { joinThinking } from '../lib/thinkingText.js'
import { statusLabel } from '../lib/statusLabel.js'
import { useChatStore } from '../store/chatStore.js'
import { getHostAdapter } from '../host/hostAdapter.js'

/**
 * Status codes never shown as live narration, ported from the native app's own deny-list.
 *
 * The first four are duplicates: each announces a tool round that the tool step itself already
 * narrates, one row per `toolUseId`, with its own spinner and its own per-tool messages on
 * `response.tool_result.status`. Showing both means the panel says "Running system_execute_sql"
 * twice in two places.
 *
 * `sandbox_ready` is ours, not the native app's: its `message` is the literal string
 * `sandbox_ready` (verified in the Teams HAR), and it marks a lifecycle no-op with nothing to
 * report. Its partner `sandbox_provisioning` is deliberately kept - it explains a genuine
 * multi-second wait, and the line it produces is transient either way now that the answer
 * clears it.
 */
const DENIED_STATUS_CODES = new Set([
  'executing_tool',
  'executing_tools',
  'extracting_tool_calls',
  'client_tool_use_request',
  'sandbox_ready',
])

// Best-effort extraction of a human prompt + choices from an ask_user_question/permission_decision
// tool_use input. Wire shape is unconfirmed (Phase 1 probe: no-evidence) so this tries a few
// plausible field names rather than assuming one; falls back to stringifying the input so the
// fallback panel always has *something* to show instead of a blank prompt.
function extractPendingQuestion(id: string, toolType: string, input: any): PendingQuestion {
  const prompt = input?.question ?? input?.prompt ?? input?.message ?? JSON.stringify(input ?? {})
  const options = Array.isArray(input?.options)
    ? input.options.map(String)
    : toolType === 'permission_decision' ? ['Allow', 'Deny'] : undefined
  return { toolUseId: id, toolType, prompt, options }
}

/**
 * Cortex's agent:run has no documented "disable this one tool" flag - `tool_choice` only
 * supports auto (default) / required / a named allow-list. So turning the Web search toggle
 * off is implemented as an allow-list of every *other* tool name, which leaves web_search out
 * of the candidate set for this turn without touching skills or mcp_servers (separate spec
 * keys, not part of the `tools` array `tool_choice.name` restricts). Returns undefined when
 * the agent has no web_search tool at all, so an agent without it never gets a needless
 * (and untested) restriction.
 */
async function buildWebSearchToolChoice(
  snowflakeToken: string,
  agentFqn: string,
): Promise<{ type: 'tool'; name: string[] } | undefined> {
  const details = await fetchAgentDetailsCached(snowflakeToken, agentFqn)
  if (!details?.tools.some((t) => t.type === 'web_search')) return undefined
  const otherNames = details.tools.filter((t) => t.type !== 'web_search' && t.name).map((t) => t.name!)
  return { type: 'tool', name: otherNames }
}


export function useAgentStream(snowflakeToken: string) {
  const abortByTempId = useRef<Map<string, AbortController>>(new Map())

  const stream = useCallback(async (opts: {
    tempId: string
    query: string
    agentFqn: string
    threadId?: number
    parentMessageId?: number
    attachments?: FileAttachment[]
    currentUserName?: string
  }) => {
    const { appendTurn, updateTurn, setStreaming, reconcileThreadId } = useChatStore.getState()
    const { tempId, query, agentFqn, threadId, parentMessageId, attachments, currentUserName } = opts

    const aid = uuid()
    appendTurn(tempId, {
      id: aid, role: 'assistant', steps: [], text: '', citations: [], artifacts: [], status: 'streaming',
    })
    setStreaming(tempId, true)

    const abort = new AbortController()
    abortByTempId.current.get(tempId)?.abort()
    abortByTempId.current.set(tempId, abort)

    const update = (fn: Parameters<typeof updateTurn>[2]) => updateTurn(tempId, aid, fn)

    const { extendedThinking, deepResearch, webSearch } = useChatStore.getState()
    const toolChoice = webSearch ? undefined : await buildWebSearchToolChoice(snowflakeToken, agentFqn)

    // Fire-and-forget operational telemetry - never awaited, never allowed to affect the
    // turn's own state. Split so the next HAR/ACCOUNT_USAGE comparison can tell first-byte
    // (hop) from first thinking from first answer token (the VQR miss showed up here).
    const startedAt = Date.now()
    let ttfbMs: number | undefined
    let ttftMs: number | undefined
    let firstThinkingMs: number | undefined
    let firstAnswerTokenMs: number | undefined
    let firstTableMs: number | undefined
    const toolNames: string[] = []
    let aborted = false
    let sawTerminal = false
    let errorClass: string | undefined
    const unknownEvents: string[] = []
    let parseFailures = 0
    const elapsed = () => Date.now() - startedAt
    const markFirstSse = () => { if (ttfbMs === undefined) ttfbMs = elapsed() }
    const markFirstToken = () => { if (ttftMs === undefined) ttftMs = elapsed() }
    const markFirstThinking = () => {
      markFirstToken()
      if (firstThinkingMs === undefined) firstThinkingMs = elapsed()
    }
    const markFirstAnswer = () => {
      markFirstToken()
      if (firstAnswerTokenMs === undefined) firstAnswerTokenMs = elapsed()
    }

    // One answer arrives as several text blocks keyed by content_index, interleaved with the
    // table/chart blocks they describe: "Here are the sales by region:" (12), "\n\n" (14),
    // "The Central region leads…" (16). Accumulating into a single string in arrival order
    // would be fine, but a non-delta `response.text` for an index is the *consolidated* text
    // for that index rather than an increment — so it has to replace that index, not append.
    // Assigning it to the whole turn (the old behaviour) let the last block wipe the body.
    // Same scheme as relay's aggregate.ts, which hit this first.
    const textByIndex = new Map<number, string>()
    const joinText = () =>
      [...textByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join('')

    const thinkingByIndex = new Map<number, string>()

    /**
     * Once any answer-side content exists, orchestration narration stops - the answer itself is
     * the progress indicator, and the panel's timer covers the rest.
     *
     * This is what stops the panel reading "Planning the next steps" through the whole answer:
     * `planning` is genuinely the last status Cortex sends before the text deltas begin, and
     * `proceeding_to_answer` ("Forming the answer") doesn't arrive until *after* the answer is
     * fully written. Neither is worth showing.
     */
    let sawAnswer = false
    let lastStatus: string | undefined
    const noteAnswer = () => {
      if (sawAnswer) return
      sawAnswer = true
      if (lastStatus !== undefined) { lastStatus = undefined; update((t) => ({ ...t, statusLabel: undefined })) }
    }

    /**
     * Deltas accumulate into the two maps above and are pushed into the store at most once per
     * animation frame, rather than once per delta.
     *
     * Cortex sends character-level text deltas - averaging ~10 characters - so a single answer
     * is hundreds of events. Applying each one individually meant a store write, a re-render and
     * a full remark/rehype re-parse of the answer per event, which is what made streaming feel
     * jerkier here than in the native app despite an identical wire cadence.
     *
     * The interval alongside the rAF is not redundant: requestAnimationFrame is throttled to
     * nothing in a background tab or a scrolled-out-of-view iframe, and embedded hosts (Teams tabs)
     * run this inside an iframe. Without the timer, text would silently stall there until
     * the frame came back into view. 33ms (~30 Hz) is close enough to a visible tab's rAF that
     * typing cadence matches native; the old 100ms fallback made iframe hosts feel chunky.
     *
     * Both timers share a time-since-last-flush gate so they cannot each fire a flush on
     * every tick. Cortex deltas typically arrive slower than one frame, and without the
     * gate flush count tracked delta count rather than wall-clock time. Explicit flushNow()
     * calls (artifacts, citations, terminal events) still go through immediately so pending
     * prose stays ahead of the content it describes.
     */
    const FLUSH_INTERVAL_MS = 33
    let dirty = false
    let rafId: number | undefined
    let intervalId: ReturnType<typeof setInterval> | undefined
    let flushedOnce = false
    let lastFlushAt = 0

    const flushNow = () => {
      if (rafId !== undefined) { cancelAnimationFrame(rafId); rafId = undefined }
      if (!dirty) return
      dirty = false
      flushedOnce = true
      lastFlushAt = performance.now()
      const thinking = joinThinking(thinkingByIndex)
      update((t) => ({ ...t, text: joinText(), ...(thinking ? { thinking } : {}) }))
    }

    const maybeFlush = () => {
      if (!dirty) return
      if (flushedOnce && performance.now() - lastFlushAt < FLUSH_INTERVAL_MS) return
      flushNow()
    }

    const scheduleFlush = () => {
      dirty = true
      // First visible token paints immediately - waiting a frame (or 33ms in a throttled
      // iframe) is the TTFT the user notices.
      if (!flushedOnce) { flushNow(); return }
      if (rafId === undefined) rafId = requestAnimationFrame(maybeFlush)
      if (intervalId === undefined) intervalId = setInterval(maybeFlush, FLUSH_INTERVAL_MS)
    }

    const stopFlushing = () => {
      if (rafId !== undefined) { cancelAnimationFrame(rafId); rafId = undefined }
      if (intervalId !== undefined) { clearInterval(intervalId); intervalId = undefined }
    }

    let activeToken = snowflakeToken
    let retriedUnauthorized = false
    try {
      for (;;) {
        try {
      for await (const e of streamAgentRun({
        snowflakeToken: activeToken,
        query,
        agentFqn,
        threadId,
        parentMessageId,
        signal: abort.signal,
        extendedThinking,
        deepResearch,
        attachments,
        toolChoice,
        currentUserName,
      })) {
        markFirstSse()
        // Every non-delta case below flushes the pending deltas *before* applying its own
        // update, so the order of prose relative to the tables/charts/citations it describes is
        // exactly what arrived on the wire. Only the two delta cases defer.
        switch (e.kind) {
          case 'thinking.delta': {
            markFirstThinking()
            const i = e.contentIndex ?? 0
            thinkingByIndex.set(i, (thinkingByIndex.get(i) ?? '') + e.text)
            scheduleFlush(); break
          }
          case 'thinking': {
            markFirstThinking()
            // Set per-index, never a shared scalar — a later empty consolidated event (the
            // common case after tool rounds) must not wipe an earlier real one.
            thinkingByIndex.set(e.contentIndex ?? 0, e.text)
            scheduleFlush(); break
          }
          case 'text.delta': {
            markFirstAnswer()
            noteAnswer()
            const i = e.contentIndex ?? 0
            textByIndex.set(i, (textByIndex.get(i) ?? '') + e.text)
            scheduleFlush(); break
          }
          case 'status': {
            // Fills the ~500ms before the first token and the multi-second gaps around tool
            // rounds - but only that. Anything the tool steps already narrate is denied, and
            // once the answer starts there is nothing left worth narrating.
            if (sawAnswer) break
            if (e.code && DENIED_STATUS_CODES.has(e.code)) break
            const label = statusLabel(e.label)
            // Cortex repeats a status verbatim across rounds ('planning' arrives three times in
            // the Teams capture); an unchanged label should cost no render.
            if (label === lastStatus) break
            lastStatus = label
            flushNow()
            update((t) => ({ ...t, statusLabel: label })); break
          }
          case 'text': {
            markFirstAnswer()
            noteAnswer()
            // Set, never append — see textByIndex above.
            textByIndex.set(e.contentIndex ?? 0, e.text)
            flushNow()
            update((t) => ({
              ...t,
              text: joinText(),
              // The terminal response.text event's annotations[] describes the same citations
              // as the response.text.annotation events already merged in below - dedupe, don't
              // append, or every citation renders twice.
              citations: e.annotations ? mergeCitations(t.citations, e.annotations) : t.citations,
            })); break
          }
          case 'annotation':
            flushNow()
            update((t) => ({ ...t, citations: mergeCitations(t.citations, [e.citation]) })); break
          case 'tool_use': {
            flushNow()
            if (INTERACTIVE_TOOLS.includes(e.toolType)) {
              update((t) => ({ ...t, pendingQuestion: extractPendingQuestion(e.id, e.toolType, e.input) }))
              break
            }
            toolNames.push(e.toolType)
            const step: ThinkingStep = {
              id: e.id, toolType: e.toolType, status: 'running', label: toolLabel(e.toolType), sql: e.sql,
              automation: parseAutomationInput(e.toolType, e.input),
            }
            update((t) => ({ ...t, steps: [...t.steps, step] })); break
          }
          case 'tool_result':
            flushNow()
            update((t) => ({
              ...t,
              steps: t.steps.map((s) => s.id === e.id
                ? { ...s, status: e.status === 'error' ? 'error' : 'done', queryId: e.queryId, verifiedQueryUsed: e.verifiedQueryUsed, semanticModelName: e.semanticModelName, sql: e.sql ?? s.sql }
                : s),
            })); break
          case 'tool_result.status':
            flushNow()
            update((t) => ({ ...t, steps: t.steps.map((s) => s.id === e.id ? { ...s, statusMessage: e.message } : s) })); break
          case 'chart':
            noteAnswer()
            flushNow()
            update((t) => ({ ...t, artifacts: [...t.artifacts, { id: uuid(), type: 'chart', spec: e.spec, toolUseId: e.toolUseId }] })); break
          case 'map':
            noteAnswer()
            flushNow()
            update((t) => ({ ...t, artifacts: [...t.artifacts, { id: uuid(), type: 'map', spec: e.spec, toolUseId: e.toolUseId }] })); break
          case 'table':
            if (firstTableMs === undefined) firstTableMs = elapsed()
            noteAnswer()
            flushNow()
            update((t) => ({ ...t, artifacts: [...t.artifacts, { id: uuid(), type: 'table', rowType: e.rowType, data: e.data, queryId: e.queryId, numRows: e.numRows, title: e.title }] })); break
          case 'suggested_queries':
            flushNow()
            update((t) => ({ ...t, suggestions: e.suggestions })); break
          case 'warning':
            flushNow()
            update((t) => ({ ...t, warnings: [...(t.warnings ?? []), { code: e.code, message: e.message }] })); break
          case 'done':
            break
          case 'metadata': {
            flushNow()
            // Chain parent_message_id off the ASSISTANT message id (role-tagged event,
            // or a combined event's assistant_message_id). The role:'user' metadata event
            // must NOT be chained. thread_id isn't in these events, so fall back to the
            // id we created client-side.
            const assistantId = e.role === 'assistant' ? e.messageId : e.assistantMessageId
            const tid = e.threadId ?? threadId
            if (tid && assistantId != null) reconcileThreadId(tempId, tid, assistantId)
            // Also stamp the id onto the turn itself. reconcileThreadId records it as the
            // thread's *latest* id, which the next turn chains off; the copy on the turn is
            // what "save this answer to a record" cites, and stays correct once newer
            // turns arrive.
            if (assistantId != null) update((t) => ({ ...t, messageId: assistantId }))
            break
          }
          case 'final':
            sawTerminal = true
            flushNow()
            // An earlier `error` event wins: a later terminal `response` must not hide it.
            update((t) => ({
              ...t,
              status: t.status === 'error' ? 'error' : 'done',
              // Cleared here and on error: the narration describes work in progress, so leaving
              // the last one ("Proceeding to answer") on a finished turn would be a lie.
              statusLabel: undefined,
              ...(e.suggestions?.length ? { suggestions: e.suggestions } : {}),
            }))
            break
          case 'error':
            sawTerminal = true
            errorClass = e.code
            flushNow()
            update((t) => ({ ...t, status: 'error', statusLabel: undefined, errorCode: e.code, errorMessage: translateError({ code: e.code, message: e.message }), requestId: e.requestId })); break
          case 'unknown':
            if (!unknownEvents.includes(e.event)) unknownEvents.push(e.event)
            break
          case 'parse_failure':
            parseFailures++
            break
        }
      }
          break
        } catch (inner: any) {
          if (!retriedUnauthorized && (inner.status === 401 || inner.status === 403)) {
            let next: string | null = null
            try {
              next = (await getHostAdapter().onUnauthorized?.()) ?? null
            } catch {
              next = null
            }
            if (next) {
              retriedUnauthorized = true
              activeToken = next
              continue
            }
          }
          throw inner
        }
      }
    } catch (err: any) {
      // Flush first either way, so a partial answer isn't lost by an error or a user stop
      // arriving between the last frame and the last delta.
      flushNow()
      if (err.name !== 'AbortError') {
        errorClass = err.code ?? err.name ?? 'unknown'
        update((t) => ({ ...t, status: 'error', statusLabel: undefined, errorMessage: translateError(err) }))
      } else {
        aborted = true
        update((t) => ({ ...t, status: 'done', interrupted: true, statusLabel: undefined }))
      }
    } finally {
      flushNow()
      stopFlushing()
      if (!aborted && !sawTerminal) {
        errorClass = errorClass ?? 'stream_eof_no_terminal'
        update((t) => t.status === 'streaming' ? { ...t, status: 'error', interrupted: true } : t)
      }
      setStreaming(tempId, false)
      if (abortByTempId.current.get(tempId) === abort) abortByTempId.current.delete(tempId)
      getHostAdapter().telemetry?.(snowflakeToken, 'agent_run', {
        ttfbMs, ttftMs, firstThinkingMs, firstAnswerTokenMs, firstTableMs,
        durationMs: Date.now() - startedAt, aborted, errorClass,
        toolNames: toolNames.length ? toolNames : undefined,
        unknownEvents: unknownEvents.length ? unknownEvents : undefined,
        parseFailures: parseFailures || undefined,
      })
    }
  }, [snowflakeToken])

  const stop = useCallback((tempId?: string) => {
    if (tempId) abortByTempId.current.get(tempId)?.abort()
  }, [])

  return { stream, stop }
}
