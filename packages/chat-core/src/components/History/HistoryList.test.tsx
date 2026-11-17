// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { HistoryList } from './HistoryList'
import { useChatStore } from '../../store/chatStore'
import { listThreads } from '../../api/threads'
import { setThreadAgent } from '../../lib/threadAgents'

vi.mock('../../api/threads.js', () => ({
  listThreads: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  describeThread: vi.fn(),
}))

const AGENT = 'DB.SCH.AGENT'

function daysAgoISO(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString()
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  useChatStore.setState({
    threadSummaries: [], openThreads: {}, activeThreadTempId: null, activeAgentFqn: AGENT,
  })
})

describe('HistoryList', () => {
  it('groups named threads by date and pages beyond the first 20', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      thread_id: i + 1,
      thread_name: `Thread ${i + 1}`,
      updated_at: daysAgoISO(0),
    }))
    many.forEach((t) => setThreadAgent(t.thread_id, AGENT))
    vi.mocked(listThreads)
      .mockResolvedValueOnce({ threads: many.slice(0, 20), after: 'next' })
      .mockResolvedValueOnce({ threads: many.slice(20) })

    render(<HistoryList snowflakeToken="t" connected />)
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy())
    expect(screen.getAllByText(/^Thread \d+$/)).toHaveLength(20)
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(screen.getAllByText(/^Thread \d+$/)).toHaveLength(25))
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('filters out threads belonging to a different agent', async () => {
    vi.mocked(listThreads).mockResolvedValue({
      threads: [
        { thread_id: 1, thread_name: 'Mine', updated_at: daysAgoISO(0) },
        { thread_id: 2, thread_name: 'Not mine', updated_at: daysAgoISO(0) },
      ],
    })
    setThreadAgent(1, AGENT)
    setThreadAgent(2, 'DB.SCH.OTHER')

    render(<HistoryList snowflakeToken="t" connected />)
    await waitFor(() => expect(screen.getByText('Mine')).toBeTruthy())
    expect(screen.queryByText('Not mine')).toBeNull()
  })

  it('hides unmapped threads by default but shows them when showUnmapped is set', async () => {
    vi.mocked(listThreads).mockResolvedValue({
      threads: [
        { thread_id: 1, thread_name: 'Mapped', updated_at: daysAgoISO(0) },
        { thread_id: 2, thread_name: 'Unmapped', updated_at: daysAgoISO(0) },
        { thread_id: 3, thread_name: 'Other agent', updated_at: daysAgoISO(0) },
      ],
    })
    setThreadAgent(1, AGENT)
    setThreadAgent(3, 'DB.SCH.OTHER')

    const { unmount } = render(<HistoryList snowflakeToken="t" connected />)
    await waitFor(() => expect(screen.getByText('Mapped')).toBeTruthy())
    expect(screen.queryByText('Unmapped')).toBeNull()
    unmount()

    render(<HistoryList snowflakeToken="t" connected showUnmapped />)
    await waitFor(() => expect(screen.getByText('Unmapped')).toBeTruthy())
    expect(screen.getByText('Mapped')).toBeTruthy()
    expect(screen.queryByText('Other agent')).toBeNull()
  })

  it('pinning a thread moves it into its own Pinned group above the date groups', async () => {
    vi.mocked(listThreads).mockResolvedValue({
      threads: [{ thread_id: 1, thread_name: 'Older thread', updated_at: daysAgoISO(60) }],
    })
    setThreadAgent(1, AGENT)

    render(<HistoryList snowflakeToken="t" connected />)
    await waitFor(() => expect(screen.getByText('Older thread')).toBeTruthy())
    expect(screen.queryByText('Pinned')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    expect(screen.getByText('Pinned')).toBeTruthy()
  })

  it('archiving a thread hides it unless "Show archived" is checked', async () => {
    vi.mocked(listThreads).mockResolvedValue({
      threads: [{ thread_id: 1, thread_name: 'Archive me', updated_at: daysAgoISO(0) }],
    })
    setThreadAgent(1, AGENT)

    render(<HistoryList snowflakeToken="t" connected />)
    await waitFor(() => expect(screen.getByText('Archive me')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(screen.queryByText('Archive me')).toBeNull()

    fireEvent.click(screen.getByLabelText('Show archived'))
    expect(screen.getByText('Archive me')).toBeTruthy()
  })

  it('shows a classified message with the raw error behind a details disclosure when listThreads fails', async () => {
    vi.mocked(listThreads).mockRejectedValue(new Error('network down'))
    render(<HistoryList snowflakeToken="t" connected />)
    await waitFor(() => expect(screen.getByText("Couldn't reach Snowflake. Check your connection and try again.")).toBeTruthy())
    expect(screen.getByText('network down')).toBeTruthy()
  })
})
