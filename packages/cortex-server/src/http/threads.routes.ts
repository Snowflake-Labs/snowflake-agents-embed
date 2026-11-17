// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono'
import { snowflakeBase, snowflakeHeaders, type SnowflakeCredential } from '../snowflake/credential.js'
import { InvalidPathIdError, threadUrl } from '../snowflake/path-id.js'
import { fetchWithTimeout } from '../snowflake/fetch-timeout.js'
import { isCredentialFailure } from '../host/credentialResolver.js'
import { passThroughOrRedact, redactedUpstreamError, redactedUpstreamErrorFrom } from './upstream-error.js'
import type { CortexRouteDeps } from './deps.js'

// Cortex returns created_on/updated_on as epoch-millisecond numbers; the client's
// ThreadSummary type (and date-bucketing in dateGroups.ts) expects created_at/updated_at
// as ISO strings. Without this mapping every thread silently lands in the "Undated"
// bucket, since s.updated_at/s.created_at are always undefined on the raw response.
// Numeric strings are accepted too — Snowflake JSON sometimes stringifies large ints.
function epochToIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const date = new Date(Number(value))
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return undefined
}

function existingIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || /^\d+$/.test(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : value
}

function normalizeThread(t: unknown): unknown {
  if (typeof t !== 'object' || t === null) return t
  const rec = t as Record<string, unknown>
  const out: Record<string, unknown> = { ...rec }
  const updated_at = existingIso(rec.updated_at) ?? epochToIso(rec.updated_at) ?? epochToIso(rec.updated_on)
  const created_at = existingIso(rec.created_at) ?? epochToIso(rec.created_at) ?? epochToIso(rec.created_on)
  if (updated_at !== undefined) out.updated_at = updated_at
  if (created_at !== undefined) out.created_at = created_at
  return out
}

function normalizeThreads(threads: unknown[]): unknown[] {
  return threads.map(normalizeThread)
}

// 401/403 must reach the client so it re-runs SSO; every other upstream failure is a 502.
// An empty list is only correct for a genuine 404.
class UpstreamThreadsError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`threads upstream ${status}`)
  }
}

function threadsFailureResponse(err: unknown): Response {
  if (!(err instanceof UpstreamThreadsError)) throw err
  const status = err.status === 401 || err.status === 403 ? err.status : 502
  const res = redactedUpstreamErrorFrom(err.status, err.detail)
  return new Response(res.body, { status, headers: res.headers })
}

