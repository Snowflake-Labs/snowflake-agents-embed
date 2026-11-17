// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Turns conversation state into pasteable markdown, for the per-message Copy button and the
// thread-level Copy chat button.
//
// The point of going through markdown rather than copying `turn.text` verbatim: an answer's
// data lives in `turn.artifacts`, not in its prose. "Here are the sales by region:" pasted
// without the table under it is the shape of answer this exists to avoid.
//
// Artifacts carry no content index, so tables land after the prose rather than interleaved at
// the position Cortex emitted them. Accept that for now; these take the whole turn so
// interleaving can be added if artifacts ever gain an index.

import type { ConversationTurn, ColumnDef } from '../types.js'

/** Rows past this are dropped from a copied table — a 10k-row paste is not useful to anyone. */
const MAX_TABLE_ROWS = 100

// A literal pipe inside a cell would end the column early in every markdown renderer.
const escapeCell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

/**
 * Markdown pipe table. Mirrors TableArtifact's copyAll()/downloadCsv() column walk
 * (`rowType` names for the header, positional `row[i]` for cells) so all three exports agree
 * on what a table contains.
 */
export function tableToMarkdown(rowType: ColumnDef[], data: unknown[][], numRows?: number): string {
  if (!rowType.length) return ''
  const rows = data.slice(0, MAX_TABLE_ROWS)
  const lines = [
    `| ${rowType.map((c) => escapeCell(c.name)).join(' | ')} |`,
    `| ${rowType.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${rowType.map((_, i) => escapeCell(row?.[i])).join(' | ')} |`),
  ]
  // numRows is Cortex's total, which can already exceed the rows it sent us, so report against
  // whichever is larger rather than assuming data holds everything.
  const total = Math.max(numRows ?? 0, data.length)
  if (total > rows.length) lines.push('', `_Showing ${rows.length} of ${total} rows_`)
  return lines.join('\n')
}

export const FAMILY_PRODUCT_NAME = 'Snowflake Agents Embed'

export interface TurnMarkdownOptions {
  /** Append the SQL the agent ran. Off by default — pasted output is often for an audience. */
  includeSql?: boolean
  /** Host-facing product name in chart/map placeholders and thread speaker labels. */
  productName?: string
}

function resolveProductName(opts: TurnMarkdownOptions): string {
  const name = opts.productName?.trim()
  return name || FAMILY_PRODUCT_NAME
}

/** One assistant answer: prose, then its tables, charts noted, then optionally its SQL. */
export function turnToMarkdown(turn: ConversationTurn, opts: TurnMarkdownOptions = {}): string {
  const productName = resolveProductName(opts)
  const parts: string[] = []
  // Each text block ends and the next begins with its own blank line, because a table or chart
  // sat between them on screen. Joined into one string that reads as a run of empty lines, so
  // collapse anything past a paragraph break.
  const text = turn.text.trim().replace(/\n{3,}/g, '\n\n')
  if (text) parts.push(text)

  for (const a of turn.artifacts) {
    if (a.type === 'table') {
      const md = tableToMarkdown(a.rowType, a.data, a.numRows)
      if (md) parts.push(a.title ? `**${a.title}**\n\n${md}` : md)
    } else if (a.type === 'map') {
      parts.push(`_[Map: ${a.spec?.title ?? `see ${productName} for the map`}]_`)
    } else {
      // A Vega-Lite spec is no use in a clipboard, but silently dropping the chart makes the
      // prose around it read as if something is missing — which it is.
      parts.push(`_[Chart: ${chartTitle(a.spec) ?? `see ${productName} for the chart`}]_`)
    }
  }

  if (opts.includeSql) {
    for (const sql of turn.steps.map((s) => s.sql).filter(Boolean)) {
      parts.push(`\`\`\`sql\n${sql!.trim()}\n\`\`\``)
    }
  }

  return parts.join('\n\n')
}

// Vega-Lite puts the title at the top level as either a string or {text}.
function chartTitle(spec: unknown): string | undefined {
  const t = (spec as any)?.title
  if (typeof t === 'string' && t.trim()) return t.trim()
  const nested = (spec as any)?.title?.text
  if (typeof nested === 'string' && nested.trim()) return nested.trim()
  return undefined
}

export interface ThreadMarkdownOptions extends TurnMarkdownOptions {
  title?: string
}

/** A whole conversation, oldest first. */
export function threadToMarkdown(
  turns: ConversationTurn[],
  opts: ThreadMarkdownOptions = {},
): string {
  const blocks: string[] = []
  if (opts.title) blocks.push(`# ${opts.title}`)

  for (const turn of turns) {
    if (turn.role === 'user') {
      const q = turn.text.trim()
      if (q) blocks.push(`**You:** ${q}`)
      continue
    }
    // A failed turn has no answer worth pasting, and its error text belongs on screen rather
    // than in whatever document this lands in.
    if (turn.status === 'error') continue
    const body = turnToMarkdown(turn, opts)
    if (body) blocks.push(`**${resolveProductName(opts)}:**\n\n${body}`)
  }

  return blocks.join('\n\n')
}
