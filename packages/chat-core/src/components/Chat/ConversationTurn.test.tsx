// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConversationTurn } from './ConversationTurn'
import type { ConversationTurn as TurnType } from '../../types.js'
import type { ShareButtonSlotProps } from './MessageActions.js'

// Host-agnostic coverage of ConversationTurn's own logic (savedSql/savedChartSpec
// derivation, the ShareButton slot). The full
// save-to-record pipeline through a real ShareButton is ui's integration test
// (packages/ui/src/components/Chat/ConversationTurn.test.tsx), since that behavior is
// specific to ui's ShareButton, not to this component.

function turn(overrides: Partial<TurnType> = {}): TurnType {
  return {
    id: 't1',
    role: 'assistant',
    steps: [],
    text: 'The Central region had the highest profit.',
    citations: [],
    artifacts: [],
    status: 'done',
    ...overrides,
  }
}

let shareButtonClick: (props: ShareButtonSlotProps) => void = () => {}
function FakeShareButton(props: ShareButtonSlotProps) {
  return <button onClick={() => shareButtonClick(props)}>Share</button>
}

beforeEach(() => {
  shareButtonClick = () => {}
  // ChartArtifact observes its container; jsdom has no ResizeObserver.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { cb([{ isIntersecting: true }]) }
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

describe('ConversationTurn', () => {
  it('forwards messageId and joins every SQL step for the ShareButton slot, ignoring the showSql toggle', () => {
    const onClick = vi.fn()
    shareButtonClick = onClick
    render(
      <ConversationTurn
        turn={turn({
          messageId: 288775,
          steps: [
            { id: 's1', toolType: 'cortex_analyst_text_to_sql', status: 'done', label: 'SQL', sql: 'SELECT 1' },
            { id: 's2', toolType: 'system_execute_sql', status: 'done', label: 'SQL', sql: 'SELECT 2' },
          ],
          artifacts: [{ id: 'a1', type: 'chart', spec: { mark: 'bar' } }],
        })}
        lastUserQuestion="Which region had the highest profit?"
        threadId={4611686018427387904}
        ShareButton={FakeShareButton}
      />,
    )
    screen.getByRole('button', { name: 'Share' }).click()
    expect(onClick).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 288775,
      sql: 'SELECT 1\n\nSELECT 2',
      chartSpec: { mark: 'bar' },
      question: 'Which region had the highest profit?',
    }))
  })

  it('sends the first chart when a turn produced several', () => {
    const onClick = vi.fn()
    shareButtonClick = onClick
    render(
      <ConversationTurn
        turn={turn({
          artifacts: [
            { id: 'a1', type: 'table', rowType: [{ name: 'REGION', type: 'text' }], data: [['Central']] },
            { id: 'a2', type: 'chart', spec: { mark: 'bar' } },
            { id: 'a3', type: 'chart', spec: { mark: 'line' } },
          ],
        })}
        ShareButton={FakeShareButton}
      />,
    )
    screen.getByRole('button', { name: 'Share' }).click()
    expect(onClick).toHaveBeenCalledWith(expect.objectContaining({ chartSpec: { mark: 'bar' } }))
  })

  it('offers no ShareButton slot while the turn is still streaming', () => {
    render(<ConversationTurn turn={turn({ status: 'streaming' })} ShareButton={FakeShareButton} />)
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
  })

  it('shows a verified-query badge when any step used a verified query', () => {
    render(
      <ConversationTurn
        turn={turn({
          steps: [{ id: 's1', toolType: 'system_execute_sql', status: 'done', label: 'SQL', verifiedQueryUsed: true }],
        })}
        ShareButton={FakeShareButton}
      />,
    )
    expect(screen.getByText('✓ Verified query')).toBeTruthy()
  })

  it('shows no verified-query badge when no step used a verified query', () => {
    render(
      <ConversationTurn
        turn={turn({
          steps: [{ id: 's1', toolType: 'system_execute_sql', status: 'done', label: 'SQL' }],
        })}
        ShareButton={FakeShareButton}
      />,
    )
    expect(screen.queryByText('✓ Verified query')).toBeNull()
  })

  it('renders the AskUserQuestionPanel instead of MessageActions when a pendingQuestion is set', () => {
    const onSuggestion = vi.fn()
    render(
      <ConversationTurn
        turn={turn({
          status: 'streaming',
          pendingQuestion: { toolUseId: 't1', toolType: 'ask_user_question', prompt: 'Which region?', options: ['Central', 'North'] },
        })}
        ShareButton={FakeShareButton}
        onSuggestion={onSuggestion}
      />,
    )
    expect(screen.getByText('Which region?')).toBeTruthy()
    screen.getByText('Central').click()
    expect(onSuggestion).toHaveBeenCalledWith('Central')
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
  })

  it('shows a "Copy request ID" button on an error turn only when requestId is set', () => {
    render(
      <ConversationTurn
        turn={turn({ status: 'error', errorMessage: 'boom', requestId: 'aa8e6f4b' })}
        ShareButton={FakeShareButton}
      />,
    )
    expect(screen.getByRole('button', { name: 'Copy request ID' })).toBeTruthy()
  })

  it('shows no "Copy request ID" button on an error turn without a requestId', () => {
    render(
      <ConversationTurn
        turn={turn({ status: 'error', errorMessage: 'boom' })}
        ShareButton={FakeShareButton}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Copy request ID' })).toBeNull()
  })

  it('does not render thumbs up/down when onFeedback is not provided', () => {
    render(<ConversationTurn turn={turn()} ShareButton={FakeShareButton} />)
    expect(screen.queryByTitle('Good response')).toBeNull()
  })

  it('opens a categorized dialog on thumbs up, then submits categories+comment through onFeedback', () => {
    const onFeedback = vi.fn()
    render(<ConversationTurn turn={turn()} ShareButton={FakeShareButton} onFeedback={onFeedback} />)

    fireEvent.click(screen.getByTitle('Good response'))
    fireEvent.click(screen.getByText('Accurate'))
    fireEvent.change(screen.getByLabelText('Feedback comment'), { target: { value: 'nice answer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onFeedback).toHaveBeenCalledWith(true, ['Accurate'], 'nice answer')
    expect(screen.getByText('Thanks for the feedback')).toBeTruthy()
    expect(screen.queryByTitle('Good response')).toBeNull()
  })

  it('opens a categorized dialog on thumbs down with the negative category list', () => {
    const onFeedback = vi.fn()
    render(<ConversationTurn turn={turn()} ShareButton={FakeShareButton} onFeedback={onFeedback} />)

    fireEvent.click(screen.getByTitle('Bad response'))
    expect(screen.getByText('Incorrect answer')).toBeTruthy()
    expect(screen.queryByText('Accurate')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onFeedback).toHaveBeenCalledWith(false, [], '')
  })

  it('cancels the feedback dialog without submitting', () => {
    const onFeedback = vi.fn()
    render(<ConversationTurn turn={turn()} ShareButton={FakeShareButton} onFeedback={onFeedback} />)

    fireEvent.click(screen.getByTitle('Good response'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onFeedback).not.toHaveBeenCalled()
    expect(screen.getByTitle('Good response')).toBeTruthy()
  })

  it('shows a "View all sources" button only when there is more than one citation', () => {
    const onViewCitations = vi.fn()
    const citations = [{ index: 1, docTitle: 'Doc A' }, { index: 2, docTitle: 'Doc B' }]
    render(
      <ConversationTurn
        turn={turn({ citations })}
        ShareButton={FakeShareButton}
        onViewCitations={onViewCitations}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'View all sources (2)' }))
    expect(onViewCitations).toHaveBeenCalledWith(citations)
  })

  it('shows no "View all sources" button with a single citation', () => {
    render(
      <ConversationTurn
        turn={turn({ citations: [{ index: 1, docTitle: 'Doc A' }] })}
        ShareButton={FakeShareButton}
        onViewCitations={vi.fn()}
      />,
    )
    expect(screen.queryByText(/View all sources/)).toBeNull()
  })

  it('shows "Refresh this thread" on a done-but-interrupted turn', () => {
    const onRefreshThread = vi.fn()
    render(
      <ConversationTurn
        turn={turn({ status: 'done', interrupted: true, text: 'partial' })}
        ShareButton={FakeShareButton}
        onRefreshThread={onRefreshThread}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByText(/This answer was interrupted/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
    screen.getByRole('button', { name: 'Refresh this thread' }).click()
    expect(onRefreshThread).toHaveBeenCalledOnce()
  })

  it('shows "Refresh this thread" instead of "Try again" on an interrupted turn', () => {
    const onRefreshThread = vi.fn()
    const onRetry = vi.fn()
    render(
      <ConversationTurn
        turn={turn({ status: 'error', interrupted: true })}
        ShareButton={FakeShareButton}
        onRefreshThread={onRefreshThread}
        onRetry={onRetry}
      />,
    )
    screen.getByRole('button', { name: 'Refresh this thread' }).click()
    expect(onRefreshThread).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('shows "Try again" (not "Refresh this thread") on a plain, non-interrupted error turn', () => {
    const onRetry = vi.fn()
    render(
      <ConversationTurn
        turn={turn({ status: 'error', errorMessage: 'boom' })}
        ShareButton={FakeShareButton}
        onRetry={onRetry}
        onRefreshThread={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Refresh this thread' })).toBeNull()
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('edits a user message and re-sends the edited text via onEditMessage', () => {
    const onEditMessage = vi.fn()
    render(
      <ConversationTurn
        turn={turn({ role: 'user', text: 'origianl typo' })}
        ShareButton={FakeShareButton}
        onEditMessage={onEditMessage}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const textarea = screen.getByDisplayValue('origianl typo') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'original, fixed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & resend' }))
    // Turn id first: these handlers are shared across the whole list, so the turn identifies
    // itself rather than each turn getting its own closure.
    expect(onEditMessage).toHaveBeenCalledWith('t1', 'original, fixed')
    expect(screen.queryByRole('button', { name: 'Save & resend' })).toBeNull()
  })

  it('cancels an edit without calling onEditMessage', () => {
    const onEditMessage = vi.fn()
    render(
      <ConversationTurn
        turn={turn({ role: 'user', text: 'keep me' })}
        ShareButton={FakeShareButton}
        onEditMessage={onEditMessage}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onEditMessage).not.toHaveBeenCalled()
    expect(screen.getByText('keep me')).toBeTruthy()
  })

  it('offers no edit button on an assistant turn even when onEditMessage is set', () => {
    render(
      <ConversationTurn
        turn={turn({ role: 'assistant' })}
        ShareButton={FakeShareButton}
        onEditMessage={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('renders a fork switcher when onSwitchFork is set, and calls it on click', () => {
    const onSwitchFork = vi.fn()
    render(<ConversationTurn turn={turn()} ShareButton={FakeShareButton} onSwitchFork={onSwitchFork} />)
    screen.getByRole('button', { name: /Switch to other response/ }).click()
    expect(onSwitchFork).toHaveBeenCalledWith('t1')
  })

  it('renders no fork switcher when onSwitchFork is not set', () => {
    render(<ConversationTurn turn={turn()} ShareButton={FakeShareButton} />)
    expect(screen.queryByRole('button', { name: /Switch to other response/ })).toBeNull()
  })

  it('does not open the right pane when a table is clicked or a column is sorted', () => {
    const onArtifactClick = vi.fn()
    render(
      <ConversationTurn
        turn={turn({
          artifacts: [{
            id: 'a1',
            type: 'table',
            rowType: [{ name: 'REGION', type: 'text' }, { name: 'SALES', type: 'NUMBER' }],
            data: [['Central', 100], ['East', 200]],
          }],
        })}
        ShareButton={FakeShareButton}
        onArtifactClick={onArtifactClick}
      />,
    )
    fireEvent.click(document.querySelector('.table-artifact')!)
    fireEvent.click(document.querySelector('.th-label')!)
    expect(onArtifactClick).not.toHaveBeenCalled()
    expect(document.querySelector('.artifact--clickable')).toBeNull()
  })

  it('does not inline Cortex TOOL_NOT_ACCESSIBLE or 003001 dumps in the thread', () => {
    const dump = "TOOL_NOT_ACCESSIBLE: DEMO_DB.AGENTS.JIRA_MCP (mcp_server) - MCP server 'DEMO_DB.AGENTS.JIRA_MCP' does not exist or access is not authorized for the current role."
    render(
      <ConversationTurn
        turn={turn({
          warnings: [
            { message: dump },
            { code: '003001', message: "User authentication required for MCP server 'DEMO_DB.AGENTS.JIRA_MCP'." },
          ],
        })}
        ShareButton={FakeShareButton}
      />,
    )
    expect(screen.queryByText(/TOOL_NOT_ACCESSIBLE/)).toBeNull()
    expect(screen.queryByText(/User authentication required/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open CoWork' })).toBeNull()
  })

  it('opens the right pane when a chart is clicked', () => {
    const onArtifactClick = vi.fn()
    const chart = { id: 'a1', type: 'chart' as const, spec: { mark: 'bar' } }
    render(
      <ConversationTurn
        turn={turn({ artifacts: [chart] })}
        ShareButton={FakeShareButton}
        onArtifactClick={onArtifactClick}
      />,
    )
    fireEvent.click(document.querySelector('.artifact--clickable')!)
    expect(onArtifactClick).toHaveBeenCalledWith(chart)
  })
})
