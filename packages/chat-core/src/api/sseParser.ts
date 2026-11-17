// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { VegaLiteSpec, ColumnDef, Citation } from '../types.js'
import type { MapSpec } from '../lib/mapSpec.js'
import { resolveMapSpec } from '../lib/mapSpec.js'
import { sanitizeChartSpec } from '../lib/sanitizeChartSpec.js'
import { sanitizeMapSpec } from '../lib/sanitizeMapSpec.js'

// Tool types whose tool_use marks a paused turn awaiting a user answer, rather than a normal
// running step. Wire shape is unconfirmed (Phase 1 probe: no-evidence for both) — matched by
// tool type name since that's the only thing the official app's own error string
// ("tool_type: ask_user_question") confirms.
export const INTERACTIVE_TOOLS = ['ask_user_question', 'permission_decision']

/** Tool types whose `input.sql` / `input.query` is a real SQL statement, not an incidental field. */
export const SQL_TOOLS = ['system_execute_sql', 'cortex_analyst_text_to_sql', 'sql_execution']

export type AgentEvent =
  // `label` is the prose Cortex sent (or the code, when it sent none); `code` is the raw
  // machine-readable status. Both are needed: the label is what gets displayed, but only the
  // code can be filtered against - by the time prose like "Choosing data sources to use" is in
  // hand there is no way back to `extracting_tool_calls`. See useAgentStream's deny-list.
  | { kind: 'status'; label: string; code?: string }
  | { kind: 'thinking.delta'; text: string; contentIndex?: number }
  | { kind: 'thinking'; text: string; contentIndex?: number }
  // Cortex splits one answer across several text blocks, interleaved with table/chart blocks,
  // each tagged with its own content_index. Consumers must accumulate per index and join —
  // see useAgentStream's textByIndex and relay's aggregate.ts.
  | { kind: 'text.delta'; text: string; contentIndex?: number }
  | { kind: 'text'; text: string; contentIndex?: number; annotations?: Citation[] }
  | { kind: 'annotation'; citation: Citation }
  | { kind: 'tool_use'; id: string; toolType: string; sql?: string; input?: any }
  | {
      kind: 'tool_result'
      id: string
      status: 'success' | 'error'
      queryId?: string
      sql?: string
      verifiedQueryUsed?: boolean
      semanticModelName?: string
    }
  | { kind: 'tool_result.status'; id: string; message: string }
  | { kind: 'chart'; spec: VegaLiteSpec; toolUseId?: string }
  | { kind: 'map'; spec: MapSpec; toolUseId?: string }
  | { kind: 'table'; rowType: ColumnDef[]; data: unknown[][]; queryId?: string; numRows?: number; title?: string }
  | { kind: 'metadata'; threadId?: number; messageId?: number; assistantMessageId?: number; role?: string }
  | { kind: 'warning'; code?: string; message?: string }
  | { kind: 'suggested_queries'; suggestions: string[] }
  | { kind: 'final'; threadId?: number; messageId?: number; suggestions?: string[] }
  | { kind: 'done' }
  | { kind: 'error'; code?: string; message: string; requestId?: string }
  /** Unrecognised event name — yielded so the consumer can count it, not so it changes the turn. */
  | { kind: 'unknown'; event: string }
  /** `data:` payload was not valid JSON — same: count, do not change the turn. */
  | { kind: 'parse_failure'; event: string }

// Cortex sends suggested queries as either bare strings or { query: string }. Shared by the
// live-stream event (response.suggested_queries) and the persisted-thread reconstruction, so a
// reopened thread's suggestions match what was rendered live.
export function extractSuggestions(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out = list
    .map((q: any) => (typeof q === 'string' ? q : q?.query))
    .filter((q: unknown): q is string => typeof q === 'string' && q.length > 0)
  return out.length ? out : undefined
}

