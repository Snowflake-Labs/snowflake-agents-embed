// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState, type ComponentType } from 'react'
import type { ConversationTurn } from '../../types.js'
import { turnToMarkdown } from '../../lib/turn-markdown.js'
import { useChatStore } from '../../store/chatStore.js'
import { getHostAdapter } from '../../host/hostAdapter.js'

/**
 * What every host's ShareButton must accept. ShareButton itself stays host-specific (tab
 * deep-links back into Teams) and is injected here rather
 * than imported directly, so this component doesn't have to know which host it's in.
 */
export interface ShareButtonSlotProps {
  answer: string
  question?: string
  title?: string
  threadId?: number
  messageId?: number
  sql?: string
  chartSpec?: unknown
  /** When true the turn is incomplete — hosts must not persist it as a finished answer. */
  interrupted?: boolean
}

interface Props {
  /** The whole turn, not just its text — a copy has to carry the answer's tables too. */
  turn: ConversationTurn
  question?: string
  title?: string
  threadId?: number
  messageId?: number
  sql?: string
  chartSpec?: unknown
  onRegenerate?: () => void
  onFeedback?: (positive: boolean) => void
  ShareButton: ComponentType<ShareButtonSlotProps>
}

export function MessageActions({
  turn,
  question,
  title,
  threadId,
  messageId,
  sql,
  chartSpec,
  onRegenerate,
  onFeedback,
  ShareButton,
}: Props) {
  const showSql = useChatStore((s) => s.showSql)
  const [copied, setCopied] = useState(false)

  // Markdown, not `turn.text`: the answer's data is in its artifacts, so copying the prose
  // alone pastes "Here are the sales by region:" with nothing under it. SQL rides along only
  // when the SQL toggle is on, matching what the user can currently see.
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(
        turnToMarkdown(turn, { includeSql: showSql, productName: getHostAdapter().productName }),
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard denied - nothing further to offer */
    }
  }

  return (
    <div className="message-actions">
      <button
        className="action-btn"
        onClick={handleCopy}
        title={showSql ? 'Copy this answer, its tables and its SQL' : 'Copy this answer and its tables'}
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
      <ShareButton
        answer={turn.text}
        question={question}
        title={title}
        threadId={threadId}
        messageId={messageId}
        sql={sql}
        chartSpec={chartSpec}
        interrupted={turn.interrupted}
      />
      {onRegenerate && (
        <button className="action-btn" onClick={onRegenerate} title="Regenerate response">
          Regenerate
        </button>
      )}
      {onFeedback && (
        <>
          <button className="action-btn" onClick={() => onFeedback(true)} title="Good response" aria-label="Good response">
            👍
          </button>
          <button className="action-btn" onClick={() => onFeedback(false)} title="Bad response" aria-label="Bad response">
            👎
          </button>
        </>
      )}
    </div>
  )
}
