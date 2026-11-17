// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import type { Context, Next } from 'hono'
import { createSlidingWindow } from './sliding-window.js'

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

/**
 * In-memory two-bucket sliding-window limiter, one set of buckets per container
 * instance. Not a substitute for a shared/distributed limiter behind a fleet of
 * replicas — every replica enforces its own window — but this is a self-hosted
 * open source project with no assumption of Redis/Durable Objects being
 * available, and blunting a single abusive client per-instance is enough to
 * keep one browser tab from hammering Cortex.
 *
 * Identity cascade (IP before session/token): a host's X-Agents-Session may be
 * a shared secret, so keying on it would collapse every user into one bucket.
 *
 * Timeout ladder (agent-run SSE): TTFB 55s / total stream 300s / ping 15s /
 * browser stall watchdog 45s. See fetch-timeout.ts and agent-run.routes.ts.
 */
export function rateLimiter(opts: {
  windowMs: number
  max: number
  maxBuckets?: number
  skip?: (c: Context) => boolean
  /** Custom bucket key. Defaults to the client-IP cascade below. */
  key?: (c: Context) => string
}) {
  const window = createSlidingWindow({
    windowMs: opts.windowMs,
    max: opts.max,
    maxBuckets: opts.maxBuckets,
  })

  return async function rateLimit(c: Context, next: Next) {
    if (opts.skip?.(c)) return next()
    const result = window.take(opts.key ? opts.key(c) : clientKey(c))
    if (!result.ok) {
      c.header('Retry-After', String(result.retryAfterSec))
      return c.json({ error: 'Too many requests' }, 429)
    }
    await next()
  }
}

function rightmostForwarded(forwarded: string | undefined): string | undefined {
  if (!forwarded) return undefined
  const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean)
  return hops.length ? hops[hops.length - 1] : undefined
}

// Prefer the hop the deployment actually controls (the edge overwrites
// X-Agents-Client-Ip). X-Forwarded-For is ignored unless RATE_LIMIT_TRUST_XFF=1,
// because a caller who reaches SPCS with the PAT can otherwise pick their bucket.
function clientKey(c: Context): string {
  const trusted = c.req.header('X-Agents-Client-Ip')?.trim()
  if (trusted) return trusted
  if (process.env.RATE_LIMIT_TRUST_XFF === '1') {
    const hop = rightmostForwarded(c.req.header('X-Forwarded-For'))
    if (hop) return hop
  }
  const session = c.req.header('X-Agents-Session')
  if (session) return `sess:${hashKey(session)}`
  const token = c.req.header('X-User-Access-Token')
  if (token) return `tok:${hashKey(token)}`
  return 'anonymous'
}