// The response.table event nests rows + columns under `result_set`:
//   { result_set: { data: [...], resultSetMetaData: { rowType: [...] } } }
// Older/alternate shapes put them at the top level (data / rowType) or use
// snake_case (result_set_meta_data). Handle all so the TSV/table isn't empty.
export function parseTable(d: any): AgentEvent {
  const rs = d.result_set ?? d.resultSet ?? d
  const meta = rs.resultSetMetaData ?? rs.result_set_meta_data ?? d.result_set_meta_data ?? {}
  return {
    kind: 'table',
    rowType: d.rowType ?? meta.rowType ?? meta.row_type ?? [],
    data: rs.data ?? d.data ?? [],
    queryId: d.query_id ?? d.queryId,
    numRows: meta.numRows ?? meta.num_rows,
    title: d.title,
  }
}

// response.tool_result's `content` is a list of typed blocks; the one we care about is
// {type:'json', json:{...}} which carries query_id/sql/verified_query_used for a SQL tool_result,
// or semantic_model_name/sql_best_practices for a semantic-context tool_result. Fields are read
// opportunistically — a given tool_result only ever has one shape or the other.
export function extractToolResultFields(d: any) {
  const jsonBlock = Array.isArray(d.content) ? d.content.find((c: any) => c?.json) : undefined
  const j = jsonBlock?.json ?? {}
  return {
    queryId: j.query_id,
    sql: j.sql,
    verifiedQueryUsed: j.verified_query_used,
    semanticModelName: j.semantic_model_name,
  }
}

