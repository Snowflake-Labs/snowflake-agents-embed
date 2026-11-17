// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useMemo, useRef, useState, memo } from 'react'
import type { ComponentType } from 'react'
import type { ConversationTurn as TurnType, Artifact, Citation, ChartArtifact as ChartArtifactType } from '../../types.js'
import { ThinkingSteps } from './ThinkingSteps.js'
import { ChartArtifact } from '../Artifact/ChartArtifact.js'
import { TableArtifact } from '../Artifact/TableArtifact.js'
import { MapArtifact } from '../Artifact/MapArtifact.js'
import { LazyMount } from '../Artifact/LazyMount.js'
import { MarkdownMessage } from './MarkdownMessage.js'
import { splitStreamingMarkdown } from '../../lib/splitStreamingMarkdown.js'
import { CitationList } from '../Citation/CitationPopover.js'
import { MessageActions, type ShareButtonSlotProps } from './MessageActions.js'
import { FeedbackDialog } from './FeedbackDialog.js'
import { Suggestions } from './Suggestions.js'
import { AskUserQuestionPanel } from './AskUserQuestionPanel.js'
import { ForkSwitcher } from './ForkSwitcher.js'
import { useChatStore } from '../../store/chatStore.js'

// Mirrors AutoResizePlugin's composer growth cap - an edited message can run longer than
// a fresh composer draft, so this allows more room before it scrolls internally.
const EDIT_MIN_HEIGHT_PX = 20
const EDIT_MAX_HEIGHT_PX = 400

interface Props {
  turn: TurnType
  lastUserQuestion?: string
  threadTitle?: string
  threadId?: number
  ShareButton: ComponentType<ShareButtonSlotProps>
  onRetry?: () => void
  onRefreshThread?: () => void
  /**
   * These three take the turn id rather than closing over it so ChatContainer can pass one
   * stable useCallback per handler for the whole list. Closures built inside the render's
   * turns.map() gave every turn new props on every streamed delta, which made the memo on this
   * component useless.
   */
  onRegenerate?: (turnId: string) => void
  /** User turns only - re-sends the edited text, dropping this turn and everything after it. */
  onEditMessage?: (turnId: string, newText: string) => void
  /** Set when this turn is a fork point with a displaced alternate branch still available. */
  onSwitchFork?: (turnId: string) => void
  onSuggestion?: (text: string) => void
  onArtifactClick?: (artifact: Artifact) => void
  onFeedback?: (positive: boolean, categories?: string[], comment?: string) => void
  onViewCitations?: (citations: Citation[]) => void
}

