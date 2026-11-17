// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { tableToMarkdown, turnToMarkdown, threadToMarkdown } from './turn-markdown'
import type { ConversationTurn } from '../types'

function turn(partial: Partial<ConversationTurn>): ConversationTurn {
  return {
    id: 't', role: 'assistant', steps: [], text: '',
    citations: [], artifacts: [], status: 'done', ...partial,
  }
}

const REGION_COLS = [{ name: 'REGION', type: 'TEXT' }, { name: 'SALES', type: 'FIXED' }]

describe('tableToMarkdown', () => {
  it('renders a pipe table with a header separator', () => {
    expect(tableToMarkdown(REGION_COLS, [['Central', 1000], ['South', 500]])).toBe(
      '| REGION | SALES |\n| --- | --- |\n| Central | 1000 |\n| South | 500 |',
    )
  })

  it('escapes pipes and flattens newlines so a cell cannot break the table', () => {
    const md = tableToMarkdown([{ name: 'NOTE', type: 'TEXT' }], [['a|b'], ['line1\nline2']])
    expect(md).toContain('| a\\|b |')
    expect(md).toContain('| line1 line2 |')
    expect(md.split('\n')).toHaveLength(4) // header, separator, 2 rows — no row split in two
  })

  it('renders empty cells for null/undefined', () => {
    expect(tableToMarkdown(REGION_COLS, [[null, undefined]])).toContain('|  |  |')
  })

  it('caps rows and says how many were dropped', () => {
    const data = Array.from({ length: 250 }, (_, i) => ['R', i])
    const md = tableToMarkdown(REGION_COLS, data)
    expect(md.split('\n').filter((l) => l.startsWith('| R |'))).toHaveLength(100)
    expect(md).toContain('_Showing 100 of 250 rows_')
  })

  it('reports Cortex numRows when the payload was already truncated upstream', () => {
    expect(tableToMarkdown(REGION_COLS, [['Central', 1]], 9000)).toContain('_Showing 1 of 9000 rows_')
  })

  it('returns empty string with no columns', () => {
    expect(tableToMarkdown([], [[1]])).toBe('')
  })
})

describe('turnToMarkdown', () => {
  it('keeps the prose and puts the table under it — the whole point of the rich copy', () => {
    const md = turnToMarkdown(turn({
      text: 'Here are the total sales by region:',
      artifacts: [{ id: 'a1', type: 'table', rowType: REGION_COLS, data: [['Central', 1000]] }],
    }))
    expect(md).toBe(
      'Here are the total sales by region:\n\n| REGION | SALES |\n| --- | --- |\n| Central | 1000 |',
    )
  })

  it('labels a table that has a title', () => {
    const md = turnToMarkdown(turn({
      artifacts: [{ id: 'a1', type: 'table', rowType: REGION_COLS, data: [], title: 'Sales by region' }],
    }))
    expect(md).toContain('**Sales by region**')
  })

  it('notes charts by title rather than dumping the Vega-Lite spec', () => {
    const md = turnToMarkdown(turn({
      artifacts: [{ id: 'c1', type: 'chart', spec: { mark: 'bar', title: 'Sales by region' } as any }],
    }))
    expect(md).toBe('_[Chart: Sales by region]_')
    expect(md).not.toContain('mark')
  })

  it('falls back to a generic chart note when the spec has no title', () => {
    const md = turnToMarkdown(turn({ artifacts: [{ id: 'c1', type: 'chart', spec: { mark: 'bar' } as any }] }))
    expect(md).toBe('_[Chart: see Snowflake Agents Embed for the chart]_')
  })

  it('notes maps by title rather than dumping MapSpec', () => {
    const md = turnToMarkdown(turn({
      artifacts: [{
        id: 'm1', type: 'map',
        spec: { version: 1, title: 'Stores', layer: { type: 'latlon', encoding: {} }, data: { values: [] } },
      }],
    }))
    expect(md).toBe('_[Map: Stores]_')
    expect(md).not.toContain('latlon')
  })

  it('reads a Vega-Lite {title:{text}} title', () => {
    const md = turnToMarkdown(turn({
      artifacts: [{ id: 'c1', type: 'chart', spec: { title: { text: 'Profit' } } as any }],
    }))
    expect(md).toBe('_[Chart: Profit]_')
  })

  it('appends every SQL step in a fence only when asked', () => {
    const t = turn({
      text: 'Done.',
      steps: [
        { id: 's1', toolType: 'system_execute_sql', status: 'done', label: 'SQL', sql: 'SELECT 1' },
        { id: 's2', toolType: 'system_execute_sql', status: 'done', label: 'SQL', sql: 'SELECT 2' },
        { id: 's3', toolType: 'cortex_search', status: 'done', label: 'Search' },
      ],
    })
    expect(turnToMarkdown(t)).toBe('Done.')
    const withSql = turnToMarkdown(t, { includeSql: true })
    expect(withSql).toBe('Done.\n\n```sql\nSELECT 1\n```\n\n```sql\nSELECT 2\n```')
  })

  it('drops the leading blank lines Cortex puts on its closing block', () => {
    expect(turnToMarkdown(turn({ text: '\n\nThe Central region leads.' })))
      .toBe('The Central region leads.')
  })

  it('collapses the blank-line run left where an inline table used to sit', () => {
    // Real shape from test/fixtures/agent-run-sse.txt: block 12 ends "\n\n", block 14 is "\n\n",
    // block 16 starts "\n\n" — six newlines once the table between them moves below the prose.
    expect(turnToMarkdown(turn({ text: 'Here are the sales:\n\n\n\n\n\nCentral leads.' })))
      .toBe('Here are the sales:\n\nCentral leads.')
  })
})

