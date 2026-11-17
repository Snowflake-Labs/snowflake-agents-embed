// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Two-bucket sliding-window counter. One Map per process — not a substitute
 * for a shared limiter behind a fleet of replicas. This repo does not assume
 * Redis or Durable Objects; blunting one abusive client per instance is enough.
 *
 * Admission: `prevCount * (fraction of the previous window still in the
 * lookback) + count` must stay at or under `max`. That removes the 2x burst
 * a fixed window allows on the reset boundary.
 *
 * The Map is capped. On insert-over-cap we sweep expired keys, then evict
 * oldest-inserted entries (Map insertion order) so a key-rotation flood
 * cannot grow the process without bound.
 */

export const DEFAULT_MAX_BUCKETS = 10_000
const SWEEP_EVERY_REQUESTS = 1_000

interface Bucket {
  count: number
  resetAt: number
  prevCount: number
}

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number }

export interface SlidingWindow {
  take(key: string, now?: number): TakeResult
  /** Test helper. */
  size(): number
}

export function createSlidingWindow(opts: {
  windowMs: number
  max: number
  maxBuckets?: number
}): SlidingWindow {
  const windowMs = opts.windowMs
  const max = opts.max
  const maxBuckets = opts.maxBuckets ?? DEFAULT_MAX_BUCKETS
  const buckets = new Map<string, Bucket>()
  let requestsSinceSweep = 0
  let lastSweepAt = 0

  function sweep(now: number) {
    for (const [k, b] of buckets) {
      // A bucket whose current *and* previous windows have elapsed is dead.
      if (b.resetAt + windowMs <= now) buckets.delete(k)
    }
    lastSweepAt = now
    requestsSinceSweep = 0
  }

  function evictOldest(needed: number) {
    while (buckets.size + needed > maxBuckets) {
      const first = buckets.keys().next().value
      if (first === undefined) break
      buckets.delete(first)
    }
  }

  function roll(bucket: Bucket, now: number): Bucket {
    if (now < bucket.resetAt) return bucket
    const elapsed = now - bucket.resetAt
    const windowsPassed = Math.floor(elapsed / windowMs) + 1
    if (windowsPassed >= 2) {
      return { count: 0, prevCount: 0, resetAt: now + windowMs }
    }
    return { count: 0, prevCount: bucket.count, resetAt: bucket.resetAt + windowMs }
  }

  function prevFraction(bucket: Bucket, now: number): number {
    const windowStart = bucket.resetAt - windowMs
    const elapsed = Math.max(0, now - windowStart)
    if (elapsed >= windowMs) return 0
    return 1 - elapsed / windowMs
  }

  function retryAfterSec(bucket: Bucket, now: number): number {
    // Smallest wait until prevCount * frac + count + 1 <= max.
    const room = max - bucket.count - 1
    if (room < 0 || bucket.prevCount <= 0) {
      return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    }
    const allowedFrac = room / bucket.prevCount
    const neededElapsed = (1 - allowedFrac) * windowMs
    const windowStart = bucket.resetAt - windowMs
    return Math.max(1, Math.ceil((windowStart + neededElapsed - now) / 1000))
  }

  return {
    take(key: string, now = Date.now()): TakeResult {
      if (++requestsSinceSweep >= SWEEP_EVERY_REQUESTS || now - lastSweepAt >= windowMs) {
        sweep(now)
      }

      let bucket = buckets.get(key)
      if (!bucket) {
        if (buckets.size >= maxBuckets) {
          sweep(now)
          evictOldest(1)
        }
        bucket = { count: 0, prevCount: 0, resetAt: now + windowMs }
        buckets.set(key, bucket)
      } else {
        const rolled = roll(bucket, now)
        if (rolled !== bucket) {
          buckets.delete(key)
          buckets.set(key, rolled)
          bucket = rolled
        }
      }

      const weighted = bucket.prevCount * prevFraction(bucket, now) + bucket.count
      if (weighted + 1 > max) {
        return { ok: false, retryAfterSec: retryAfterSec(bucket, now) }
      }
      bucket.count += 1
      return { ok: true }
    },
    size() {
      return buckets.size
    },
  }
}
