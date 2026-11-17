// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { reconstructTurns } from './reconstructTurns'
import type { ThreadMessage } from './threads'

// Fixtures mirror the shape of real Cortex thread-detail payloads. The key property under test: message_payload
// is a JSON *string* that must be parsed before use.

function msg(message_id: number, role: 'user' | 'assistant', payload: unknown): ThreadMessage {
  return { message_id, role, message_payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }
}

describe('reconstructTurns', () => {
  it('parses a user message from the JSON-string payload (not raw dumped)', () => {
    const turns = reconstructTurns([
      msg(1, 'user', { role: 'user', content: [{ type: 'text', text: 'show as bar chart' }] }),
    ])
    expect(turns[0]).toMatchObject({ id: '1', role: 'user', text: 'show as bar chart', status: 'done' })
    // Must NOT contain the raw JSON braces (the original bug).
    expect(turns[0].text).not.toContain('"content"')
  })

  it('reconstructs an assistant turn with a SQL step and a table artifact', () => {
    const payload = {
      role: 'assistant',
      schema_version: 'v2',
      status: 'completed',
      content: [
        { type: 'thinking', thinking: { text: 'Let me query the data.' } },
        {
          type: 'tool_use',
          tool_use: {
            name: 'system_execute_sql',
            type: 'system_execute_sql',
            tool_use_id: 'toolu_sql_1',
            input: { semantic_model: 'food_ops_analyst', sql: 'SELECT 1' },
          },
        },
        {
          type: 'tool_result',
          tool_result: { tool_use_id: 'toolu_sql_1', status: 'success', content: [{ json: {} }] },
        },
        { type: 'text', text: "Perfect! I've found 12 low-stock items.\n\n" },
        {
          type: 'table',
          table: {
            query_id: 'q1',
            title: 'Low stock',
            tool_use_id: 'toolu_sql_1',
            result_set: {
              data: [['SKU-019', '2.25']],
              resultSetMetaData: { rowType: [{ name: 'SKU', type: 'text' }, { name: 'PRICE', type: 'text' }] },
            },
          },
        },
        { type: 'text', text: '## Key Observations' },
        { type: 'suggested_queries', suggested_queries: [{ query: 'Which zones have the most gaps?' }] },
      ],
    }
    const [turn] = reconstructTurns([msg(2, 'assistant', payload)])

    expect(turn.text).toBe("Perfect! I've found 12 low-stock items.\n\n## Key Observations")
    expect(turn.thinking).toBe('Let me query the data.')
    expect(turn.steps).toHaveLength(1)
    expect(turn.steps[0]).toMatchObject({ id: 'toolu_sql_1', toolType: 'system_execute_sql', status: 'done', sql: 'SELECT 1' })

    const table = turn.artifacts.find((a) => a.type === 'table')
    expect(table).toBeDefined()
    expect(table).toMatchObject({
      type: 'table',
      rowType: [{ name: 'SKU', type: 'text' }, { name: 'PRICE', type: 'text' }],
      data: [['SKU-019', '2.25']],
    })

    expect(turn.suggestions).toEqual(['Which zones have the most gaps?'])
  })

  it('reconstructs a chart artifact by JSON-parsing chart_spec', () => {
    const spec = { $schema: 'https://vega.github.io/schema/vega-lite/v5.json', mark: 'bar' }
    const payload = {
      role: 'assistant',
      content: [
        { type: 'text', text: "Here's the bar chart:" },
        { type: 'chart', chart: { chart_spec: JSON.stringify(spec), tool_use_id: 'toolu_chart_1' } },
      ],
    }
    const [turn] = reconstructTurns([msg(3, 'assistant', payload)])
    const chart = turn.artifacts.find((a) => a.type === 'chart')
    expect(chart).toMatchObject({ type: 'chart', spec })
  })

  it('reconstructs a map artifact by JSON-parsing map_spec', () => {
    const spec = {
      version: 1 as const,
      title: 'Stores',
      layer: { type: 'latlon' as const, encoding: { latColumn: 'lat', lonColumn: 'lon' }, styling: {} },
      data: { values: [{ lat: 40.7, lon: -74 }] },
    }
    const payload = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here is the map:' },
        { type: 'map', map: { map_spec: JSON.stringify(spec), tool_use_id: 'toolu_map_1' } },
      ],
    }
    const [turn] = reconstructTurns([msg(3.1, 'assistant', payload)])
    const map = turn.artifacts.find((a) => a.type === 'map')
    expect(map).toMatchObject({ type: 'map', spec })
  })

  it('survives a thread reopen with citations intact (confirmed shape: annotations nested in the text item)', () => {
    const payload = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Per the docs, revenue grew.',
          annotations: [
            { doc_id: 'https://example.com/q3', doc_title: 'Q3 Report', search_result_id: 'cs_1', text: 'Revenue grew 12%.' },
          ],
        },
      ],
    }
    const [turn] = reconstructTurns([msg(3.5, 'assistant', payload)])
    expect(turn.citations).toEqual([{
      index: 1,
      docTitle: 'Q3 Report',
      docId: 'https://example.com/q3',
      url: 'https://example.com/q3',
      text: 'Revenue grew 12%.',
      searchResultId: 'cs_1',
      contentIndex: undefined,
    }])
  })

  it('falls back to a standalone annotation content item if that turns out to be the real persisted shape', () => {
    const payload = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Per the docs [1], revenue grew.' },
        { type: 'annotation', annotation: { doc_id: 'https://example.com/q3', doc_title: 'Q3 Report', search_result_id: 'cs_1' } },
      ],
    }
    const [turn] = reconstructTurns([msg(3.6, 'assistant', payload)])
    expect(turn.citations).toEqual([{
      index: 1,
      docTitle: 'Q3 Report',
      docId: 'https://example.com/q3',
      url: 'https://example.com/q3',
      text: undefined,
      searchResultId: 'cs_1',
      contentIndex: undefined,
    }])
  })

  it('marks a tool step as error when its tool_result status is error', () => {
    const payload = {
      role: 'assistant',
      content: [
        { type: 'tool_use', tool_use: { type: 'system_execute_sql', tool_use_id: 't1', input: { sql: 'SELECT 1' } } },
        { type: 'tool_result', tool_result: { tool_use_id: 't1', status: 'error' } },
      ],
    }
    const [turn] = reconstructTurns([msg(4, 'assistant', payload)])
    expect(turn.steps[0].status).toBe('error')
  })

  it('reconstructs a schedule_snowflake_task step with its automation info on reopen', () => {
    const payload = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          tool_use: {
            type: 'schedule_snowflake_task',
            tool_use_id: 't1',
            input: { action: 'setup', schedule: '0 9 * * *', target: 'nightly_refresh' },
          },
        },
      ],
    }
    const [turn] = reconstructTurns([msg(4.5, 'assistant', payload)])
    expect(turn.steps[0].automation).toEqual({ action: 'setup', schedule: '0 9 * * *', target: 'nightly_refresh' })
  })

  it('falls back to empty text on a malformed payload — never dumps raw JSON', () => {
    const turns = reconstructTurns([
      { message_id: 5, role: 'assistant', message_payload: '{ this is not valid json' },
    ])
    expect(turns[0].text).toBe('')
    expect(turns[0].status).toBe('done')
  })

  it('handles a JSON-encoded bare-string payload and a {text} payload', () => {
    const turns = reconstructTurns([
      { message_id: 6, role: 'assistant', message_payload: JSON.stringify('just a string') },
      { message_id: 7, role: 'assistant', message_payload: JSON.stringify({ text: 'top-level text' }) },
    ])
    expect(turns[0].text).toBe('just a string')
    expect(turns[1].text).toBe('top-level text')
  })

  it('orders turns chronologically even when Cortex returns them newest-first', () => {
    // Cortex returns messages newest-first; reconstructTurns must sort ascending.
    const turns = reconstructTurns([
      msg(288774, 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'newest' }] }),
      msg(288262, 'user', { role: 'user', content: [{ type: 'text', text: 'middle' }] }),
      msg(287246, 'user', { role: 'user', content: [{ type: 'text', text: 'oldest' }] }),
    ])
    expect(turns.map((t) => t.text)).toEqual(['oldest', 'middle', 'newest'])
    expect(turns[0].id).toBe('287246')
    expect(turns[turns.length - 1].id).toBe('288774')
  })

  // Regression mirroring useAgentStream's live-stream fix: the first thinking item per turn can
  // carry real narration, while ones after a subsequent tool round are reliably empty. Each
  // thinking item must get its own map slot (by ordinal position) so a later empty item can't
  // overwrite the earlier real one.
  it('keeps real thinking text from the first block after a later empty thinking block', () => {
    const payload = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: { text: 'This question looks like a verified query.' } },
        { type: 'tool_use', tool_use: { type: 'system_execute_sql', tool_use_id: 't1', input: { sql: 'SELECT 1' } } },
        { type: 'tool_result', tool_result: { tool_use_id: 't1', status: 'success' } },
        { type: 'thinking', thinking: { text: '' } },
        { type: 'text', text: 'Here is the answer.' },
      ],
    }
    const [turn] = reconstructTurns([msg(8, 'assistant', payload)])
    expect(turn.thinking).toBe('This question looks like a verified query.')
  })

  it('leaves thinking undefined when every thinking block is empty', () => {
    const payload = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: { text: '' } },
        { type: 'thinking', thinking: { text: '' } },
        { type: 'text', text: 'Here is the answer.' },
      ],
    }
    const [turn] = reconstructTurns([msg(9, 'assistant', payload)])
    expect(turn.thinking).toBeUndefined()
  })

  it('orders by created_on when message_ids are not monotonic across roles', () => {
    const m = (id: number, role: 'user' | 'assistant', created_on: number, text: string): ThreadMessage =>
      ({ ...msg(id, role, { role, content: [{ type: 'text', text }] }), created_on })
    const turns = reconstructTurns([
      m(287067024428570, 'assistant', 4, 'A2'),
      m(287067024430094, 'user', 3, 'U2'),
      m(287067024428566, 'assistant', 2, 'A1'),
      m(287067024430090, 'user', 1, 'U1'),
    ])
    expect(turns.map((t) => t.text)).toEqual(['U1', 'A1', 'U2', 'A2'])
  })
})