function ConversationTurnImpl({
  turn,
  lastUserQuestion,
  threadTitle,
  threadId,
  ShareButton,
  onRetry,
  onRegenerate,
  onRefreshThread,
  onEditMessage,
  onSwitchFork,
  onSuggestion,
  onArtifactClick,
  onFeedback,
  onViewCitations,
}: Props) {
  // Selector, not the whole store: this component is rendered once per turn, so an unscoped
  // subscription re-rendered (and re-parsed the markdown of) every turn in the transcript on
  // every streamed delta.
  const showSql = useChatStore((s) => s.showSql)
  const [feedbackDialog, setFeedbackDialog] = useState<boolean | null>(null)
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)
  const isDone = turn.status === 'done'
  // A pending question pauses the turn — it's not "done" (no final event arrived) but it's
  // also not actively streaming, so the cursor/typing indicator shouldn't show either.
  const isStreaming = turn.status === 'streaming' && !turn.pendingQuestion

  const verifiedQueryUsed = useMemo(() => turn.steps.some((s) => s.verifiedQueryUsed), [turn.steps])
  const streamedMarkdown = useMemo(
    () => (isStreaming && turn.role === 'assistant' ? splitStreamingMarkdown(turn.text) : null),
    [isStreaming, turn.role, turn.text],
  )

  // What a save carries, derived from the turn rather than from what is on screen.
  // Deliberately NOT sqlSteps: that list is gated by the showSql toggle, and whether the
  // saved row records the query must not depend on a display preference. All SQL steps are
  // joined because a multi-step answer needs every query to be reproducible, not just the
  // last one. Only the first chart is sent - a host that saves one spec per answer needs
  // the one the answer text is written about.
  const savedSql = useMemo(
    () => turn.steps.map((s) => s.sql).filter(Boolean).join('\n\n') || undefined,
    [turn.steps],
  )
  const savedChartSpec = useMemo(
    () => turn.artifacts.find((a): a is ChartArtifactType => a.type === 'chart')?.spec,
    [turn.artifacts],
  )

  // Without this the textarea keeps its browser-default ~2-row height and the edited
  // message's own text scrolls inside it - it needs to size to content the instant edit
  // mode opens, not just as the user types.
  useLayoutEffect(() => {
    if (!isEditing) return
    const el = editTextareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.max(EDIT_MIN_HEIGHT_PX, Math.min(el.scrollHeight, EDIT_MAX_HEIGHT_PX))}px`
  }, [isEditing, editValue])

  return (
    <div className={`turn turn-${turn.role} turn-status-${turn.status}`}>
      {turn.role === 'assistant' && (
        <ThinkingSteps
          steps={turn.steps}
          thinkingText={turn.thinking}
          statusLabel={turn.statusLabel}
          streaming={isStreaming}
          showSql={showSql}
        />
      )}
      <div className="turn-text">
        {turn.role === 'assistant'
          ? streamedMarkdown
            ? (
              <>
                {streamedMarkdown.prefix ? <MarkdownMessage text={streamedMarkdown.prefix} /> : null}
                <MarkdownMessage text={streamedMarkdown.tail} streaming />
              </>
            )
            : <MarkdownMessage text={turn.text} />
          : isEditing
            ? (
              <textarea
                ref={editTextareaRef}
                className="edit-message-textarea"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                autoFocus
              />
            )
            : (
              <>
                {turn.text}
                {isStreaming && <span className="cursor">▌</span>}
              </>
            )
        }
      </div>
      {turn.role === 'user' && onEditMessage && (
        isEditing ? (
          <div className="edit-message-actions">
            <button
              className="action-btn"
              onClick={() => { onEditMessage(turn.id, editValue.trim()); setIsEditing(false) }}
              disabled={!editValue.trim()}
            >
              Save & resend
            </button>
            <button className="action-btn" onClick={() => setIsEditing(false)}>Cancel</button>
          </div>
        ) : (
          <button
            className="action-btn edit-message-btn"
            onClick={() => { setEditValue(turn.text); setIsEditing(true) }}
            title="Edit message"
          >
            Edit
          </button>
        )
      )}
      <CitationList citations={turn.citations} />
      {turn.citations.length > 1 && onViewCitations && (
        <button className="action-btn view-sources-btn" onClick={() => onViewCitations(turn.citations)}>
          View all sources ({turn.citations.length})
        </button>
      )}
      {turn.role === 'assistant' && verifiedQueryUsed && (
        <div className="verified-query-badge" title="This answer used a Cortex Analyst verified query">
          ✓ Verified query
        </div>
      )}
      {(turn.status === 'error' || (turn.status === 'done' && turn.interrupted)) && (
        <div className="turn-error">
          {turn.interrupted
            ? "This answer was interrupted. Refreshing checks whether Cortex already finished it."
            : turn.errorMessage}
          {turn.requestId && (
            <button
              className="action-btn"
              onClick={() => { navigator.clipboard.writeText(turn.requestId!).catch(() => {}) }}
              title="Copy request ID"
            >
              Copy request ID
            </button>
          )}
          {turn.interrupted && onRefreshThread
            ? <button onClick={onRefreshThread}>Refresh this thread</button>
            : (onRetry && <button onClick={onRetry}>Try again</button>)}
        </div>
      )}
      {turn.artifacts.map((artifact) => {
        const canOpen = artifact.type !== 'table' ? onArtifactClick : undefined
        return (
          <div
            key={artifact.id}
            className={`artifact${canOpen ? ' artifact--clickable' : ''}`}
            onClick={canOpen ? () => canOpen(artifact) : undefined}
            role={canOpen ? 'button' : undefined}
            tabIndex={canOpen ? 0 : undefined}
            onKeyDown={canOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') canOpen(artifact) } : undefined}
          >
            <LazyMount>
              {artifact.type === 'chart' && (
                <ChartArtifact spec={artifact.spec as any} />
              )}
              {artifact.type === 'map' && (
                <MapArtifact spec={artifact.spec} />
              )}
              {artifact.type === 'table' && (
                <TableArtifact
                  rowType={artifact.rowType}
                  data={artifact.data}
                  numRows={artifact.numRows}
                  title={artifact.title}
                />
              )}
            </LazyMount>
          </div>
        )
      })}
      {turn.role === 'assistant' && turn.pendingQuestion && onSuggestion && (
        <AskUserQuestionPanel pendingQuestion={turn.pendingQuestion} onAnswer={onSuggestion} />
      )}
      {turn.role === 'assistant' && isDone && !turn.interrupted && turn.suggestions?.length && onSuggestion && (
        <Suggestions suggestions={turn.suggestions} onSend={onSuggestion} />
      )}
      {turn.role === 'assistant' && isDone && !turn.interrupted && (
        <MessageActions
          turn={turn}
          question={lastUserQuestion}
          title={threadTitle}
          threadId={threadId}
          messageId={turn.messageId}
          sql={savedSql}
          chartSpec={savedChartSpec}
          onRegenerate={onRegenerate ? () => onRegenerate(turn.id) : undefined}
          onFeedback={onFeedback && !feedbackSubmitted ? (positive) => setFeedbackDialog(positive) : undefined}
          ShareButton={ShareButton}
        />
      )}
      {turn.role === 'assistant' && isDone && !turn.interrupted && feedbackSubmitted && (
        <div className="feedback-thanks">Thanks for the feedback</div>
      )}
      {turn.role === 'assistant' && feedbackDialog !== null && onFeedback && (
        <FeedbackDialog
          positive={feedbackDialog}
          onSubmit={(categories, comment) => {
            onFeedback(feedbackDialog, categories, comment)
            setFeedbackSubmitted(true)
            setFeedbackDialog(null)
          }}
          onCancel={() => setFeedbackDialog(null)}
        />
      )}
      {onSwitchFork && <ForkSwitcher onSwitch={() => onSwitchFork(turn.id)} />}
    </div>
  )
}

/**
 * Memoized: one streamed delta updates exactly one turn's object, so with stable callback props
 * from ChatContainer every other turn in the transcript skips re-rendering - and, more to the
 * point, skips re-parsing its markdown.
 */
export const ConversationTurn = memo(ConversationTurnImpl)
