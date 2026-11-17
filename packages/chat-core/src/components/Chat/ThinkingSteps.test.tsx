// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ThinkingSteps } from './ThinkingSteps'

afterEach(() => { vi.useRealTimers() })

describe('ThinkingSteps', () => {
  it('prefers our own tense-aware label over the server prose for a known tool type', () => {
    render(
      <ThinkingSteps
        streaming
        steps={[{ id: 's1', toolType: 'system_agentic_semantic_context', status: 'running', label: 'Running system_agentic_semantic_context...', statusMessage: 'Running Sales_Analyst' }]}
      />,
    )
    expect(screen.getByText('Reviewing context')).toBeTruthy()
    expect(screen.queryByText('Running Sales_Analyst')).toBeNull()
    expect(screen.queryByText('Running system_agentic_semantic_context...')).toBeNull()
  })

  it('reads a finished step in the past tense, ignoring the stale running-tense server prose', () => {
    // The regression this exists for: the last of six tool_result.status events in a SQL round
    // carries the message "Executing SQL" even though status is SUCCESS, so the row used to read
    // as still running forever after it finished.
    render(
      <ThinkingSteps
        steps={[{ id: 's1', toolType: 'system_execute_sql', status: 'done', label: 'Executing SQL...', statusMessage: 'Executing SQL' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Retrieved data')).toBeTruthy()
    expect(screen.queryByText('Executing SQL')).toBeNull()
  })

  it('never shows a raw query id as the step text', () => {
    render(
      <ThinkingSteps
        streaming
        steps={[{ id: 's1', toolType: 'system_execute_sql', status: 'running', label: 'Executing SQL...', statusMessage: 'Query ID: 01c6cdbc-0004-0160-0001-05160cd4f866' }]}
      />,
    )
    expect(screen.getByText('Querying data')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Query ID')
  })

  it('falls back to the server prose for a tool type we do not map', () => {
    render(
      <ThinkingSteps
        streaming
        steps={[{ id: 's1', toolType: 'some_future_tool', status: 'running', label: 'Running some_future_tool...', statusMessage: 'Computing Pearson correlation' }]}
      />,
    )
    expect(screen.getByText('Computing Pearson correlation')).toBeTruthy()
  })

  it('falls back to the static label for an unmapped tool with no statusMessage', () => {
    render(
      <ThinkingSteps streaming steps={[{ id: 's1', toolType: 'some_future_tool', status: 'running', label: 'Running some_future_tool...' }]} />,
    )
    expect(screen.getByText('Running some_future_tool...')).toBeTruthy()
  })

  it('renders a schedule_snowflake_task step as a first-class action/schedule/target card', () => {
    render(
      <ThinkingSteps
        streaming
        steps={[{
          id: 's1', toolType: 'schedule_snowflake_task', status: 'done', label: 'Managing a scheduled task...',
          automation: { action: 'setup', schedule: '0 9 * * *', target: 'nightly_refresh' },
        }]}
      />,
    )
    expect(screen.getByText('setup')).toBeTruthy()
    expect(screen.getByText('0 9 * * *')).toBeTruthy()
    expect(screen.getByText('nightly_refresh')).toBeTruthy()
  })

  it('renders no automation card for a step without automation info', () => {
    render(
      <ThinkingSteps steps={[{ id: 's1', toolType: 'system_execute_sql', status: 'done', label: 'Executing SQL...' }]} />,
    )
    expect(document.querySelector('.automation-step')).toBeNull()
  })

  it('renders nothing when there are no steps and no thinkingText', () => {
    const { container } = render(<ThinkingSteps steps={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when there are no steps and thinkingText is empty', () => {
    const { container } = render(<ThinkingSteps steps={[]} thinkingText="" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders thinkingText in .thinking-text even with zero steps', () => {
    render(<ThinkingSteps streaming steps={[]} thinkingText="This looks like a verified query." />)
    expect(screen.getByText('This looks like a verified query.')).toBeTruthy()
    expect(document.querySelector('.thinking-text')).toBeTruthy()
  })

  it('renders the status narration before any step exists', () => {
    render(<ThinkingSteps streaming steps={[]} statusLabel="Planning the next steps" />)
    // In the status line below the (empty) step list - the header is a timer now, so this is the
    // only place left to show what the agent is doing during the pre-first-token wait.
    expect(screen.getByText('Planning the next steps')).toBeTruthy()
    expect(document.querySelector('.status-line')).toBeTruthy()
  })

  it('starts collapsed for a finished turn and expands on click', () => {
    render(
      <ThinkingSteps steps={[{ id: 's1', toolType: 'cortex_search', status: 'done', label: 'Searching Cortex Search...' }]} />,
    )
    expect(screen.queryByText('Searched sources')).toBeNull()
    expect(screen.getByText('Thinking complete')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Searched sources')).toBeTruthy()
  })

  it('auto-collapses when the turn stops streaming', () => {
    const step = { id: 's1', toolType: 'cortex_search', status: 'done' as const, label: 'Searching Cortex Search...' }
    const { rerender } = render(<ThinkingSteps streaming steps={[step]} />)
    expect(screen.getByText('Searched sources')).toBeTruthy()
    rerender(<ThinkingSteps streaming={false} steps={[step]} />)
    expect(screen.queryByText('Searched sources')).toBeNull()
  })

  it('does not auto-collapse a panel the user opened themselves', () => {
    const step = { id: 's1', toolType: 'cortex_search', status: 'done' as const, label: 'Searching Cortex Search...' }
    const { rerender } = render(<ThinkingSteps streaming steps={[step]} />)
    // Collapse, then re-open - the explicit re-open must survive the turn finishing.
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button'))
    rerender(<ThinkingSteps streaming={false} steps={[step]} />)
    expect(screen.getByText('Searched sources')).toBeTruthy()
  })

  it('shows step progress while streaming', () => {
    render(
      <ThinkingSteps
        streaming
        steps={[
          { id: 's1', toolType: 'cortex_search', status: 'done', label: 'a' },
          { id: 's2', toolType: 'system_execute_sql', status: 'running', label: 'b' },
        ]}
      />,
    )
    expect(screen.getByText('1/2')).toBeTruthy()
  })

  it('shows an inline SQL disclosure under the step that produced it, collapsed by default', () => {
    render(
      <ThinkingSteps
        showSql
        steps={[{ id: 's1', toolType: 'system_execute_sql', status: 'done', label: 'SQL', sql: 'SELECT 1' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Thinking complete|Thought/ }))
    expect(screen.getByText('View SQL')).toBeTruthy()
    expect(screen.queryByText('SELECT 1')).toBeNull()
  })

  it('renders no View SQL button when showSql is false', () => {
    render(
      <ThinkingSteps
        steps={[{ id: 's1', toolType: 'system_execute_sql', status: 'done', label: 'SQL', sql: 'SELECT 1' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Thinking complete|Thought/ }))
    expect(screen.queryByText('View SQL')).toBeNull()
  })

  it('nests the SQL block inside the step li, not as a sibling of the list', () => {
    render(
      <ThinkingSteps
        showSql
        steps={[{ id: 's1', toolType: 'system_execute_sql', status: 'done', label: 'SQL', sql: 'SELECT 1' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Thinking complete|Thought/ }))
    const li = document.querySelector('li.step')
    expect(li?.querySelector('.sql-block')).toBeTruthy()
  })
})

describe('ThinkingSteps elapsed-time header', () => {
  const step = { id: 's1', toolType: 'cortex_search', status: 'running' as const, label: 'x' }

  // The header measures with performance.now(), which vitest does not fake by default - without
  // it in `toFake` the clock advances but the reading never moves off 1s.
  const useClock = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] })

  it('starts at 1s rather than 0s and counts up', () => {
    useClock()
    render(<ThinkingSteps streaming steps={[step]} />)
    // Immediately, not only after the first interval fires.
    expect(screen.getByText('Thinking for 1s')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByText('Thinking for 3s')).toBeTruthy()
  })

  it('freezes to the past tense when the turn stops streaming', () => {
    useClock()
    const { rerender } = render(<ThinkingSteps streaming steps={[step]} />)
    act(() => { vi.advanceTimersByTime(5000) })
    rerender(<ThinkingSteps streaming={false} steps={[step]} />)
    expect(screen.getByText('Thought for 5s')).toBeTruthy()
    // The interval is torn down with the effect, so the frozen value stays frozen. This matters
    // more than it looks: it is a live timer inside a Visualforce iframe.
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(screen.getByText('Thought for 5s')).toBeTruthy()
  })

  it('resets rather than leaking the previous duration into the next turn', () => {
    useClock()
    const { rerender } = render(<ThinkingSteps streaming steps={[step]} />)
    act(() => { vi.advanceTimersByTime(13_000) })
    rerender(<ThinkingSteps streaming={false} steps={[step]} />)
    expect(screen.getByText('Thought for 13s')).toBeTruthy()
    rerender(<ThinkingSteps streaming steps={[step]} />)
    expect(screen.getByText('Thinking for 1s')).toBeTruthy()
  })

  it('reads "Thinking complete" for a turn that was never streamed in this session', () => {
    render(<ThinkingSteps streaming={false} steps={[step]} />)
    expect(screen.getByText('Thinking complete')).toBeTruthy()
  })

  it('appends an ellipsis while streaming and collapsed, and shimmers only while streaming', () => {
    useClock()
    const { rerender } = render(<ThinkingSteps streaming steps={[step]} />)
    expect(screen.getByText('Thinking for 1s')).toBeTruthy()
    expect(document.querySelector('.steps-summary.shimmer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Thinking for 1s...')).toBeTruthy()
    rerender(<ThinkingSteps streaming={false} steps={[step]} />)
    expect(document.querySelector('.steps-summary.shimmer')).toBeNull()
  })
})
