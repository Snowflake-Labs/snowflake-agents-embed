// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
interface Props {
  suggestions: string[]
  onSend: (text: string) => void
}

export function Suggestions({ suggestions, onSend }: Props) {
  if (!suggestions.length) return null
  return (
    <div className="suggestions">
      {suggestions.map((s, i) => (
        <button key={i} className="suggestion-chip" onClick={() => onSend(s)}>
          {s}
        </button>
      ))}
    </div>
  )
}
