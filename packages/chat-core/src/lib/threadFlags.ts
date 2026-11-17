// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// sessionStorage, not localStorage - matches Phase 6's `agents_open_threads` (a different key,
// they must not collide): pin/archive is a per-session overlay over the server-side thread
// list, not a synced preference, since there's no public API to persist it server-side yet.
const KEY = 'agents_thread_flags'

export interface ThreadFlags {
  pinned?: boolean
  archived?: boolean
}

function read(): Record<string, ThreadFlags> {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') } catch { return {} }
}
function write(map: Record<string, ThreadFlags>) {
  sessionStorage.setItem(KEY, JSON.stringify(map))
}

export function getAllThreadFlags(): Record<string, ThreadFlags> {
  return read()
}

export function setThreadPinned(threadId: number, pinned: boolean): void {
  const m = read()
  m[String(threadId)] = { ...m[String(threadId)], pinned }
  write(m)
}

export function setThreadArchived(threadId: number, archived: boolean): void {
  const m = read()
  m[String(threadId)] = { ...m[String(threadId)], archived }
  write(m)
}
