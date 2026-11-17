// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from './composer/icons.js'

interface Props {
  sql: string
}

export function SqlBlock({ sql: query }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    void navigator.clipboard.writeText(query).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="sql-block">
      <div className="sql-header">
        <button className="sql-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          {expanded ? 'Hide SQL' : 'View SQL'}
        </button>
        {expanded && (
          <button className="sql-copy-btn" onClick={handleCopy}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        )}
      </div>
      {expanded && (
        <pre className="sql-content">
          <code>{query}</code>
        </pre>
      )}
    </div>
  )
}
