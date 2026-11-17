// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { createSlidingWindow } from './sliding-window.js'

describe('createSlidingWindow', () => {
  it('admits requests under the limit', () => {
    const w = createSlidingWindow({ windowMs: 60_000, max: 2 })
    expect(w.take('a', 1_000).ok).toBe(true)
    expect(w.take('a', 1_001).ok).toBe(true)
  })

  it('rejects once a caller exceeds the limit within the window', () => {
    const w = createSlidingWindow({ windowMs: 60_000, max: 2 })
    w.take('a', 1_000)
    w.take('a', 1_001)
    const denied = w.take('a', 1_002)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.retryAfterSec).toBeGreaterThan(0)
  })

  it('does not admit a 2x burst across the window boundary', () => {
    const w = createSlidingWindow({ windowMs: 1_000, max: 2 })
    const t0 = 10_000
    expect(w.take('a', t0).ok).toBe(true)
    expect(w.take('a', t0 + 1).ok).toBe(true)
    // Instantly after reset the previous window still fully overlaps the lookback.
    expect(w.take('a', t0 + 1_000).ok).toBe(false)
    // Halfway through the new window, half the previous count has aged out (1 of 2),
    // so one more request is admitted and a second is not.
    expect(w.take('a', t0 + 1_500).ok).toBe(true)
    expect(w.take('a', t0 + 1_501).ok).toBe(false)
  })

  it('evicts oldest-inserted keys when the cap is hit', () => {
    const w = createSlidingWindow({ windowMs: 60_000, max: 1, maxBuckets: 2 })
    expect(w.take('one', 1_000).ok).toBe(true)
    expect(w.take('two', 1_001).ok).toBe(true)
    expect(w.size()).toBe(2)
    expect(w.take('three', 1_002).ok).toBe(true)
    expect(w.size()).toBe(2)
    // 'one' was oldest-inserted; after eviction it starts a fresh bucket.
    expect(w.take('one', 1_003).ok).toBe(true)
  })

  it('sweeps expired buckets on a time-based cadence, not only request count', () => {
    const w = createSlidingWindow({ windowMs: 1_000, max: 1, maxBuckets: 10 })
    w.take('stale', 1_000)
    expect(w.size()).toBe(1)
    // Two full windows later the previous+current windows have both elapsed.
    w.take('fresh', 1_000 + 2_000)
    expect(w.size()).toBe(1)
  })

  it('buckets callers independently', () => {
    const w = createSlidingWindow({ windowMs: 60_000, max: 1 })
    expect(w.take('a', 1).ok).toBe(true)
    expect(w.take('b', 1).ok).toBe(true)
    expect(w.take('a', 2).ok).toBe(false)
  })
})
