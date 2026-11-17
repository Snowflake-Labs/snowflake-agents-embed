// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { parseSseEvent, streamAgentRun } from './agentRun'
import { escapeMarkdownLabel } from './sseParser'
import { setHostAdapter, resetHostAdapter, type HostAdapter } from '../host/hostAdapter'
import { setFeatureFlags, resetFeatureFlags } from '../lib/featureFlags'
import type { FileAttachment } from '../types'

// A minimal fixture adapter so streamAgentRun has somewhere to send requests. The two
// host-shaped adapters below (mirroring tab's and ui's real host/hostAdapter.ts) exist to
// prove streamAgentRun actually defers to whatever adapter is set, rather than to
// re-verify each host's own header logic — that's covered by each host's own
// host/hostAdapter.test.ts.
const fakeAdapter: HostAdapter = {
  baseUrl: () => '',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
}

beforeEach(() => { setHostAdapter(fakeAdapter) })
afterEach(() => { resetHostAdapter() })

describe('parseSseEvent', () => {
  it('parses response.text.delta', () => {
    expect(parseSseEvent('response.text.delta', '{"text":"hello","content_index":3}'))
      .toEqual({ kind: 'text.delta', text: 'hello', contentIndex: 3 })
  })
  it('defaults contentIndex to 0 when the event omits content_index', () => {
    expect(parseSseEvent('response.text.delta', '{"text":"hello"}'))
      .toEqual({ kind: 'text.delta', text: 'hello', contentIndex: 0 })
  })
  it('parses response.tool_use (no input → sql undefined)', () => {
    const r = parseSseEvent('response.tool_use', '{"tool_use_id":"t1","type":"cortex_analyst_text_to_sql","name":"analyst"}')
    expect(r).toMatchObject({ kind: 'tool_use', id: 't1', toolType: 'cortex_analyst_text_to_sql' })
  })
  it('parses response.chart (chart_spec is a string)', () => {
    const r = parseSseEvent('response.chart', '{"chart_spec":"{\\"mark\\":\\"bar\\"}"}')
    expect(r).toEqual({ kind: 'chart', spec: { mark: 'bar' } })
  })
  it('parses response.map (map_spec is a JSON string, never a Vega chart)', () => {
    const mapSpec = {
      version: 1,
      layer: { type: 'latlon', encoding: { latColumn: 'lat', lonColumn: 'lon' }, styling: {} },
      data: { values: [{ lat: 1, lon: 2 }] },
    }
    const r = parseSseEvent('response.map', JSON.stringify({ map_spec: JSON.stringify(mapSpec), tool_use_id: 'toolu_m1' }))
    expect(r).toEqual({ kind: 'map', spec: mapSpec, toolUseId: 'toolu_m1' })
  })
  it('routes a MapSpec that arrived on response.chart to kind map', () => {
    const mapSpec = {
      version: 1,
      layer: { type: 'latlon', encoding: { latColumn: 'lat', lonColumn: 'lon' }, styling: {} },
      data: { values: [] },
    }
    const r = parseSseEvent('response.chart', JSON.stringify({ chart_spec: JSON.stringify(mapSpec) }))
    expect(r).toMatchObject({ kind: 'map', spec: { version: 1, layer: { type: 'latlon' } } })
  })
  it('skips a map event whose spec is not a MapSpec', () => {
    expect(parseSseEvent('response.map', '{"map_spec":"{\\"mark\\":\\"bar\\"}"}')).toBeNull()
    expect(parseSseEvent('response.map', '{"map_spec":"not-json"}')).toBeNull()
  })
  it('skips a chart event whose spec is not a sanitizable object', () => {
    expect(parseSseEvent('response.chart', '{"chart_spec":"\\"not-an-object\\""}')).toBeNull()
    expect(parseSseEvent('response.chart', '{"chart_spec":"not-json"}')).toBeNull()
  })
  it('parses metadata thread ids', () => {
    expect(parseSseEvent('metadata', '{"thread_id":42,"message_id":7}'))
      .toMatchObject({ kind: 'metadata', threadId: 42, messageId: 7 })
  })
  it('parses the nested role-tagged metadata shape Cortex actually sends', () => {
    // Regression guard for HAR teams-8: the id is nested under `metadata` and role-tagged.
    expect(parseSseEvent('metadata', '{"metadata":{"message_id":287067024287750,"role":"assistant"}}'))
      .toMatchObject({ kind: 'metadata', messageId: 287067024287750, role: 'assistant' })
    expect(parseSseEvent('metadata', '{"metadata":{"message_id":287067024287238,"role":"user"}}'))
      .toMatchObject({ kind: 'metadata', messageId: 287067024287238, role: 'user' })
  })
  it('parses response.warning with its code/message', () => {
    expect(parseSseEvent('response.warning', '{"code":"003001","message":"User authentication required for MCP server."}'))
      .toEqual({ kind: 'warning', code: '003001', message: 'User authentication required for MCP server.' })
  })
  it('parses response.warning with no payload as an empty warning', () => {
    expect(parseSseEvent('response.warning', '{}')).toEqual({ kind: 'warning', code: undefined, message: undefined })
  })
  it('parses response.tool_use with SQL input', () => {
    const r = parseSseEvent(
      'response.tool_use',
      '{"tool_use_id":"t2","name":"cortex_analyst_text_to_sql","input":{"query":"SELECT * FROM sales"}}',
    )
    expect(r).toEqual({ kind: 'tool_use', id: 't2', toolType: 'cortex_analyst_text_to_sql', sql: 'SELECT * FROM sales', input: { query: 'SELECT * FROM sales' } })
  })
  it('parses response.tool_use without SQL for non-SQL tools', () => {
    const r = parseSseEvent(
      'response.tool_use',
      '{"tool_use_id":"t3","name":"cortex_search","input":{"query":"revenue"}}',
    )
    expect(r).toEqual({ kind: 'tool_use', id: 't3', toolType: 'cortex_search', sql: undefined, input: { query: 'revenue' } })
  })
  it('parses final response with follow_up_suggestions', () => {
    const r = parseSseEvent(
      'response',
      '{"metadata":{"thread_id":5},"follow_up_suggestions":["Tell me more","Break it down by region"]}',
    )
    expect(r).toEqual({
      kind: 'final',
      threadId: 5,
      messageId: undefined,
      suggestions: ['Tell me more', 'Break it down by region'],
    })
  })
  it('parses final response without suggestions', () => {
    const r = parseSseEvent('response', '{"metadata":{"thread_id":10,"message_id":3}}')
    expect(r).toEqual({ kind: 'final', threadId: 10, messageId: 3, suggestions: undefined })
  })
  it('parses response.table from the real result_set shape', () => {
    const payload = JSON.stringify({
      content_index: 8,
      result_set: {
        data: [['2026-05-01', '2026', '37624.73'], ['2026-04-01', '2026', '250665.83']],
        resultSetMetaData: { rowType: [{ name: 'MONTH' }, { name: 'YEAR' }, { name: 'GMV_GBP' }] },
      },
    })
    const r = parseSseEvent('response.table', payload)
    expect(r).toEqual({
      kind: 'table',
      rowType: [{ name: 'MONTH' }, { name: 'YEAR' }, { name: 'GMV_GBP' }],
      data: [['2026-05-01', '2026', '37624.73'], ['2026-04-01', '2026', '250665.83']],
      queryId: undefined,
      numRows: undefined,
      title: undefined,
    })
  })
  it('parses response.table query_id/numRows/title alongside data', () => {
    const payload = JSON.stringify({
      query_id: '01c5f24c-0003-b25f-0001-05160b5b0a2e',
      title: 'Total Sales by Region',
      tool_use_id: 'toolu_x',
      result_set: {
        data: [['Central', '1720554.00']],
        resultSetMetaData: { numRows: 1, rowType: [{ name: 'REGION' }, { name: 'TOTAL_SALES' }] },
      },
    })
    const r = parseSseEvent('response.table', payload)
    expect(r).toMatchObject({ kind: 'table', queryId: '01c5f24c-0003-b25f-0001-05160b5b0a2e', title: 'Total Sales by Region', numRows: 1 })
  })
  it('parses response.tool_result.status as narration', () => {
    const r = parseSseEvent(
      'response.tool_result.status',
      '{"message":"Running Sales_Analyst","status":"executing_tool","tool_use_id":"tooluse_1"}',
    )
    expect(r).toEqual({ kind: 'tool_result.status', id: 'tooluse_1', message: 'Running Sales_Analyst' })
  })
  it('parses response.suggested_queries as a standalone event', () => {
    const r = parseSseEvent(
      'response.suggested_queries',
      '{"suggested_queries":[{"query":"How does profit compare?"},"Plain string query"]}',
    )
    expect(r).toEqual({ kind: 'suggested_queries', suggestions: ['How does profit compare?', 'Plain string query'] })
  })
  it('parses response.thinking (consolidated, non-delta) as a full replacement text', () => {
    const r = parseSseEvent('response.thinking', '{"thinking":{"text":"This looks like a verified query."}}')
    expect(r).toEqual({ kind: 'thinking', text: 'This looks like a verified query.', contentIndex: 0 })
  })
  it('parses an empty/signature-only response.thinking at a non-zero content_index (regression: later tool rounds send empty thinking)', () => {
    const r = parseSseEvent('response.thinking', '{"thinking":{"text":""},"content_index":3}')
    expect(r).toEqual({ kind: 'thinking', text: '', contentIndex: 3 })
  })
  it('parses response.thinking.delta carrying its own content_index', () => {
    const r = parseSseEvent('response.thinking.delta', '{"text":"Let me get a better understanding.","content_index":0}')
    expect(r).toEqual({ kind: 'thinking.delta', text: 'Let me get a better understanding.', contentIndex: 0 })
  })
  it('parses response.text (consolidated, non-delta) as a full replacement for its content index', () => {
    const r = parseSseEvent('response.text', '{"text":"The Central region leads.","content_index":16}')
    expect(r).toEqual({ kind: 'text', text: 'The Central region leads.', contentIndex: 16 })
  })
  it('parses response.tool_result carrying query_id/sql/verified_query_used for a SQL tool', () => {
    const r = parseSseEvent(
      'response.tool_result',
      JSON.stringify({
        tool_use_id: 't1',
        status: 'success',
        content: [{ type: 'json', json: { query_id: 'q1', sql: 'SELECT 1', verified_query_used: true } }],
      }),
    )
    expect(r).toEqual({ kind: 'tool_result', id: 't1', status: 'success', queryId: 'q1', sql: 'SELECT 1', verifiedQueryUsed: true, semanticModelName: undefined })
  })
  it('parses response.tool_result carrying semantic_model_name for a semantic-context tool', () => {
    const r = parseSseEvent(
      'response.tool_result',
      JSON.stringify({
        tool_use_id: 't2',
        status: 'success',
        content: [{ type: 'json', json: { semantic_model_name: 'sales_semantic_model' } }],
      }),
    )
    expect(r).toEqual({ kind: 'tool_result', id: 't2', status: 'success', queryId: undefined, sql: undefined, verifiedQueryUsed: undefined, semanticModelName: 'sales_semantic_model' })
  })
  it('parses response.chart carrying tool_use_id', () => {
    const r = parseSseEvent('response.chart', '{"chart_spec":"{\\"mark\\":\\"bar\\"}","tool_use_id":"toolu_c1"}')
    expect(r).toEqual({ kind: 'chart', spec: { mark: 'bar' }, toolUseId: 'toolu_c1' })
  })
  it('parses error with request_id (the one confirmed occurrence in practice)', () => {
    const r = parseSseEvent('error', '{"code":"399518","message":"thread_id must be provided","request_id":"aa8e6f4b"}')
    expect(r).toEqual({ kind: 'error', code: '399518', message: 'thread_id must be provided', requestId: 'aa8e6f4b' })
  })
  it('reports an unrecognised event name instead of returning null', () => {
    expect(parseSseEvent('response.future', '{"ok":true}')).toEqual({ kind: 'unknown', event: 'response.future' })
  })
  it('reports a JSON parse failure instead of returning null', () => {
    expect(parseSseEvent('response.text', 'not-json')).toEqual({ kind: 'parse_failure', event: 'response.text' })
  })
})

