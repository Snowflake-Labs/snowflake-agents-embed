// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { getHostAdapter } from '../host/hostAdapter.js'

interface StatementsResponse {
  data: unknown[][]
  resultSetMetaData?: { partitionInfo?: unknown[] }
}

async function fetchPartition(token: string, handle: string, partition?: number): Promise<StatementsResponse> {
  const adapter = getHostAdapter()
  const url = `${adapter.baseUrl()}/api/statements/${encodeURIComponent(handle)}${partition ? `?partition=${partition}` : ''}`
  const res = await fetch(url, { headers: adapter.headers(token) })
  if (!res.ok) throw new Error(`Failed to load full results (HTTP ${res.status})`)
  return res.json()
}

/**
 * Fetches every partition of a statement handle (a Cortex table artifact's `query_id`) via the
 * server/relay-proxied SQL Statements API, and assembles the full, non-truncated row set.
 *
 * Always re-fetches from partition 0 rather than appending to the caller's already-rendered
 * rows — those aren't guaranteed to align with a partition boundary, so partial reuse would risk
 * duplicating or dropping rows.
 */
export async function fetchFullTableResult(token: string, handle: string): Promise<unknown[][]> {
  const first = await fetchPartition(token, handle)
  const partitions = first.resultSetMetaData?.partitionInfo ?? []
  const rest = await Promise.all(
    partitions.slice(1).map((_, i) => fetchPartition(token, handle, i + 1)),
  )
  return [first.data, ...rest.map((r) => r.data)].flat()
}
