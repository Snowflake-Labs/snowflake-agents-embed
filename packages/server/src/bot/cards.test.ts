// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { buildSummaryCard, buildStarterPromptsCard, escapeCardText } from './cards.js'

describe('buildSummaryCard', () => {
  it('includes summary text and deep link action', () => {
    const card = buildSummaryCard({
      summary: 'Revenue dropped 12% in Q4.',
      deepLink: 'https://teams.microsoft.com/l/entity/abc/agents-tab',
    })
    const body = card.content.body as any[]
    expect(body.some((b: any) => b.text?.includes('Revenue dropped'))).toBe(true)
    const actions = card.content.actions as any[]
    expect(actions[0].url).toContain('teams.microsoft.com')
  })

  it('renders title as bold header when provided', () => {
    const card = buildSummaryCard({
      title: 'Q1 Sales Review',
      summary: 'Sales were up.',
      deepLink: 'https://teams.microsoft.com/l/entity/abc/agents-tab',
    })
    const body = card.content.body as any[]
    const titleBlock = body.find((b: any) => b.text === 'Q1 Sales Review')
    expect(titleBlock).toBeDefined()
    expect(titleBlock.weight).toBe('Bolder')
  })

  it('renders question when provided', () => {
    const card = buildSummaryCard({
      question: 'What were last quarter sales?',
      summary: 'Sales were $2.5M.',
      deepLink: 'https://teams.microsoft.com/l/entity/abc/agents-tab',
    })
    const body = card.content.body as any[]
    const qBlock = body.find((b: any) => typeof b.text === 'string' && b.text.includes('What were last quarter'))
    expect(qBlock).toBeDefined()
  })

  it('omits title and question blocks when not provided', () => {
    const card = buildSummaryCard({
      summary: 'Revenue dropped.',
      deepLink: 'https://teams.microsoft.com/l/entity/abc/agents-tab',
    })
    const body = card.content.body as any[]
    expect(body).toHaveLength(1)
  })

  it('renders a table as an Adaptive Card Table element, capped at 10 rows with a note', () => {
    const rowType = [{ name: 'REGION' }, { name: 'SALES' }]
    const data = Array.from({ length: 15 }, (_, i) => [`Region ${i}`, String(i * 100)])
    const card = buildSummaryCard({
      summary: 'Sales by region.',
      deepLink: 'https://teams.microsoft.com/l/entity/abc',
      table: { rowType, data, numRows: 15 },
    })
    const body = card.content.body as any[]
    const table = body.find((b: any) => b.type === 'Table')
    expect(table).toBeDefined()
    expect(table.rows).toHaveLength(11) // header + 10 data rows
    expect(table.rows[0].cells[0].items[0].text).toBe('REGION')
    expect(body.some((b: any) => typeof b.text === 'string' && b.text.includes('Showing 10 of 15 rows'))).toBe(true)
  })

  it('weights table columns by header length instead of giving them all equal width', () => {
    const rowType = [{ name: 'ID' }, { name: 'DEPARTMENT_NAME' }]
    const card = buildSummaryCard({
      summary: 'x', deepLink: 'https://teams.microsoft.com/l/entity/abc',
      table: { rowType, data: [['1', 'Sales']] },
    })
    const body = card.content.body as any[]
    const table = body.find((b: any) => b.type === 'Table')
    expect(table.columns).toEqual([{ width: 2 }, { width: 15 }])
  })

  it('renders no truncation note when every row is shown', () => {
    const card = buildSummaryCard({
      summary: 'x', deepLink: 'https://teams.microsoft.com/l/entity/abc',
      table: { rowType: [{ name: 'A' }], data: [['1']], numRows: 1 },
    })
    const body = card.content.body as any[]
    expect(body.some((b: any) => typeof b.text === 'string' && b.text.includes('Showing'))).toBe(false)
  })

  it('renders citations as markdown-linked TextBlocks under a Sources header', () => {
    const card = buildSummaryCard({
      summary: 'x', deepLink: 'https://teams.microsoft.com/l/entity/abc',
      citations: [{ index: 1, docTitle: 'Doc A', url: 'https://a' }, { index: 2 }],
    })
    const body = card.content.body as any[]
    expect(body.some((b: any) => b.text === 'Sources')).toBe(true)
    expect(body.some((b: any) => b.text === '[Doc A](https://a)')).toBe(true)
    expect(body.some((b: any) => b.text === 'Source 2')).toBe(true)
  })

  it('strips markdown metacharacters from citation titles', () => {
    const card = buildSummaryCard({
      summary: 'x',
      deepLink: 'https://teams.microsoft.com/l/entity/abc',
      citations: [{ index: 1, docTitle: 'Trusted](https://evil.example)(', url: 'https://docs.example/a' }],
    })
    const body = card.content.body as any[]
    expect(body.some((b: any) => b.text === '[Trustedhttps://evil.example](https://docs.example/a)')).toBe(true)
  })

  it('renders the answer verbatim: negative numbers, dates, lists, code and parentheses survive', () => {
    const summary = [
      'Revenue fell -12.5% (2024-03-01 to 2024-06-30).',
      '- item one',
      '- item two',
      'Run `SELECT 1` # note > quoted',
    ].join('\n')
    const card = buildSummaryCard({ summary, deepLink: 'https://teams.microsoft.com/l/entity/abc' })
    const body = card.content.body as any[]
    expect(body.some((b: any) => b.text === summary)).toBe(true)
  })

  it('escapes, rather than deletes, markdown in the title and question', () => {
    const card = buildSummaryCard({
      title: '[Pay now](https://evil.example)',
      question: 'Is **x** -5 (ok)?',
      summary: 'a',
      deepLink: 'https://teams.microsoft.com/l/entity/abc',
    })
    const texts = (card.content.body as any[]).map((b: any) => b.text)
    expect(texts).toContain('\\[Pay now\\]\\(https://evil.example\\)')
    expect(texts).toContain('**Q:** Is \\*\\*x\\*\\* -5 \\(ok\\)?')
  })

  it('escapeCardText keeps plain text intact', () => {
    expect(escapeCardText('Revenue -12.5% 2024-03-01')).toBe('Revenue -12.5% 2024-03-01')
  })

  it('notes a chart is available without attempting to render one', () => {
    const card = buildSummaryCard({ summary: 'x', deepLink: 'https://teams.microsoft.com/l/entity/abc', hasChart: true })
    const body = card.content.body as any[]
    expect(body.some((b: any) => typeof b.text === 'string' && b.text.includes('chart is available'))).toBe(true)
  })
})

describe('buildStarterPromptsCard', () => {
  it('does not truncate the button title for a typical demo-length question', () => {
    const q = 'What are the top 10 products by sales in the last quarter?'
    const card = buildStarterPromptsCard('Sales Agent', [q])
    const actions = card.content.actions as any[]
    expect(actions[0].title).toBe(q)
  })

  it('truncates only questions longer than the 80-char budget', () => {
    const q = 'A'.repeat(90)
    const card = buildStarterPromptsCard('Sales Agent', [q])
    const actions = card.content.actions as any[]
    expect(actions[0].title).toBe('A'.repeat(80) + '…')
  })

  it('renders a placeholder when the agent has no starter questions', () => {
    const card = buildStarterPromptsCard('Sales Agent', [])
    const body = card.content.body as any[]
    expect(body.some((b: any) => typeof b.text === 'string' && b.text.includes('No starter prompts'))).toBe(true)
  })
})
