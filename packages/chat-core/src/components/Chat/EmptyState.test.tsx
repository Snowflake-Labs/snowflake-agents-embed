// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmptyState } from './EmptyState'

describe('EmptyState starter list', () => {
  it('omits the starter list when questions are missing, loading, or empty', () => {
    const { container, rerender } = render(<EmptyState onSend={() => {}} />)
    expect(container.querySelector('.starter-list')).toBeNull()
    expect(screen.queryByText('What are my top 10 customers by revenue?')).toBeNull()

    rerender(<EmptyState onSend={() => {}} questions={undefined} />)
    expect(container.querySelector('.starter-list')).toBeNull()

    rerender(<EmptyState onSend={() => {}} questions={[]} />)
    expect(container.querySelector('.starter-list')).toBeNull()
  })

  it('renders only the fetched questions, never a hardcoded fallback', () => {
    render(<EmptyState onSend={() => {}} questions={['Profit by region?']} />)
    expect(screen.getByText('Profit by region?')).toBeTruthy()
    expect(screen.queryByText('What are my top 10 customers by revenue?')).toBeNull()
    expect(screen.queryByText('Summarize last month\'s sales performance.')).toBeNull()
  })

  it('remounts the list (fresh DOM nodes) when activeAgentFqn changes, even with a shared question', () => {
    const shared = 'Show me inventory levels'
    const { container, rerender } = render(
      <EmptyState onSend={() => {}} questions={[shared]} activeAgentFqn="DB.SCH.AGENT_A" />,
    )
    const firstNode = container.querySelector('.starter-list')

    rerender(<EmptyState onSend={() => {}} questions={[shared]} activeAgentFqn="DB.SCH.AGENT_B" />)
    const secondNode = container.querySelector('.starter-list')

    expect(secondNode).not.toBe(firstNode)
  })
})

// 14:00 local — pins the time-of-day greeting so the assertions are about the name.
function atAfternoon(fn: () => void) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 7, 27, 14, 0, 0))
  fn()
}

describe('EmptyState greeting', () => {
  afterEach(() => { vi.useRealTimers() })

  it('greets without a name when the host has none', () => {
    atAfternoon(() => {
      render(<EmptyState onSend={() => {}} />)
      expect(screen.getByText('Good afternoon')).toBeTruthy()
    })
  })

  it('greets with the first name only when the host sends a full name (Teams)', () => {
    atAfternoon(() => {
      render(<EmptyState onSend={() => {}} userName="Jordan Rivera" />)
      expect(screen.getByText('Good afternoon, Jordan')).toBeTruthy()
    })
  })

  it('leaves an already-first-name unchanged (Salesforce)', () => {
    atAfternoon(() => {
      render(<EmptyState onSend={() => {}} userName="jordan" />)
      expect(screen.getByText('Good afternoon, jordan')).toBeTruthy()
    })
  })

  it('varies the greeting by time of day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 27, 8, 0, 0))
    render(<EmptyState onSend={() => {}} userName="Jordan Rivera" />)
    expect(screen.getByText('Good morning, Jordan')).toBeTruthy()
  })
})
