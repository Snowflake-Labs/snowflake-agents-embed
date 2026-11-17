// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { memo, useEffect, useRef, useState } from 'react'
import type { ThinkingStep } from '../../types.js'
import { stepLabel } from '../../api/toolLabel.js'
import { MarkdownMessage } from './MarkdownMessage.js'
import { SqlBlock } from './SqlBlock.js'
import { ChevronDownIcon, ChevronRightIcon, SpinnerIcon, CheckIcon, WarningIcon } from './composer/icons.js'

interface Props {
  steps: ThinkingStep[]
  thinkingText?: string
  /** Live narration from the latest response.status event, while the turn is working. */
  statusLabel?: string
  /** Drives the auto-collapse: the panel is open while working, and folds up when it isn't. */
  streaming?: boolean
  /** Gates the inline SQL disclosure under each step - passed in rather than read from the
      store, so this component stays presentational. */
  showSql?: boolean
}

function StepIcon({ status }: { status: ThinkingStep['status'] }) {
  if (status === 'running') return <SpinnerIcon className="spinner" size={14} />
  if (status === 'error') return <WarningIcon className="error-icon" size={14} />
  return <CheckIcon className="check" size={14} />
}

function ThinkingStepsImpl({ steps, thinkingText, statusLabel, streaming, showSql }: Props) {
  // Expanded while the turn is working, folded to a summary once it finishes - the shape the
  // native app uses. Held as local state (not derived) so a user who opens a finished panel
  // keeps it open, and `userToggled` guards against the auto-collapse overriding that.
  const [collapsed, setCollapsed] = useState(!streaming)
  const userToggled = useRef(false)
  const wasStreaming = useRef(streaming)

  useEffect(() => {
    if (wasStreaming.current && !streaming && !userToggled.current) setCollapsed(true)
    if (!wasStreaming.current && streaming) { userToggled.current = false; setCollapsed(false) }
    wasStreaming.current = streaming
  }, [streaming])

  // An elapsed-time header, ported from the native app's ThinkingContainer. The header used to be
  // the latest status prose, which made it flicker between orchestration codes and then sit on
  // whichever one happened to be last; a timer is stable, always meaningful, and needs no wire
  // support. It counts up while working and freezes when the turn finishes.
  const startRef = useRef<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null)

  // Rising-edge reset, done during render rather than in the effect below: conditional setState
  // while rendering is React's sanctioned way to derive state from props, and React re-renders
  // with the cleared value before anything is painted. In an effect instead, a stale
  // "Thought for 14s" from the previous turn would be visible for one frame of the next one.
  const [prevStreaming, setPrevStreaming] = useState(streaming)
  if (streaming !== prevStreaming) {
    setPrevStreaming(streaming)
    if (streaming && elapsedSeconds !== null) setElapsedSeconds(null)
  }

  useEffect(() => {
    if (!streaming) { startRef.current = null; return }
    if (startRef.current === null) startRef.current = performance.now()
    const tick = () => {
      const start = startRef.current
      if (start === null) return
      // Rounded but floored at 1: a header that reads "Thinking for 0s" looks broken.
      setElapsedSeconds(Math.max(1, Math.round((performance.now() - start) / 1000)))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [streaming])

  // statusLabel is included: it can arrive before any step or thinking text exists, and it's
  // precisely that gap - the wait before the first token - that this panel needs to fill.
  if (steps.length === 0 && !thinkingText && !statusLabel) return null

  const doneCount = steps.filter((s) => s.status !== 'running').length
  // 'Thinking complete' covers a rehydrated turn, where reconstructTurns gives us no timing at
  // all. The native app has the same third branch for the same reason.
  const summary = streaming
    ? `Thinking for ${elapsedSeconds ?? 1}s${collapsed ? '...' : ''}`
    : elapsedSeconds !== null ? `Thought for ${elapsedSeconds}s` : 'Thinking complete'

  return (
    <div className={`thinking-steps${streaming ? ' thinking-steps--active' : ''}`}>
      <button
        className="steps-toggle"
        onClick={() => { userToggled.current = true; setCollapsed((c) => !c) }}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRightIcon size={14} /> : <ChevronDownIcon size={14} />}
        {/* No spinner here any more: a counting, shimmering header already reads as live, and the
            status line below has its own - two in one small panel was noise. */}
        <span className={`steps-summary${streaming ? ' shimmer' : ''}`}>{summary}</span>
        {streaming && steps.length > 0 && (
          <span className="steps-progress">{doneCount}/{steps.length}</span>
        )}
      </button>
      {!collapsed && (
        <>
          <ul className="steps-list">
            {steps.map((step) => (
              <li key={step.id} className={`step step-${step.status}`}>
                <div className="step-row">
                  <StepIcon status={step.status} />
                  {/* Our own tense-aware label wins for a tool type we recognise, and only an
                      unrecognised one falls through to the server's prose. Cortex's messages are
                      written once, for a running step, and never revised: the last of the six
                      tool_result.status events in a SQL round still reads "Executing SQL" after it
                      succeeded, and another of the six is a bare "Query ID: 01c6…". `label` stays as
                      the last resort - it's what reconstructTurns persists. */}
                  {stepLabel(step.toolType, step.status) ?? step.statusMessage ?? step.label}
                </div>
                {(step.automation || (showSql && step.sql)) && (
                  <div className="step-content">
                    {step.automation && (
                      <dl className="automation-step">
                        {step.automation.action && (
                          <div className="automation-step-field">
                            <dt>Action</dt><dd>{step.automation.action}</dd>
                          </div>
                        )}
                        {step.automation.schedule && (
                          <div className="automation-step-field">
                            <dt>Schedule</dt><dd>{step.automation.schedule}</dd>
                          </div>
                        )}
                        {step.automation.target && (
                          <div className="automation-step-field">
                            <dt>Target</dt><dd>{step.automation.target}</dd>
                          </div>
                        )}
                      </dl>
                    )}
                    {showSql && step.sql && <SqlBlock sql={step.sql} />}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {/* The live status line sits below the steps, as the one thing currently in flight.
              Suppressed while a step row is already narrating its own work. Shown with zero steps
              too - that pre-first-token wait is the case this narration exists for, and the header
              is now a timer rather than a place to put it. */}
          {streaming && statusLabel && !steps.some((s) => s.status === 'running') && (
            <div className="status-line">
              <SpinnerIcon className="spinner" size={14} />
              {statusLabel}
            </div>
          )}
          {/* Markdown, not raw text: reasoning routinely contains lists and emphasis, which
              rendered as literal asterisks before. */}
          {thinkingText && (
            <div className="thinking-text">
              <MarkdownMessage text={thinkingText} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Memoized alongside ConversationTurn - see MarkdownMessage for why the parse cost matters. */
export const ThinkingSteps = memo(ThinkingStepsImpl)
