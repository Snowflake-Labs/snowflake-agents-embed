// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { throwFromResponse } from './apiError.js'
import { getHostAdapter } from '../host/hostAdapter.js'
import { hostFetch } from './hostFetch.js'

export interface ThreadSummary {
  thread_id: number
  thread_name?: string
  created_at?: string
  updated_at?: string
  // 'cowork' = a thread this relay did not originate (native Cowork, the other embed's
  // relay, any other origin_application), tagged by the relay's secondary-origin merge.
  source?: 'teams' | 'sfdc' | 'cowork'
}

export interface ThreadMessage {
  message_id: number
  role: 'user' | 'assistant'
  message_payload: unknown
  created_at?: string
  created_on?: number | string
}

function messageTime(m: ThreadMessage): number {
  const raw = m.created_on ?? m.created_at
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
    if (Number.isFinite(t)) return t
  }
  return NaN
}

// Cortex returns messages newest-first and message_ids are NOT monotonic across roles
// (user and assistant ids come from different ranges), so order by created_on and use
// message_id only as a tie-break / fallback.
export function sortThreadMessages(messages: ThreadMessage[]): ThreadMessage[] {
  return [...messages].sort((a, b) => {
    const ta = messageTime(a)
    const tb = messageTime(b)
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    return a.message_id - b.message_id
  })
}

export interface ThreadDetail {
  thread_id: number
  thread_name?: string
  messages: ThreadMessage[]
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

// Cortex (and an un-upgraded relay/server) emit created_on/updated_on as epoch ms.
// ThreadSummary / SearchView / dateGroups read created_at/updated_at ISO strings.
// SPA and SPCS deploy independently, so every client read path must tolerate both.
function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (/^\d+$/.test(value)) {
    const date = new Date(Number(value))
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : value
}

function normalizeThreadSummary(data: Record<string, unknown>): ThreadSummary {
  const source = data.source
  const out: ThreadSummary = {
    // Cortex returns { thread_id: <number> }; tolerate an { id } alias.
    thread_id: (data.thread_id ?? data.id) as number,
  }
  if (typeof data.thread_name === 'string') out.thread_name = data.thread_name
  const created_at = toIsoTimestamp(data.created_at) ?? toIsoTimestamp(data.created_on)
  const updated_at = toIsoTimestamp(data.updated_at) ?? toIsoTimestamp(data.updated_on)
  if (created_at) out.created_at = created_at
  if (updated_at) out.updated_at = updated_at
  if (source === 'teams' || source === 'sfdc' || source === 'cowork') out.source = source
  return out
}

export async function listThreads(
  snowflakeToken: string,
  opts?: { pageSize?: number; after?: string },
): Promise<{ threads: ThreadSummary[]; after?: string }> {
  const qs = new URLSearchParams()
  if (opts?.pageSize != null) qs.set('page_size', String(opts.pageSize))
  if (opts?.after) qs.set('after', opts.after)
  const query = qs.toString()
  const res = await hostFetch(
    snowflakeToken,
    `${getHostAdapter().baseUrl()}/api/threads${query ? `?${query}` : ''}`,
    { headers: JSON_HEADERS },
  )
  if (!res.ok) await throwFromResponse(res, 'Failed to list threads')
  const data = await res.json()
  const raw: unknown[] = Array.isArray(data) ? data : (data.threads ?? [])
  return {
    threads: raw.map((t) => normalizeThreadSummary((t ?? {}) as Record<string, unknown>)),
    ...(Array.isArray(data) ? {} : data.after ? { after: data.after } : {}),
  }
}

export async function createThread(snowflakeToken: string): Promise<ThreadSummary> {
  const res = await hostFetch(snowflakeToken, `${getHostAdapter().baseUrl()}/api/threads`, {
    method: 'POST',
    headers: JSON_HEADERS,
    // Empty body — the server injects origin_application (e.g. 'agents_teams' or 'agents_sfdc').
    body: JSON.stringify({}),
  })
  if (!res.ok) await throwFromResponse(res, 'Failed to create thread')
  const data = await res.json()
  return normalizeThreadSummary((data ?? {}) as Record<string, unknown>)
}

export async function describeThread(snowflakeToken: string, threadId: number): Promise<ThreadDetail> {
  const res = await hostFetch(snowflakeToken, `${getHostAdapter().baseUrl()}/api/threads/${threadId}`, {
    headers: JSON_HEADERS,
  })
  if (!res.ok) await throwFromResponse(res, `Failed to describe thread ${threadId}`)
  return res.json()
}

export async function renameThread(snowflakeToken: string, threadId: number, name: string): Promise<void> {
  const res = await hostFetch(snowflakeToken, `${getHostAdapter().baseUrl()}/api/threads/${threadId}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ thread_name: name }),
  })
  if (!res.ok) await throwFromResponse(res, 'Failed to rename thread')
}

export async function deleteThread(snowflakeToken: string, threadId: number): Promise<void> {
  const res = await hostFetch(snowflakeToken, `${getHostAdapter().baseUrl()}/api/threads/${threadId}`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
  })
  if (!res.ok) await throwFromResponse(res, 'Failed to delete thread')
}

export async function searchThreads(
  snowflakeToken: string,
  q: string,
  signal?: AbortSignal,
): Promise<ThreadSummary[]> {
  if (!q.trim()) return []
  const url = `${getHostAdapter().baseUrl()}/api/threads/search?q=${encodeURIComponent(q)}`
  const res = await hostFetch(snowflakeToken, url, { headers: JSON_HEADERS, signal })
  if (!res.ok) await throwFromResponse(res, 'Failed to search threads')
  const data = await res.json()
  const raw: unknown[] = Array.isArray(data) ? data : (data.threads ?? [])
  return raw.map((t) => normalizeThreadSummary((t ?? {}) as Record<string, unknown>))
}

// Ask the server to generate a concise title from the first user message.
// Returns '' when generation fails or is empty — callers should skip renaming.
export async function generateTitle(snowflakeToken: string, firstMessage: string): Promise<string> {
  const res = await hostFetch(snowflakeToken, `${getHostAdapter().baseUrl()}/api/generate-title`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ firstMessage }),
  })
  if (!res.ok) return ''
  const data = await res.json().catch(() => ({}))
  return typeof data.title === 'string' ? data.title : ''
}
