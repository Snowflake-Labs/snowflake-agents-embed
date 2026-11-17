// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect, useRef } from 'react'
import { searchThreads } from '../../api/threads.js'
import { useOpenThread } from '../../hooks/useOpenThread.js'
import type { ThreadSummary } from '../../api/threads.js'
import { classifyError, type ClassifiedError } from '../../lib/classifyError.js'

const MIN_QUERY_LENGTH = 3
const searchDateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function formatThreadTimestamp(summary: ThreadSummary): { iso: string; label: string } | null {
  const iso = summary.updated_at ?? summary.created_at
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return { iso, label: searchDateTimeFormat.format(date) }
}

interface Props {
  snowflakeToken: string
}

export function SearchView({ snowflakeToken }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ThreadSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ClassifiedError | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const openThread = useOpenThread(snowflakeToken)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    abortRef.current?.abort()
    const trimmed = query.trim()
    if (!trimmed || trimmed.length < MIN_QUERY_LENGTH) {
      setResults([])
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    debounceRef.current = setTimeout(() => void (async () => {
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      const id = ++requestIdRef.current
      try {
        const threads = await searchThreads(snowflakeToken, query, ac.signal)
        if (id !== requestIdRef.current) return
        setResults(threads)
        setError(null)
      } catch (err: unknown) {
        if (isAbortError(err) || ac.signal.aborted) return
        if (id !== requestIdRef.current) return
        setError(classifyError(err, 'Search failed'))
      } finally {
        if (id === requestIdRef.current) setLoading(false)
      }
    })(), 300)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      abortRef.current?.abort()
    }
  }, [query, snowflakeToken])

  return (
    <div className="search-view">
      <div className="search-input-row">
        <input
          className="search-input"
          type="search"
          placeholder="Search conversations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          aria-label="Search conversations"
        />
      </div>

      {error && (
        <div className="history-error">
          {error.message}
          <details>
            <summary>Details</summary>
            {error.raw}
          </details>
        </div>
      )}
      {loading && <div className="search-loading">Searching…</div>}

      {!loading && !error && query.trim().length >= MIN_QUERY_LENGTH && results.length === 0 && (
        <div className="search-empty">No conversations found for "{query}"</div>
      )}

      {!loading && (
        <div className="search-results">
          {results.map((s) => {
            const timestamp = formatThreadTimestamp(s)
            return (
              <button
                key={s.thread_id}
                className="search-result-item"
                onClick={() => openThread(s.thread_id)}
              >
                <span className="search-result-name">{s.thread_name}</span>
                <span className="search-result-meta">
                  {timestamp && (
                    <time className="search-result-time" dateTime={timestamp.iso}>
                      {timestamp.label}
                    </time>
                  )}
                  {s.source === 'cowork' && (
                    <span className="history-source-badge">CoWork</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