describe('parseSseStream residual buffer and cancel', () => {
  it('parses a final unterminated data line after the reader is done', async () => {
    const { parseSseStream } = await import('./sseParser.js')
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.text.delta\ndata: {"text":"tail"}'))
        controller.close()
      },
    })
    const events = []
    for await (const e of parseSseStream(new Response(body))) events.push(e)
    expect(events).toEqual([{ kind: 'text.delta', text: 'tail', contentIndex: 0 }])
  })

  it('cancels the body reader when the consumer stops iterating', async () => {
    const { parseSseStream } = await import('./sseParser.js')
    let cancelled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.text.delta\ndata: {"text":"a"}\n\n'))
      },
      cancel() { cancelled = true },
    })
    const gen = parseSseStream(new Response(body))
    await gen.next()
    await gen.return?.(undefined)
    expect(cancelled).toBe(true)
  })

  it('ignores SSE comment ping lines', async () => {
    const { parseSseStream } = await import('./sseParser.js')
    const body = ':ping\n\nevent: response.text.delta\ndata: {"text":"hi"}\n\n'
    const events = []
    for await (const e of parseSseStream(new Response(body))) events.push(e)
    expect(events).toEqual([{ kind: 'text.delta', text: 'hi', contentIndex: 0 }])
  })

  it('throws StreamStallError when no bytes arrive within the stall bound', async () => {
    vi.useFakeTimers()
    const { parseSseStream, StreamStallError } = await import('./sseParser.js')
    const body = new ReadableStream({
      start() { /* never enqueue */ },
    })
    const pending = (async () => {
      const events = []
      for await (const e of parseSseStream(new Response(body), { stallTimeoutMs: 45_000 })) events.push(e)
      return events
    })()
    const expectation = expect(pending).rejects.toBeInstanceOf(StreamStallError)
    await vi.advanceTimersByTimeAsync(45_000)
    await expectation
    vi.useRealTimers()
  })
})

