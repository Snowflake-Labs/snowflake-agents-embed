// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { PersistStorage, StorageValue } from 'zustand/middleware'

/**
 * A zustand `PersistStorage` that debounces writes to sessionStorage.
 *
 * Why this exists: zustand's persist middleware writes on *every* `set()`, and the store's
 * openThreads slice is written on every SSE text delta while an answer streams. With the
 * default `createJSONStorage`, that meant a synchronous `JSON.stringify` of the whole
 * conversation - every turn, every table's rows, every chart spec - on the main thread per
 * chunk, so the cost of rendering a delta grew with the length of the conversation.
 *
 * The debounce is only half the fix. The other half is *where* the stringify happens: it runs
 * in the flush, not in `setItem`, so a burst of N writes costs one serialization rather than N.
 * That's why this implements PersistStorage directly instead of wrapping a StateStorage - the
 * latter would have persist stringify before handing us the value, putting the cost straight
 * back on the delta path.
 *
 * Since a debounced write can be outstanding when the page goes away, flush eagerly on
 * `pagehide` and on `visibilitychange`-to-hidden. Those are what make the same-tab reload
 * recovery this key exists for (see chatStore's `markInterruptedTurns`) still work.
 */
export function throttledSessionStorage<S>(
  ms = 1000,
  transform?: (value: StorageValue<S>) => StorageValue<S>,
): PersistStorage<S> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: { name: string; value: StorageValue<S> } | null = null

  const write = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    const p = pending
    pending = null
    if (!p) return
    try {
      sessionStorage.setItem(p.name, JSON.stringify(transform ? transform(p.value) : p.value))
    } catch {
      // Quota exceeded, or a restricted iframe that throws on storage access. Dropping the
      // write is the right outcome either way - persistence here is a recovery nicety, and
      // failing it must never break the stream that triggered it.
    }
  }

  // Guarded: a non-browser test runtime (or a sandboxed frame) may have neither.
  try {
    addEventListener('pagehide', write)
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') write() })
  } catch { /* no window - nothing to flush against */ }

  return {
    getItem: (name) => {
      // A pending write is newer than what's on disk, so answer from it rather than re-reading
      // a stale value. Matters for zustand's own rehydrate-then-merge path.
      if (pending?.name === name) return pending.value
      try {
        const raw = sessionStorage.getItem(name)
        return raw ? (JSON.parse(raw) as StorageValue<S>) : null
      } catch {
        return null
      }
    },
    setItem: (name, value) => {
      pending = { name, value }
      if (timer === undefined) timer = setTimeout(write, ms)
    },
    removeItem: (name) => {
      if (pending?.name === name) pending = null
      try { sessionStorage.removeItem(name) } catch { /* see write() */ }
    },
  }
}
