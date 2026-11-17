// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { groupByDate } from './dateGroups'
import type { ThreadSummary } from '../api/threads.js'

const NOW = new Date('2026-08-27T12:00:00Z')

function summary(id: number, updated_at?: string): ThreadSummary {
  return { thread_id: id, thread_name: `Thread ${id}`, updated_at }
}

describe('groupByDate', () => {
  it('buckets Today/Yesterday/Previous 7 days/Previous 30 days/Older correctly', () => {
    const groups = groupByDate([
      summary(1, '2026-08-27T09:00:00Z'),   // today
      summary(2, '2026-08-26T09:00:00Z'),   // yesterday
      summary(3, '2026-08-22T09:00:00Z'),   // 5 days ago
      summary(4, '2026-08-05T09:00:00Z'),   // 22 days ago
      summary(5, '2026-01-01T09:00:00Z'),   // older
    ], NOW)

    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'])
    expect(groups[0].items.map((t) => t.thread_id)).toEqual([1])
    expect(groups[4].items.map((t) => t.thread_id)).toEqual([5])
  })

  it('sorts newest-first within a bucket', () => {
    const groups = groupByDate([
      summary(1, '2026-08-27T08:00:00Z'),
      summary(2, '2026-08-27T11:00:00Z'),
    ], NOW)
    expect(groups[0].items.map((t) => t.thread_id)).toEqual([2, 1])
  })

  it('falls back to created_at when updated_at is absent', () => {
    const groups = groupByDate([{ thread_id: 1, created_at: '2026-08-27T09:00:00Z' }], NOW)
    expect(groups[0].label).toBe('Today')
  })

  it('treats threads with no usable date as newest-unknown, bucketing them into Today ordered by thread_id desc', () => {
    const groups = groupByDate([{ thread_id: 1 }, { thread_id: 2, updated_at: 'not-a-date' }], NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Today')
    expect(groups[0].items.map((t) => t.thread_id)).toEqual([2, 1])
  })

  it('places date-less threads after dated Today threads, still ordered by thread_id desc among themselves', () => {
    const groups = groupByDate([
      { thread_id: 5 },
      summary(1, '2026-08-27T09:00:00Z'),
      { thread_id: 9, updated_at: 'not-a-date' },
    ], NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Today')
    expect(groups[0].items.map((t) => t.thread_id)).toEqual([1, 9, 5])
  })

  it('omits empty buckets entirely', () => {
    const groups = groupByDate([summary(1, '2026-08-27T09:00:00Z')], NOW)
    expect(groups).toEqual([{ label: 'Today', items: [expect.objectContaining({ thread_id: 1 })] }])
  })

  it('returns an empty array for no summaries', () => {
    expect(groupByDate([], NOW)).toEqual([])
  })
})
