// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react'
import type { PendingQuestion } from '../../types.js'

interface Props {
  pendingQuestion: PendingQuestion
  onAnswer: (text: string) => void
}

/**
 * ask_user_question / permission_decision live wire protocol is unconfirmed (Phase 1 probe found
 * no live evidence for either). Rather than guess a tool-result-shaped answer, this sends the
 * chosen answer as a plain new user turn — the same fallback the official app itself uses when it
 * can't route a tool_type:ask_user_question response ("...was replaced with this text message to
 * avoid errors"). This loses only tool-call linkage, not the ability to answer at all.
 */
export function AskUserQuestionPanel({ pendingQuestion, onAnswer }: Props) {
  const [text, setText] = useState('')

  return (
    <div className="ask-user-question-panel">
      <p className="ask-user-question-prompt">{pendingQuestion.prompt}</p>
      {pendingQuestion.options?.length ? (
        <div className="ask-user-question-options">
          {pendingQuestion.options.map((option) => (
            <button key={option} className="ask-user-question-option" onClick={() => onAnswer(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="ask-user-question-freetext"
          onSubmit={(e) => {
            e.preventDefault()
            if (text.trim()) onAnswer(text.trim())
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type your answer..."
            aria-label="Answer"
          />
          <button type="submit">Send</button>
        </form>
      )}
    </div>
  )
}
