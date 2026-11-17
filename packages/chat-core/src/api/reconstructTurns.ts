// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { v4 as uuid } from 'uuid'
import type { ConversationTurn, ThinkingStep, Artifact, Citation } from '../types.js'
import { sortThreadMessages, type ThreadMessage } from './threads.js'
import { parseTable, extractSuggestions } from './agentRun.js'
import { annotationsToCitations, mergeCitations, toCitationUrl } from './sseParser.js'
import { sanitizeChartSpec } from '../lib/sanitizeChartSpec.js'
import { sanitizeMapSpec } from '../lib/sanitizeMapSpec.js'
import { resolveMapSpec } from '../lib/mapSpec.js'
import { toolLabel } from './toolLabel.js'
import { parseAutomationInput } from '../lib/automationStep.js'
import { joinThinking } from '../lib/thinkingText.js'

// Rebuild ConversationTurn[] from a Cortex thread's persisted messages so a
// reopened thread renders identically to a freshly streamed one.
//
// The critical detail: Cortex stores `message_payload` as a JSON *string*, e.g.
//   "{\"content\":[{\"text\":\"...\",\"type\":\"text\"}],\"role\":\"assistant\"}"
// It must be JSON.parse'd before use. (The previous implementation treated the
// string as the message body and dumped raw JSON into the bubble.) Once parsed,
// `content[]` is an ordered list of typed items — the same shapes the live SSE
// stream produces — which we fold into a single ConversationTurn.
export function reconstructTurns(messages: ThreadMessage[]): ConversationTurn[] {
  const ordered = sortThreadMessages(messages)
  return ordered.map((m) => {
    const base: ConversationTurn = {
      id: String(m.message_id),
      role: m.role,
      messageId: m.message_id,
      steps: [],
      text: '',
      citations: [],
      artifacts: [],
      status: 'done',
    }

    let payload: any
    try {
      payload = typeof m.message_payload === 'string'
        ? JSON.parse(m.message_payload)
        : m.message_payload
    } catch {
      // Malformed payload — leave the turn with empty text rather than dumping
      // the raw JSON string into the UI (the original bug).
      return base
    }

    const content = payload?.content
    // Some payloads are just a bare string or {text}.
    if (!Array.isArray(content)) {
      base.text = typeof payload === 'string'
        ? payload
        : (typeof payload?.text === 'string' ? payload.text : '')
      return base
    }

    const steps: ThinkingStep[] = []
    const artifacts: Artifact[] = []
    const citations: Citation[] = []
    let text = ''
    let suggestions: string[] | undefined
    const thinkingByIndex = new Map<number, string>()

    for (const item of content) {
      switch (item?.type) {
        case 'thinking': {
          // No persisted fixture has ever shown a real content_index on a stored thinking
          // item, so ordinal position is a best-effort stand-in — it still preserves the core
          // property that each item gets its own map slot, so an empty later item can't
          // overwrite an earlier real one.
          const t = item.thinking?.text
          if (typeof t === 'string') thinkingByIndex.set(thinkingByIndex.size, t)
          break
        }
        case 'text':
          if (typeof item.text === 'string') text += item.text
          // Cortex persists the same {annotations: [...]} shape the live terminal
          // response.text event carries - see agent-run-citations-sse.txt.
          if (Array.isArray(item.annotations)) {
            citations.push(...annotationsToCitations(item.annotations, item.content_index))
          }
          break
        case 'tool_use': {
          const tu = item.tool_use ?? {}
          const toolType: string = tu.type ?? tu.name ?? 'tool'
          // Persisted SQL tools (e.g. system_execute_sql) carry the query on the
          // input; detect by presence rather than a fixed tool-name list.
          const sql: string | undefined = tu.input?.sql ?? tu.input?.query
          const step: ThinkingStep = {
            id: tu.tool_use_id ?? uuid(),
            toolType,
            status: 'done',
            label: toolLabel(toolType),
          }
          if (sql) step.sql = sql
          const automation = parseAutomationInput(toolType, tu.input)
          if (automation) step.automation = automation
          steps.push(step)
          break
        }
        case 'tool_result': {
          const tr = item.tool_result ?? {}
          const id = tr.tool_use_id
          const errored = tr.status === 'error'
          const s = steps.find((st) => st.id === id)
          if (s) s.status = errored ? 'error' : 'done'
          break
        }
        case 'chart': {
          const spec = item.chart?.chart_spec
          try {
            const parsed = typeof spec === 'string' ? JSON.parse(spec) : spec
            const asMap = resolveMapSpec(parsed)
            if (asMap) {
              const cleaned = sanitizeMapSpec(asMap)
              if (cleaned) artifacts.push({ id: uuid(), type: 'map', spec: cleaned })
            } else {
              const cleaned = sanitizeChartSpec(parsed)
              if (cleaned) artifacts.push({ id: uuid(), type: 'chart', spec: cleaned })
            }
          } catch { /* skip an unparseable chart spec */ }
          break
        }
        case 'map': {
          const spec = item.map?.map_spec
          try {
            const parsed = typeof spec === 'string' ? JSON.parse(spec) : spec
            const cleaned = sanitizeMapSpec(resolveMapSpec(parsed) ?? parsed)
            if (cleaned) artifacts.push({ id: uuid(), type: 'map', spec: cleaned })
          } catch { /* skip an unparseable map spec */ }
          break
        }
        case 'table': {
          // Reuse the live-stream table parser so rowType/data shapes match.
          const parsed = parseTable(item.table ?? {})
          if (parsed.kind === 'table') {
            artifacts.push({
              id: uuid(), type: 'table', rowType: parsed.rowType, data: parsed.data,
              queryId: parsed.queryId, numRows: parsed.numRows, title: parsed.title,
            })
          }
          break
        }
        case 'suggested_queries': {
          suggestions = extractSuggestions(item.suggested_queries)
          break
        }
        // Tolerant fallback only - the confirmed persisted shape is annotations nested inside
        // the 'text' item above (see agent-run-citations-sse.txt / thread-describe-citations.json).
        // No fixture has ever shown Cortex persisting a standalone {type:'annotation'} content
        // item; kept in case that assumption is wrong, so citations degrade rather than vanish.
        case 'annotation': {
          const a = item.annotation ?? {}
          citations.push({
            index: typeof item.annotation_index === 'number' ? item.annotation_index : citations.length + 1,
            docTitle: a.doc_title,
            docId: a.doc_id,
            url: toCitationUrl(a.doc_id),
            text: a.text,
            searchResultId: a.search_result_id,
            contentIndex: item.content_index,
          })
          break
        }
      }
    }

    const thinking = joinThinking(thinkingByIndex)

    return {
      ...base,
      steps,
      text,
      artifacts,
      citations: mergeCitations([], citations),
      ...(suggestions?.length ? { suggestions } : {}),
      ...(thinking ? { thinking } : {}),
    }
  })
}
