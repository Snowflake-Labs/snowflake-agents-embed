// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { AgentEntry } from '@snowflake-agents-embed/cortex-server/snowflake/agent-ref'
import { escapeMarkdownLabel } from '@snowflake-agents-embed/chat-core/api/sseParser'

/**
 * Escapes (never deletes) the characters a TextBlock would read as markdown, for text we do
 * not control such as a share-link title or question.
 */
export function escapeCardText(text: string): string {
  return text.replace(/([\\`*_[\]()<>#~|])/g, '\\$1')
}

export interface SummaryCardCitation {
  index: number
  docTitle?: string
  url?: string
}

export interface SummaryCardTable {
  rowType: { name: string }[]
  data: unknown[][]
  numRows?: number
}

export interface SummaryCardInput {
  title?: string
  question?: string
  summary: string
  deepLink: string
  citations?: SummaryCardCitation[]
  table?: SummaryCardTable
  /** True when the answer also produced a chart. Adaptive Cards can't render a live
   * Vega-Lite spec (no JS execution in Teams' native renderer, and this app has no
   * server-side chart-to-image renderer) - out of scope, so this only surfaces a note
   * pointing at the deep link instead of silently dropping the chart. */
  hasChart?: boolean
}

const MAX_TABLE_ROWS = 10

function buildTableElement(rowType: { name: string }[], data: unknown[][]) {
  const headerRow = {
    type: 'TableRow',
    cells: rowType.map((c) => ({ type: 'TableCell', items: [{ type: 'TextBlock', text: c.name, weight: 'Bolder', wrap: true }] })),
  }
  const dataRows = data.slice(0, MAX_TABLE_ROWS).map((row) => ({
    type: 'TableRow',
    cells: row.map((cell) => ({ type: 'TableCell', items: [{ type: 'TextBlock', text: String(cell ?? ''), wrap: true }] })),
  }))
  return {
    type: 'Table',
    // Weighted by header length rather than uniform - a long header ("DEPARTMENT_NAME")
    // next to a short one ("ID") otherwise wraps the long header while the short column
    // wastes its equal share. Matches the equivalent change to the web UI's .th/.td.
    columns: rowType.map((c) => ({ width: Math.max(1, c.name.length) })),
    firstRowAsHeaders: true,
    rows: [headerRow, ...dataRows],
  }
}

export function buildAgentListCard(agents: AgentEntry[], currentFqn: string) {
  const rows = agents.map((a) => {
    const isCurrent = a.fqn.toUpperCase() === currentFqn.toUpperCase()
    const label = isCurrent ? `**${a.displayName}** *(current)*` : a.displayName
    const blocks: unknown[] = [{ type: 'TextBlock', text: label, wrap: true, weight: isCurrent ? 'Bolder' : 'Default' }]
    if (a.description) {
      blocks.push({ type: 'TextBlock', text: a.description, wrap: true, isSubtle: true, size: 'Small', spacing: 'None' })
    }
    return { type: 'Container', items: blocks, spacing: 'Small' }
  })

  const actions = agents.map((a) => ({
    type: 'Action.Submit',
    title: `Use ${a.displayName}`,
    data: { selectAgent: a.fqn },
  }))

  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body: [
        { type: 'TextBlock', text: 'Available Agents', size: 'Medium', weight: 'Bolder' },
        ...rows,
      ],
      actions,
    },
  }
}

export function buildStarterPromptsCard(agentName: string, questions: string[]) {
  const body: unknown[] = [
    { type: 'TextBlock', text: `Starter Prompts — **${agentName}**`, size: 'Medium', weight: 'Bolder' },
  ]
  if (!questions.length) {
    body.push({ type: 'TextBlock', text: 'No starter prompts configured for this agent.', isSubtle: true })
  } else {
    questions.forEach((q) => {
      body.push({ type: 'TextBlock', text: q, wrap: true, spacing: 'Small' })
    })
  }

  const actions = questions.map((q) => ({
    type: 'Action.Submit',
    title: q.length > 80 ? q.slice(0, 80) + '…' : q,
    data: { sendMessage: q },
  }))

  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body,
      actions,
    },
  }
}

export function buildSummaryCard({ title, question, summary, deepLink, citations, table, hasChart }: SummaryCardInput) {
  const bodyBlocks: unknown[] = []

  if (title) {
    bodyBlocks.push({ type: 'TextBlock', text: escapeCardText(title), size: 'Medium', weight: 'Bolder', wrap: true })
  }
  if (question) {
    bodyBlocks.push({ type: 'TextBlock', text: `**Q:** ${escapeCardText(question)}`, wrap: true, spacing: 'Small' })
  }
  bodyBlocks.push({ type: 'TextBlock', text: summary, wrap: true, spacing: 'Small' })

  if (hasChart) {
    bodyBlocks.push({
      type: 'TextBlock',
      text: '📊 A chart is available for this answer — open the full analysis to view it.',
      isSubtle: true, wrap: true, spacing: 'Small', size: 'Small',
    })
  }

  if (table && table.data.length > 0) {
    bodyBlocks.push(buildTableElement(table.rowType, table.data))
    const shown = Math.min(table.data.length, MAX_TABLE_ROWS)
    const total = table.numRows ?? table.data.length
    if (total > shown) {
      bodyBlocks.push({
        type: 'TextBlock',
        text: `Showing ${shown} of ${total} rows — open the full analysis for the rest.`,
        isSubtle: true, size: 'Small', wrap: true,
      })
    }
  }

  if (citations?.length) {
    bodyBlocks.push({ type: 'TextBlock', text: 'Sources', weight: 'Bolder', size: 'Small', spacing: 'Medium' })
    citations.forEach((c) => {
      const label = escapeMarkdownLabel(c.docTitle ?? `Source ${c.index}`)
      // TextBlock supports a limited markdown subset, including links - Adaptive Cards has
      // no dedicated hyperlink element, and rendering N Action.OpenUrl buttons per citation
      // would crowd the card far more than an answer with several sources warrants.
      const text = c.url ? `[${label}](${c.url})` : label
      bodyBlocks.push({ type: 'TextBlock', text, wrap: true, size: 'Small', spacing: 'None' })
    })
  }

  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body: bodyBlocks,
      actions: [
        { type: 'Action.OpenUrl', title: 'Open full analysis', url: deepLink },
      ],
    },
  }
}

export function buildSigninCard(signinUrl: string) {
  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body: [
        { type: 'TextBlock', text: 'Sign in to Snowflake', size: 'Medium', weight: 'Bolder' },
        {
          type: 'TextBlock',
          text: 'Link your Snowflake account once so I can answer as you. The link expires in 10 minutes.',
          wrap: true,
        },
      ],
      actions: [{ type: 'Action.OpenUrl', title: 'Sign in', url: signinUrl }],
    },
  }
}