describe('streamAgentRun request body', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function mockStream() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: response\ndata: {}\n\n', {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  async function drain(gen: AsyncGenerator<unknown>) { for await (const _ of gen) { /* consume */ } }

  it('includes thread_id and parent_message_id on a continuing turn', async () => {
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi', threadId: 42, parentMessageId: 7 }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.thread_id).toBe(42)
    expect(body.parent_message_id).toBe(7)
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('sends thread_id with parent_message_id=0 on the opening turn (Cortex requires it)', async () => {
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi', threadId: 99 }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.thread_id).toBe(99)
    expect(body.parent_message_id).toBe(0)
  })

  it('omits thread fields entirely when there is no thread (stateless fallback)', async () => {
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.thread_id).toBeUndefined()
    expect(body.parent_message_id).toBeUndefined()
  })

  it('includes tool_choice when passed', async () => {
    const fetchMock = mockStream()
    await drain(streamAgentRun({
      snowflakeToken: 'tok', query: 'hi', toolChoice: { type: 'tool', name: ['system_execute_sql'] },
    }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.tool_choice).toEqual({ type: 'tool', name: ['system_execute_sql'] })
  })

  it('omits tool_choice when not passed', async () => {
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.tool_choice).toBeUndefined()
  })

  it('sends the experimental reasoning-agent block when extendedThinking is true', async () => {
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi', extendedThinking: true }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.experimental).toEqual(expect.objectContaining({
      EnableClientSideDateFormatting: true,
      EnableAnswerBeforeProactiveChartGeneration: true,
      UserTimezone: expect.any(String),
      reasoningAgentFlowType: 'simple',
      reasoningAgentToolConfig: { orchestrationType: 'reasoning' },
    }))
    expect(body.thinking).toBeUndefined()
  })

  it('sends date/chart experimental flags and omits thinking when extendedThinking is off', async () => {
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi', extendedThinking: false }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.experimental).toEqual({
      EnableClientSideDateFormatting: true,
      EnableAnswerBeforeProactiveChartGeneration: true,
      UserTimezone: body.experimental.UserTimezone,
    })
    expect(body.thinking).toBeUndefined()

    const fetchMock2 = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' }))
    const body2 = JSON.parse((fetchMock2.mock.calls[0][1] as RequestInit).body as string)
    expect(body2.experimental).toEqual({
      EnableClientSideDateFormatting: true,
      EnableAnswerBeforeProactiveChartGeneration: true,
      UserTimezone: body2.experimental.UserTimezone,
    })
    expect(body2.thinking).toBeUndefined()
  })
})

