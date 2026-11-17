// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useRef, useState } from 'react'

const POSITIVE_CATEGORIES = ['Accurate', 'Helpful', 'Well formatted']
const NEGATIVE_CATEGORIES = ['Incorrect answer', 'Not helpful', 'Incomplete', 'Too slow']

// Mirrors AutoResizePlugin's composer growth cap - a comment box has no reason to grow
// past what the composer itself allows.
const MIN_HEIGHT_PX = 48
const MAX_HEIGHT_PX = 210

interface Props {
  positive: boolean
  onSubmit: (categories: string[], comment: string) => void
  onCancel: () => void
}

/** Small categorized-feedback panel shown after a thumbs up/down click. */
export function FeedbackDialog({ positive, onSubmit, onCancel }: Props) {
  const categories = positive ? POSITIVE_CATEGORIES : NEGATIVE_CATEGORIES
  const [selected, setSelected] = useState<string[]>([])
  const [comment, setComment] = useState('')
  const commentRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = commentRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.max(MIN_HEIGHT_PX, Math.min(el.scrollHeight, MAX_HEIGHT_PX))}px`
  }, [comment])

  function toggle(category: string) {
    setSelected((prev) => (prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]))
  }

  return (
    <div className="feedback-dialog" role="dialog" aria-label={positive ? 'Positive feedback' : 'Negative feedback'}>
      <div className="feedback-dialog-categories">
        {categories.map((category) => (
          <label key={category} className="feedback-dialog-category">
            <input
              type="checkbox"
              checked={selected.includes(category)}
              onChange={() => toggle(category)}
            />
            {category}
          </label>
        ))}
      </div>
      <textarea
        ref={commentRef}
        className="feedback-dialog-comment"
        placeholder="Add a comment (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        aria-label="Feedback comment"
      />
      <div className="feedback-dialog-actions">
        <button className="action-btn" onClick={onCancel}>Cancel</button>
        <button className="action-btn feedback-dialog-submit" onClick={() => onSubmit(selected, comment.trim())}>
          Submit
        </button>
      </div>
    </div>
  )
}