// A Cortex Search doc_id is an opaque identifier, not always a URL - only render it as a link
// when it actually parses as one.
/** Strip markdown link / emphasis metacharacters from agent-authored label text. */
export function escapeMarkdownLabel(label: string): string {
  return label.replace(/[[\]()`\\#>\-]/g, '')
}

export function toCitationUrl(docId?: string): string | undefined {
  if (!docId) return undefined
  try {
    const u = new URL(docId)
    return u.protocol === 'http:' || u.protocol === 'https:' ? docId : undefined
  } catch {
    return undefined
  }
}

// A single response.text.annotation event:
//   {"annotation":{"doc_id":"…","doc_title":"…","index":667,"search_result_id":"cs_…","text":"…"},
//    "annotation_index":1,"content_index":31,"sequence_number":187}
// `annotation_index` (1-based, scoped to one content block) is the display number.
// `annotation.index` (e.g. 667) is a character offset into the block's text - never a display
// number, even though it's easy to mistake for one since it's the only "index" without a prefix.
export function parseAnnotation(d: any): Citation {
  const a = d.annotation ?? {}
  const contentIndex: number | undefined = d.content_index
  const index = typeof d.annotation_index === 'number' ? d.annotation_index : (a.index ?? 0)
  return {
    index,
    docTitle: a.doc_title,
    docId: a.doc_id,
    url: toCitationUrl(a.doc_id),
    text: a.text,
    searchResultId: a.search_result_id,
    contentIndex,
  }
}

// The terminal (non-delta) response.text event carries the full annotation set for its content
// block inline as an array - no annotation_index there, so 1-based array position is the display
// number:
//   {"annotations":[{"doc_id":"…","doc_title":"…","search_result_id":"cs_…","text":"…"}, …],
//    "content_index":6,"text":"…"}
export function annotationsToCitations(list: unknown[], contentIndex?: number): Citation[] {
  return list.map((raw, i) => {
    const a = raw as Record<string, unknown>
    return {
      index: i + 1,
      docTitle: a.doc_title as string | undefined,
      docId: a.doc_id as string | undefined,
      url: toCitationUrl(a.doc_id as string | undefined),
      text: a.text as string | undefined,
      searchResultId: a.search_result_id as string | undefined,
      contentIndex,
    }
  })
}

function citationKey(c: Pick<Citation, 'searchResultId' | 'contentIndex' | 'index'>): string {
  return c.searchResultId ?? `${c.contentIndex ?? 0}:${c.index}`
}

// Both the per-citation response.text.annotation events AND the terminal response.text's
// annotations[] array describe the same citations - Cortex sends both in the same stream.
// Dedupe on search_result_id (falling back to a content-index/index composite) so the Sources
// panel doesn't render every citation twice, then renumber sequentially for display since
// annotation_index resets per content block and would otherwise repeat ("1, 2, 1, 2").
export function mergeCitations(existing: Citation[], incoming: Citation[]): Citation[] {
  const byKey = new Map<string, Citation>()
  for (const c of existing) byKey.set(citationKey(c), c)
  for (const c of incoming) byKey.set(citationKey(c), c)
  return [...byKey.values()]
    .sort((a, b) => (a.contentIndex ?? 0) - (b.contentIndex ?? 0) || a.index - b.index)
    .map((c, i) => ({ ...c, index: i + 1 }))
}

export function parseSseEvent(event: string, data: string): AgentEvent | null {
  let d: any
  try { d = JSON.parse(data) } catch { return { kind: 'parse_failure', event } }
  try {
    switch (event) {
      case 'response.status':            return { kind: 'status', label: d.message ?? d.status ?? '', code: d.status }
      case 'response.thinking.delta':    return { kind: 'thinking.delta', text: d.text ?? '', contentIndex: d.content_index ?? 0 }
      case 'response.thinking':          return { kind: 'thinking', text: d.thinking?.text ?? d.text ?? '', contentIndex: d.content_index ?? 0 }
      case 'response.text.delta':        return { kind: 'text.delta', text: d.text ?? '', contentIndex: d.content_index ?? 0 }
      case 'response.text': {
        const annotations = Array.isArray(d.annotations)
          ? annotationsToCitations(d.annotations, d.content_index ?? 0)
          : undefined
        return { kind: 'text', text: d.text ?? '', contentIndex: d.content_index ?? 0, ...(annotations ? { annotations } : {}) }
      }
      case 'response.text.annotation':   return { kind: 'annotation', citation: parseAnnotation(d) }
      case 'response.tool_use': {
        const toolType = d.type ?? d.name
        const sql: string | undefined = SQL_TOOLS.includes(toolType)
          ? (d.input?.sql ?? d.input?.query ?? undefined)
          : undefined
        return { kind: 'tool_use', id: d.tool_use_id, toolType, sql, input: d.input }
      }
      case 'response.tool_result':
        return { kind: 'tool_result', id: d.tool_use_id, status: d.status === 'error' ? 'error' : 'success', ...extractToolResultFields(d) }
      // response.tool_use.status carries a "starting" narration (e.g. "Computing Pearson
      // correlation…") in the same {message, tool_use_id} shape as tool_result.status's "running"
      // narration - fold both into one ThinkingStep.statusMessage update rather than a second event kind.
      case 'response.tool_use.status':
      case 'response.tool_result.status': return { kind: 'tool_result.status', id: d.tool_use_id, message: d.message ?? '' }
      case 'response.chart': {
        try {
          const parsed = typeof d.chart_spec === 'string' ? JSON.parse(d.chart_spec) : d.chart_spec
          const asMap = resolveMapSpec(parsed)
          if (asMap) {
            const spec = sanitizeMapSpec(asMap)
            return spec ? { kind: 'map', spec, toolUseId: d.tool_use_id } : null
          }
          const spec = sanitizeChartSpec(parsed)
          return spec ? { kind: 'chart', spec, toolUseId: d.tool_use_id } : null
        } catch {
          return null
        }
      }
      case 'response.map': {
        try {
          const parsed = typeof d.map_spec === 'string' ? JSON.parse(d.map_spec) : d.map_spec
          const spec = sanitizeMapSpec(resolveMapSpec(parsed) ?? parsed)
          return spec ? { kind: 'map', spec, toolUseId: d.tool_use_id } : null
        } catch {
          return null
        }
      }
      case 'response.table':             return parseTable(d)
      case 'response.suggested_queries': {
        const suggestions = extractSuggestions(d.suggested_queries)
        return suggestions ? { kind: 'suggested_queries', suggestions } : null
      }
      case 'metadata': {
        // Cortex nests the id under `metadata` and tags it by role:
        //   {"metadata": {"message_id": 287…750, "role": "assistant"}}
        // Tolerate the combined shape ({thread_id, assistant_message_id}) and a flat shape.
        const m = d.metadata ?? d
        return {
          kind: 'metadata',
          threadId: m.thread_id,
          messageId: m.message_id,
          assistantMessageId: m.assistant_message_id,
          role: m.role,
        }
      }
      case 'response': {
        const sugs = d.follow_up_suggestions ?? d.metadata?.follow_up_suggestions
        return {
          kind: 'final',
          threadId: d.metadata?.thread_id,
          messageId: d.metadata?.message_id,
          suggestions: Array.isArray(sugs) ? sugs.map(String) : undefined,
        }
      }
      case 'done':                       return { kind: 'done' }
      case 'response.warning':           return { kind: 'warning', code: d.code, message: d.message }
      case 'error':                      return { kind: 'error', code: d.code, message: d.message ?? 'Cortex error', requestId: d.request_id }
      default:                           return { kind: 'unknown', event }
    }
  } catch {
    // A future per-case field access must not take down the generator.
    return null
  }
}

/**
 * Linear SSE line framer: append a decoded chunk and emit every complete line.
 *
 * Tracks a scan offset so a long incomplete `data:` line is not re-split on every
 * network chunk. Total work is O(bytes received), not O(line length × chunk count).
 * Shared by `parseSseStream` and the relay aggregator so framing exists once.
 */
export interface SseLineBuffer {
  buffer: string
  searchedUpTo: number
}

export function appendSseChunk(state: SseLineBuffer, chunk: string): string[] {
  state.buffer += chunk
  const lines: string[] = []
  let start = 0
  let searchFrom = state.searchedUpTo
  while (true) {
    const nl = state.buffer.indexOf('\n', searchFrom)
    if (nl === -1) {
      state.searchedUpTo = state.buffer.length
      break
    }
    lines.push(state.buffer.slice(start, nl))
    start = nl + 1
    searchFrom = start
  }
  if (lines.length > 0) {
    state.buffer = state.buffer.slice(start)
    state.searchedUpTo = state.buffer.length
  }
  return lines
}

/**
 * Consumes an SSE `Response` body, decoding + line-buffering it and parsing each event/data
 * pair via `parseSseEvent`. Shared by the browser client's `streamAgentRun` (agentRun.ts) and
 * the Teams bot's server-side agent call (packages/server/src/bot/cortex.ts), so the raw SSE
 * framing logic exists exactly once. Deliberately has no `import.meta.env` or HostAdapter
 * dependency (unlike agentRun.ts) so it's safe to import from a plain Node/tsx runtime.
 */
export class StreamStallError extends Error {
  readonly code = 'stream_stall'
  constructor(stallTimeoutMs: number) {
    super(`Stream stalled: no data received for ${stallTimeoutMs}ms`)
    this.name = 'StreamStallError'
  }
}

export async function* parseSseStream(
  res: Response,
  opts?: { stallTimeoutMs?: number },
): AsyncGenerator<AgentEvent> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const lineBuf: SseLineBuffer = { buffer: '', searchedUpTo: 0 }
  let currentEvent = ''
  const warned = new Set<string>()
  const stallTimeoutMs = opts?.stallTimeoutMs

  const readChunk = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (!stallTimeoutMs) return reader.read()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StreamStallError(stallTimeoutMs)), stallTimeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const consumeLine = function* (line: string): Generator<AgentEvent> {
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim()
      return
    }
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    const evt = parseSseEvent(currentEvent, payload)
    if (!evt) return
    if (evt.kind === 'unknown' || evt.kind === 'parse_failure') {
      if (!warned.has(evt.event)) {
        warned.add(evt.event)
        console.warn(`[sse] dropped ${evt.kind} event: ${evt.event}`)
      }
    }
    yield evt
  }

  try {
    while (true) {
      const { done, value } = await readChunk()
      if (done) break
      for (const line of appendSseChunk(lineBuf, decoder.decode(value, { stream: true }))) {
        yield* consumeLine(line)
      }
    }
    // Flush a multi-byte tail and any last event that was not newline-terminated.
    const tail = lineBuf.buffer + decoder.decode()
    if (tail.trim()) {
      for (const line of tail.split('\n')) {
        if (line) yield* consumeLine(line)
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* already closed or cancelled */ }
  }
}