describe('streamAgentRun retry-before-first-token', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  async function drain(gen: AsyncGenerator<unknown>) { for await (const _ of gen) { /* consume */ } }

  const okStream = () => new Response('event: response\ndata: {}\n\n', {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  })

  it('retries a 429 once with backoff, then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(okStream())
    vi.stubGlobal('fetch', fetchMock)

    const drainPromise = drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' }))
    await vi.advanceTimersByTimeAsync(500)
    await drainPromise

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after exhausting retries on a persistent 5xx', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const drainPromise = drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' })).catch((e) => e)
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(1500)
    const err: any = await drainPromise

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(err.status).toBe(503)
  })

  it('does not retry a bare 500', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' })))
      .rejects.toMatchObject({ status: 500 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honours Retry-After seconds on 429 instead of the fixed ladder', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(okStream())
    vi.stubGlobal('fetch', fetchMock)

    const drainPromise = drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' }))
    await vi.advanceTimersByTimeAsync(2000)
    await drainPromise

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a plain 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' })))
      .rejects.toMatchObject({ status: 400 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborting mid-backoff rejects with AbortError and issues no further fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const drainPromise = drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi', signal: controller.signal })).catch((e) => e)
    // Real timers here: let the first fetch resolve and the backoff's abort listener
    // register, then abort before its (real, 500ms) setTimeout would ever fire.
    await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    const err: any = await drainPromise

    expect(err.name).toBe('AbortError')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('streamAgentRun attachments', () => {
  beforeEach(() => { setFeatureFlags({ fileUpload: true, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false }) })
  afterEach(() => { vi.restoreAllMocks(); resetFeatureFlags() })

  function mockStream() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: response\ndata: {}\n\n', {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  async function drain(gen: AsyncGenerator<unknown>) { for await (const _ of gen) { /* consume */ } }

  it('sends attachments as a typed field, not interpolated into the query', async () => {
    const fetchMock = mockStream()
    const attachments: FileAttachment[] = [
      { name: 'report.csv', mimeType: 'text/csv', data: 'a,b\n1,2', sizeBytes: 7 },
    ]
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi', attachments }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'hi' }])
    expect(body.attachments).toEqual([{ name: 'report.csv', data: 'a,b\n1,2' }])
  })

  it('sends multiple text attachments together', async () => {
    const fetchMock = mockStream()
    const attachments: FileAttachment[] = [
      { name: 'a.txt', mimeType: 'text/plain', data: 'alpha', sizeBytes: 5 },
      { name: 'b.txt', mimeType: 'text/plain', data: 'beta', sizeBytes: 4 },
    ]
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi', attachments }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.attachments).toEqual([
      { name: 'a.txt', data: 'alpha' },
      { name: 'b.txt', data: 'beta' },
    ])
  })

  it('omits the attachments field when the fileUpload flag is off', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    const fetchMock = mockStream()
    const attachments: FileAttachment[] = [
      { name: 'report.csv', mimeType: 'text/csv', data: 'a,b', sizeBytes: 3 },
    ]
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi', attachments }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'hi' }])
    expect(body.attachments).toBeUndefined()
  })
})

describe('streamAgentRun experimental flags', () => {
  afterEach(() => { vi.restoreAllMocks(); resetFeatureFlags() })

  function mockStream() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: response\ndata: {}\n\n', {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  async function drain(gen: AsyncGenerator<unknown>) { for await (const _ of gen) { /* consume */ } }

  function bodyOf(fetchMock: ReturnType<typeof mockStream>) {
    return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
  }

  const allOff = { fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false }

  it('always sends the date/chart experimental flags', async () => {
    setFeatureFlags(allOff)
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' }))
    expect(bodyOf(fetchMock).experimental).toEqual({
      EnableClientSideDateFormatting: true,
      EnableAnswerBeforeProactiveChartGeneration: true,
      UserTimezone: bodyOf(fetchMock).experimental.UserTimezone,
    })
  })

  it('adds systemPromptInternal when a user name is passed', async () => {
    setFeatureFlags(allOff)
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi', currentUserName: 'Jordan Rivera' }))
    expect(bodyOf(fetchMock).experimental.systemPromptInternal.attributes.fullName).toBe('Jordan Rivera')
  })

  it('sends the native app\'s stream flags when nativeStreamFlags is on', async () => {
    setFeatureFlags({ ...allOff, nativeStreamFlags: true })
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' }))
    expect(bodyOf(fetchMock).experimental).toEqual(expect.objectContaining({
      EnableClientSideDateFormatting: true,
      EnableAnswerBeforeProactiveChartGeneration: true,
      enableStepTrace: true,
      enableAnalystStreaming: true,
      enableRelatedQueries: true,
      responseSchemaVersion: 'v2',
    }))
  })

  it('sends reasoning keys plus date/chart flags for extended thinking when the stream flag is off', async () => {
    setFeatureFlags(allOff)
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi', extendedThinking: true }))
    expect(bodyOf(fetchMock).experimental).toEqual(expect.objectContaining({
      EnableClientSideDateFormatting: true,
      EnableAnswerBeforeProactiveChartGeneration: true,
      reasoningAgentFlowType: 'simple',
      reasoningAgentToolConfig: { orchestrationType: 'reasoning' },
    }))
  })

  // Regression: both features write to `experimental`. Spreading two `experimental` keys into
  // one object literal would silently drop the first, so they have to merge.
  it('merges both groups rather than one overwriting the other', async () => {
    setFeatureFlags({ ...allOff, nativeStreamFlags: true })
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi', extendedThinking: true }))
    expect(bodyOf(fetchMock).experimental).toEqual(expect.objectContaining({
      EnableClientSideDateFormatting: true,
      EnableAnswerBeforeProactiveChartGeneration: true,
      enableStepTrace: true,
      enableAnalystStreaming: true,
      enableRelatedQueries: true,
      responseSchemaVersion: 'v2',
      reasoningAgentFlowType: 'simple',
      reasoningAgentToolConfig: { orchestrationType: 'reasoning' },
    }))
  })
})

describe('streamAgentRun defers auth to the active HostAdapter', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function mockStream() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: response\ndata: {}\n\n', {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  async function drain(gen: AsyncGenerator<unknown>) { for await (const _ of gen) { /* consume */ } }

  it('sends Authorization when the adapter is tab-shaped (direct-to-SPCS)', async () => {
    setHostAdapter({
      baseUrl: () => 'https://spcs.example',
      headers: (token, extra) => ({
        Authorization: `Snowflake Token="${token ?? ''}"`,
        'X-User-Access-Token': token ?? '',
        ...extra,
      }),
    })
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' }))
    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://spcs.example/api/agent/run')
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: 'Snowflake Token="tok"' })
  })

  it('sends Authorization when the adapter is ui-shaped (direct-to-SPCS)', async () => {
    setHostAdapter({
      baseUrl: () => 'https://spcs.example',
      headers: (token, extra) => ({
        Authorization: `Snowflake Token="${token ?? ''}"`,
        'X-User-Access-Token': token ?? '',
        ...extra,
      }),
    })
    const fetchMock = mockStream()
    await drain(streamAgentRun({ snowflakeToken: 'tok', query: 'hi' }))
    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://spcs.example/api/agent/run')
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Snowflake Token="tok"',
      'X-User-Access-Token': 'tok',
    })
  })
})

describe('escapeMarkdownLabel', () => {
  it('strips characters that would close or open a markdown link', () => {
    expect(escapeMarkdownLabel('Trusted](https://evil.example)(')).toBe('Trustedhttps://evil.example')
  })
})