export function registerThreadRoutes(app: Hono, deps: CortexRouteDeps) {
  function cortexBase() {
    return `${snowflakeBase(deps.config.snowflakeAccount)}/api/v2/cortex/threads`
  }

  function headers(cred: SnowflakeCredential) {
    return snowflakeHeaders(cred)
  }

  // Fetch one page of threads from Cortex with the given extra query params.
  // Returns the threads array and the next-page cursor (if any).
  async function fetchThreadPage(
    cred: SnowflakeCredential,
    params: Record<string, string>,
  ): Promise<{ threads: unknown[]; nextAfter?: string }> {
    const url = new URL(cortexBase())
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const res = await fetchWithTimeout(url.toString(), { headers: headers(cred) })
    if (res.status === 404) return { threads: [] }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new UpstreamThreadsError(res.status, detail)
    }
    const data = await res.json().catch(() => ({} as any))
    const threads: unknown[] = Array.isArray(data) ? data : (data.threads ?? [])
    const nextAfter: string | undefined = data.next_page_token ?? data.after
    return { threads, nextAfter }
  }

  // List threads scoped to the resolved credential (shared service PAT, or per-user OBO on Teams) and, when set, to origin_application.
  // Under the service PAT this is per-deployment, not per end user — Cortex
  // has no additional caller identity on that path.
  app.get('/api/threads', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    const pageSize = c.req.query('page_size')
    const after = c.req.query('after')

    function listBody(threads: unknown[], nextAfter?: string) {
      return { threads: normalizeThreads(threads), ...(nextAfter ? { after: nextAfter } : {}) }
    }

    function threadsAndCursor(data: any): { threads: unknown[]; after?: string } {
      const threads: unknown[] = Array.isArray(data) ? data : (data.threads ?? [])
      const nextAfter: string | undefined = data?.next_page_token ?? data?.after
      return { threads, after: nextAfter }
    }

    // Single-origin fast path (no secondary configured)
    if (!deps.config.agentsSecondaryOrigin) {
      const url = new URL(cortexBase())
      url.searchParams.set('origin_application', deps.host.originApp)
      if (pageSize) url.searchParams.set('page_size', pageSize)
      if (after) url.searchParams.set('after', after)
      const res = await fetchWithTimeout(url.toString(), { headers: headers(cred) })
      if (!res.ok) return redactedUpstreamError(res)
      const data = await res.json().catch(() => ({} as any))
      const parsed = threadsAndCursor(data)
      return c.json(listBody(parsed.threads, parsed.after))
    }

    // '*' = no origin filter, so every thread for this identity comes back. That
    // is what puts every host's history in one list.
    if (deps.config.agentsSecondaryOrigin === '*') {
      const url = new URL(cortexBase())
      if (pageSize) url.searchParams.set('page_size', pageSize)
      if (after) url.searchParams.set('after', after)
      const res = await fetchWithTimeout(url.toString(), { headers: headers(cred) })
      if (!res.ok) return redactedUpstreamError(res)
      const data = await res.json().catch(() => ({} as any))
      const parsed = threadsAndCursor(data)
      return c.json(listBody(parsed.threads, parsed.after))
    }

    // Dual-origin: fetch both in parallel, merge by updated_at desc.
    // Secondary is fetched only on the first page (no `after`): later pages are
    // primary-only so we do not re-merge the same first secondary page. Both
    // origins get the same page_size; the merged list is trimmed to page_size
    // and the next cursor is the primary origin's.
    const pageLimit = pageSize ? Number(pageSize) : undefined
    const primaryUrl = new URL(cortexBase())
    primaryUrl.searchParams.set('origin_application', deps.host.originApp)
    if (pageSize) primaryUrl.searchParams.set('page_size', pageSize)
    if (after) primaryUrl.searchParams.set('after', after)

    const secondaryUrl = new URL(cortexBase())
    secondaryUrl.searchParams.set('origin_application', deps.config.agentsSecondaryOrigin)
    if (pageSize) secondaryUrl.searchParams.set('page_size', pageSize)

    const [primaryRes, secondaryRes] = await Promise.all([
      fetchWithTimeout(primaryUrl.toString(), { headers: headers(cred) }),
      after
        ? Promise.resolve(null)
        : fetchWithTimeout(secondaryUrl.toString(), { headers: headers(cred) }).catch(() => null),
    ])

    if (!primaryRes.ok) {
      const body = await primaryRes.text().catch(() => '')
      return redactedUpstreamErrorFrom(primaryRes.status, body)
    }

    const primaryData = await primaryRes.json().catch(() => ({} as any))
    const primaryParsed = threadsAndCursor(primaryData)
    const primaryThreads: unknown[] = normalizeThreads(primaryParsed.threads)

    let secondaryThreads: unknown[] = []
    if (secondaryRes?.ok) {
      const secondaryData = await secondaryRes.json().catch(() => ({} as any))
      const raw = threadsAndCursor(secondaryData).threads
      secondaryThreads = normalizeThreads(raw).map((t) => ({ ...(t as object), source: 'cowork' }))
    }

    const merged = [...primaryThreads, ...secondaryThreads].sort((a, b) => {
      const ta = (a as Record<string, string>).updated_at ?? (a as Record<string, string>).created_at ?? ''
      const tb = (b as Record<string, string>).updated_at ?? (b as Record<string, string>).created_at ?? ''
      return tb.localeCompare(ta)
    })
    const trimmed = pageLimit && Number.isFinite(pageLimit) ? merged.slice(0, pageLimit) : merged

    return c.json(listBody(trimmed, primaryParsed.after))
  })

  // Search threads by title substring (fetch-and-filter, registered BEFORE /:id)
  app.get('/api/threads/search', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    const q = (c.req.query('q') ?? '').trim().toLowerCase()
    if (!q) return c.json({ threads: [] })

    // Cortex threads API has no text search - paginate and filter here.
    // Stop once MAX_MATCHES hits so a one-character query cannot walk every page.
    const PAGE_SIZE = 100
    const MAX_PAGES = 5
    const MAX_MATCHES = 50
    const resolved = cred  // capture narrowed value for use inside the closure

    function matchesQuery(t: unknown): boolean {
      const name: string = (t as Record<string, string>).thread_name ?? ''
      return name.trim().length > 0 && name.toLowerCase().includes(q)
    }

    async function fetchMatchingPages(extraParams: Record<string, string>): Promise<unknown[]> {
      const results: unknown[] = []
      let after: string | undefined
      for (let page = 0; page < MAX_PAGES && results.length < MAX_MATCHES; page++) {
        const { threads, nextAfter } = await fetchThreadPage(resolved, {
          page_size: String(PAGE_SIZE),
          ...extraParams,
          ...(after ? { after } : {}),
        })
        for (const t of threads) {
          if (!matchesQuery(t)) continue
          results.push(t)
          if (results.length >= MAX_MATCHES) break
        }
        after = nextAfter
        if (!after || threads.length < PAGE_SIZE) break
      }
      return results
    }

    let primaryThreads: unknown[]
    let secondaryThreads: unknown[] = []

    try {
    if (!deps.config.agentsSecondaryOrigin) {
      primaryThreads = await fetchMatchingPages({ origin_application: deps.host.originApp })
    } else if (deps.config.agentsSecondaryOrigin === '*') {
      primaryThreads = await fetchMatchingPages({})
    } else {
      const [primary, secondary] = await Promise.all([
        fetchMatchingPages({ origin_application: deps.host.originApp }),
        fetchMatchingPages({ origin_application: deps.config.agentsSecondaryOrigin }).catch(() => []),
      ])
      primaryThreads = primary
      secondaryThreads = secondary.map((t) => ({ ...(t as object), source: 'cowork' }))
    }
    } catch (err) {
      return threadsFailureResponse(err)
    }

    const matched = normalizeThreads([...primaryThreads, ...secondaryThreads])
      .sort((a, b) => {
        const ta = (a as Record<string, string>).updated_at
          ?? (a as Record<string, string>).created_at
          ?? ''
        const tb = (b as Record<string, string>).updated_at
          ?? (b as Record<string, string>).created_at
          ?? ''
        return tb.localeCompare(ta)
      })
      .slice(0, MAX_MATCHES)

    return c.json({ threads: matched })
  })

  // Describe a thread (messages). Each turn's content arrives in
  // `message_payload` as a JSON *string* - the UI parses it in reconstructTurns.
  app.get('/api/threads/:id', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    let url: URL
    try {
      url = threadUrl(cortexBase(), c.req.param('id'))
    } catch (err) {
      if (err instanceof InvalidPathIdError) return c.json({ error: err.message }, 400)
      throw err
    }
    const pageSize = c.req.query('page_size')
    const lastMessageId = c.req.query('last_message_id')
    if (pageSize) url.searchParams.set('page_size', pageSize)
    if (lastMessageId) url.searchParams.set('last_message_id', lastMessageId)

    const res = await fetchWithTimeout(url.toString(), { headers: headers(cred) })
    return passThroughOrRedact(res)
  })

  // Create a thread. origin_application is forced server-side so a client cannot
  // spoof another surface's tag.
  app.post('/api/threads', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    const reqBody = await c.req.json().catch(() => ({}))
    const createBody: Record<string, unknown> = { origin_application: deps.host.originApp }
    if (reqBody && typeof reqBody === 'object' && !Array.isArray(reqBody)) {
      const name = (reqBody as Record<string, unknown>).thread_name
      if (typeof name === 'string') createBody.thread_name = name
    }
    const res = await fetchWithTimeout(cortexBase(), {
      method: 'POST',
      headers: headers(cred),
      body: JSON.stringify(createBody),
    })
    if (!res.ok) return redactedUpstreamError(res)
    // Unlike the GET paths, this response was never normalized - Cortex returns raw
    // created_on/updated_on (epoch ms), so a thread created here sat in "Undated" until
    // the next full listThreads(). See normalizeThread above.
    const data = await res.json().catch(() => ({} as any))
    return c.json(normalizeThread(data))
  })

  // Rename a thread (POST with thread_name in body per Cortex Threads API)
  app.post('/api/threads/:id', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    let url: URL
    try {
      url = threadUrl(cortexBase(), c.req.param('id'))
    } catch (err) {
      if (err instanceof InvalidPathIdError) return c.json({ error: err.message }, 400)
      throw err
    }
    const reqBody = await c.req.json().catch(() => ({}))
    const res = await fetchWithTimeout(url.toString(), {
      method: 'POST',
      headers: headers(cred),
      body: JSON.stringify(reqBody),
    })
    return passThroughOrRedact(res)
  })

  // Delete a thread
  app.delete('/api/threads/:id', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    let url: URL
    try {
      url = threadUrl(cortexBase(), c.req.param('id'))
    } catch (err) {
      if (err instanceof InvalidPathIdError) return c.json({ error: err.message }, 400)
      throw err
    }
    const res = await fetchWithTimeout(url.toString(), {
      method: 'DELETE',
      headers: headers(cred),
    })
    return new Response(null, { status: res.status })
  })
}
