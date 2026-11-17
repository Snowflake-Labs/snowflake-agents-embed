// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Every route/lib that talks to Snowflake's REST APIs does so directly with no
// signal, so a hung upstream (warehouse resume, network partition) hangs the
// request indefinitely. This wraps fetch with an AbortController so a slow
// Cortex/SQL API call fails after a bound instead of piling up.
const DEFAULT_TIMEOUT_MS = 20_000

// SQL-API pairing: the statement budget must be strictly smaller than the HTTP
// abort so Snowflake cancels first and we do not orphan a running statement.
// 30s covers a cold warehouse resume; 10s of slack is the HTTP margin.
export const SQL_API_STATEMENT_TIMEOUT_SEC = 30
export const SQL_API_FETCH_TIMEOUT_MS = 40_000

// Agent-run SSE ladder. fetchWithTimeout is headers-only (clears its timer when
// the response arrives). The streaming helper keeps a controller armed across
// the body-read phase. Client stall watchdog must be > ping interval.
export const AGENT_RUN_TTFB_MS = 55_000
export const AGENT_RUN_TOTAL_MS = 300_000
export const AGENT_RUN_PING_MS = 15_000

export class UpstreamTimeoutError extends Error {
  readonly timeoutMs: number
  readonly url: string
  constructor(url: string, timeoutMs: number) {
    super(`Upstream timed out after ${timeoutMs}ms: ${url}`)
    this.name = 'UpstreamTimeoutError'
    this.timeoutMs = timeoutMs
    this.url = url
  }
}

export function isUpstreamTimeoutError(err: unknown): err is UpstreamTimeoutError {
  return err instanceof Error && err.name === 'UpstreamTimeoutError'
}

export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const caller = init.signal
  const onCallerAbort = () => controller.abort()
  if (caller) {
    if (caller.aborted) controller.abort()
    else caller.addEventListener('abort', onCallerAbort, { once: true })
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (timedOut) throw new UpstreamTimeoutError(String(url), timeoutMs)
    throw err
  } finally {
    clearTimeout(timer)
    caller?.removeEventListener('abort', onCallerAbort)
  }
}

/**
 * Like fetchWithTimeout, but the abort controller stays armed for `totalMs`
 * after headers arrive so a hung streamed body cannot occupy a connection
 * forever. Caller must invoke `dispose` when the body ends, errors, or is
 * cancelled — wrapUpstreamSse does this via onClose.
 */
export async function fetchWithTimeoutStreaming(
  url: string | URL,
  init: RequestInit = {},
  opts: { firstByteMs?: number; totalMs?: number } = {},
): Promise<{ response: Response; dispose: () => void }> {
  const firstByteMs = opts.firstByteMs ?? AGENT_RUN_TTFB_MS
  const totalMs = opts.totalMs ?? AGENT_RUN_TOTAL_MS
  const controller = new AbortController()
  let timedOut = false
  const firstByteTimer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, firstByteMs)

  const caller = init.signal
  const onCallerAbort = () => controller.abort()
  if (caller) {
    if (caller.aborted) controller.abort()
    else caller.addEventListener('abort', onCallerAbort, { once: true })
  }

  const detachCaller = () => caller?.removeEventListener('abort', onCallerAbort)

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    clearTimeout(firstByteTimer)
    const totalTimer = setTimeout(() => controller.abort(), totalMs)
    return {
      response,
      dispose: () => {
        clearTimeout(totalTimer)
        detachCaller()
      },
    }
  } catch (err) {
    clearTimeout(firstByteTimer)
    detachCaller()
    if (timedOut) throw new UpstreamTimeoutError(String(url), firstByteMs)
    throw err
  }
}