describe('threadToMarkdown', () => {
  it('renders the thread oldest-first with a title heading', () => {
    const md = threadToMarkdown([
      turn({ id: '1', role: 'user', text: 'What are sales by region?' }),
      turn({ id: '2', text: 'Central leads.' }),
      turn({ id: '3', role: 'user', text: 'And profit?' }),
      turn({ id: '4', text: 'South is thinnest.' }),
    ], { title: 'Regional Sales and Profit Breakdown' })

    expect(md).toBe([
      '# Regional Sales and Profit Breakdown',
      '**You:** What are sales by region?',
      '**Snowflake Agents Embed:**\n\nCentral leads.',
      '**You:** And profit?',
      '**Snowflake Agents Embed:**\n\nSouth is thinnest.',
    ].join('\n\n'))
  })

  it('skips failed turns and empty answers', () => {
    const md = threadToMarkdown([
      turn({ id: '1', role: 'user', text: 'q' }),
      turn({ id: '2', status: 'error', text: 'partial', errorMessage: 'Cortex timed out' }),
      turn({ id: '3', text: '' }),
    ])
    expect(md).toBe('**You:** q')
    expect(md).not.toContain('Cortex timed out')
  })

  it('carries includeSql through to each turn', () => {
    const md = threadToMarkdown(
      [turn({ text: 'ok', steps: [{ id: 's1', toolType: 'system_execute_sql', status: 'done', label: 'SQL', sql: 'SELECT 1' }] })],
      { includeSql: true },
    )
    expect(md).toContain('```sql\nSELECT 1\n```')
  })

  it('returns an empty string for an empty thread', () => {
    expect(threadToMarkdown([])).toBe('')
  })

  it('uses a host productName for the speaker label and untitled chart notes', () => {
    const md = threadToMarkdown(
      [turn({
        text: 'See below.',
        artifacts: [{ id: 'c1', type: 'chart', spec: { mark: 'bar' } as any }],
      })],
      { productName: 'Snowflake Agent for Teams (Unofficial)' },
    )
    expect(md).toBe(
      '**Snowflake Agent for Teams (Unofficial):**\n\nSee below.\n\n_[Chart: see Snowflake Agent for Teams (Unofficial) for the chart]_',
    )
  })
})
