// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { ThreadSummary } from '../api/threads.js'

export interface DateGroup {
  label: string
  items: ThreadSummary[]
}

const BUCKET_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older', 'Undated']

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function bucketLabel(daysAgo: number): string {
  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  if (daysAgo <= 7) return 'Previous 7 days'
  if (daysAgo <= 30) return 'Previous 30 days'
  return 'Older'
}

/**
 * Groups thread summaries into date buckets off `updated_at` (falling back to `created_at`),
 * sorted newest-first within each bucket. A thread with neither field, or an unparseable one,
 * is treated as newest-unknown rather than oldest: it lands in "Today", ordered by `thread_id`
 * descending among the other date-less threads and placed after the dated ones. `thread_id` is
 * monotonically increasing with creation time in practice, so this is a reasonable proxy without
 * ever surfacing the "Undated" label a caller would otherwise see. `Undated` stays in
 * `BUCKET_ORDER`/`bucketLabel` as a last resort for a future caller that wants it explicitly -
 * `groupByDate` itself never routes anything there, so it's always filtered out below as empty.
 * `now` is a parameter (not read from `Date.now()` internally) purely so tests can pin it.
 */
export function groupByDate(summaries: ThreadSummary[], now: Date = new Date()): DateGroup[] {
  const today = startOfDay(now)
  const buckets = new Map<string, ThreadSummary[]>(BUCKET_ORDER.map((label) => [label, []]))

  const withParsedDate = summaries
    .map((s) => {
      const dateStr = s.updated_at ?? s.created_at
      const t = dateStr ? new Date(dateStr).getTime() : NaN
      return { s, t: Number.isNaN(t) ? undefined : t }
    })

  const dated = withParsedDate
    .filter((x): x is { s: ThreadSummary; t: number } => x.t !== undefined)
    .sort((a, b) => b.t - a.t)
  const undated = withParsedDate
    .filter((x) => x.t === undefined)
    .sort((a, b) => b.s.thread_id - a.s.thread_id)

  for (const { s, t } of dated) {
    const daysAgo = Math.max(0, Math.floor((today - startOfDay(new Date(t))) / 86_400_000))
    buckets.get(bucketLabel(daysAgo))!.push(s)
  }
  for (const { s } of undated) {
    buckets.get('Today')!.push(s)
  }

  return BUCKET_ORDER
    .map((label) => ({ label, items: buckets.get(label)! }))
    .filter((g) => g.items.length > 0)
}
