// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { FileAttachment } from '../types.js'
import { getHostAdapter } from '../host/hostAdapter.js'
import { throwFromResponse } from './apiError.js'
import { parseSseStream } from './sseParser.js'
import type { AgentEvent } from './sseParser.js'
import { getFeatureFlags } from '../lib/featureFlags.js'
import { buildClientDateContext } from '../lib/datePreamble.js'

export type { AgentEvent }
export { INTERACTIVE_TOOLS, extractSuggestions, parseTable, parseSseEvent } from './sseParser.js'

// Retries only wrap the initial POST, never anything after the stream starts being read - so a
// retry can never duplicate text that's already been yielded to a caller. A bare 500 is not
// retryable: the relay's own timeout used to surface as one, and re-POSTing the same
// thread_id/parent_message_id would start a second (or third) Cortex run.
const RETRY_DELAYS_MS = [500, 1500]
const RETRYABLE = new Set([429, 502, 503, 504])
const MAX_RETRY_WAIT_MS = 8_000

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

function retryAfterMs(res: Response, fallback: number): number {
  const raw = res.headers.get('Retry-After')
  if (!raw) return fallback
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS)
  const when = Date.parse(raw)
  if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), MAX_RETRY_WAIT_MS)
  return fallback
}

async function postAgentRun(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  let waited = 0
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init)
      const retryable = RETRYABLE.has(res.status)
      if (res.ok || !retryable || attempt >= RETRY_DELAYS_MS.length) return res
      const wait = retryAfterMs(res, RETRY_DELAYS_MS[attempt])
      if (waited + wait > MAX_RETRY_WAIT_MS) return res
      waited += wait
      await delay(wait, signal)
      continue
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err
      const wait = RETRY_DELAYS_MS[attempt]
      if (waited + wait > MAX_RETRY_WAIT_MS) throw err
      waited += wait
      await delay(wait, signal)
    }
  }
}

export async function* streamAgentRun(opts: {
  snowflakeToken: string
  query: string
  agentFqn?: string
  threadId?: number
  parentMessageId?: number
  signal?: AbortSignal
  extendedThinking?: boolean
  deepResearch?: boolean
  attachments?: FileAttachment[]
  toolChoice?: { type: 'auto' | 'required' | 'tool'; name?: string[] }
  currentUserName?: string
}): AsyncGenerator<AgentEvent> {
  // Attachments travel as a typed field. The server validates the fileUpload flag,
  // size/type, and fences with a per-request random boundary so a file name cannot
  // forge the delimiter.
  const fileUploadOn = getFeatureFlags().fileUpload && opts.attachments?.length
  const textAttachments = fileUploadOn
    ? opts.attachments!.map((a) => ({ name: a.name, data: a.data }))
    : []

  const contentParts = [{ type: 'text', text: opts.query }]

  // Built once rather than spread from two places: two `experimental` keys in the same object
  // literal would silently drop the first, so date/chart flags, native stream flags, and
  // extended thinking have to merge here.
  //
  // Date/chart flags are always on: prefixing date/user onto the query text made Cortex miss
  // the verified-query exact-match path (ACCOUNT_USAGE, thread 4380303057 vs 4380303049).
  // EnableAnswerBeforeProactiveChartGeneration is what lets native stream the answer before
  // chart tool rounds.
  //
  // The nativeStreamFlags group is extra parity-with-native fields. A probe against a live
  // agent found no difference in the event mix, so they stay behind a flag - see
  // lib/featureFlags.ts.
  const experimental: Record<string, unknown> = {
    ...buildClientDateContext(opts.currentUserName),
    ...(getFeatureFlags().nativeStreamFlags ? {
      enableStepTrace: true,
      enableAnalystStreaming: true,
      enableRelatedQueries: true,
      responseSchemaVersion: 'v2',
    } : {}),
    // Confirmed against live Cortex Agent Run responses and two native-app HAR captures with
    // the "Think deeper" toggle off/on.
    ...(opts.extendedThinking ? {
      reasoningAgentFlowType: 'simple',
      reasoningAgentToolConfig: { orchestrationType: 'reasoning' },
    } : {}),
  }

  const adapter = getHostAdapter()
  const res = await postAgentRun(`${adapter.baseUrl()}/api/agent/run`, {
    method: 'POST',
    signal: opts.signal,
    headers: adapter.headers(opts.snowflakeToken, { Accept: 'text/event-stream' }),
    body: JSON.stringify({
      // agentFqn is validated server-side against the allow-list.
      ...(opts.agentFqn ? { agentFqn: opts.agentFqn } : {}),
      // A real Cortex thread is created up front (see ChatContainer.sendMessage), so
      // thread_id is a valid id (> 0) from the very first turn. When thread_id is present
      // Cortex REQUIRES parent_message_id too (else 400/399504 "cannot be null"); the
      // opening turn has no prior message, so use 0 = root of the thread.
      ...(opts.threadId
        ? { thread_id: opts.threadId, parent_message_id: opts.parentMessageId ?? 0 }
        : {}),
      // Omitted entirely when empty rather than sent as `{}` - Cortex rejects unknown keys, so
      // don't hand it an object to inspect when neither feature is on.
      ...(Object.keys(experimental).length ? { experimental } : {}),
      ...(opts.deepResearch ? { deep_research: true } : {}),
      // Documented public agent:run field (Cortex Agents REST reference) - no consumer sets
      // this yet, threaded through as plain passthrough for whichever future feature needs it.
      ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
      messages: [{ role: 'user', content: contentParts }],
      ...(textAttachments.length ? { attachments: textAttachments } : {}),
    }),
  }, opts.signal)
  if (!res.ok) await throwFromResponse(res, 'Agent run error')
  // Larger than the relay's 15s SSE ping so a silent-but-alive stream is not
  // killed; smaller than the 300s total-stream bound so a dropped connection
  // surfaces as a retryable error rather than hanging the turn forever.
  yield* parseSseStream(res, { stallTimeoutMs: 45_000 })
}
