// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState, useRef, useEffect } from 'react'
import type { Citation } from '../../types.js'

interface Props {
  citations: Citation[]
}

export function CitationList({ citations }: Props) {
  if (!citations.length) return null
  return (
    <div className="citation-list">
      {citations.map((c) => (
        <CitationChip key={c.searchResultId ?? `${c.contentIndex ?? 0}:${c.index}`} citation={c} />
      ))}
    </div>
  )
}

function truncate(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

function CitationChip({ citation }: { citation: Citation }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <span ref={ref} className="citation-chip-wrap">
      <button
        className="citation-chip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Citation ${citation.index}`}
      >
        {citation.index}
      </button>
      {open && (
        <div className="citation-popover" role="tooltip">
          {(citation.docTitle ?? citation.docId) && (
            <div className="citation-title">{citation.docTitle ?? citation.docId}</div>
          )}
          {citation.text && <p className="citation-snippet">{truncate(citation.text)}</p>}
          {citation.url && (
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              className="citation-link"
            >
              Open source ↗
            </a>
          )}
        </div>
      )}
    </span>
  )
}
