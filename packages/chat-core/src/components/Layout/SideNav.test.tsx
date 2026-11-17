// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { SideNav } from './SideNav'
import { useChatStore } from '../../store/chatStore'
import { listThreads } from '../../api/threads'

vi.mock('../../api/threads.js', () => ({
  listThreads: vi.fn().mockResolvedValue({ threads: [] }),
  describeThread: vi.fn(),
}))

beforeEach(() => {
  cleanup()
  vi.mocked(listThreads).mockClear()
  useChatStore.setState({
    threadSummaries: [],
    openThreads: {},
    activeThreadTempId: null,
    activeAgentFqn: 'DB.SCH.AGENT',
    activeView: 'chat',
  })
})

describe('SideNav collapsed rail', () => {
  it('hides the history list when collapsed and keeps New chat findable by name', async () => {
    render(
      <SideNav
        snowflakeToken="t"
        connected
        onNewChat={() => {}}
        collapsed
        onToggleCollapsed={() => {}}
      />,
    )

    await waitFor(() => expect(listThreads).toHaveBeenCalled())
    const list = document.querySelector('.history-list')
    expect(list?.hasAttribute('hidden')).toBe(true)
    // Kept mounted so expanding does not refetch - getByText still sees the title.
    expect(list?.textContent).toContain('History')
    expect(screen.getByRole('button', { name: /new chat/i })).toBeTruthy()
  })

  it('shows the history list when expanded', async () => {
    render(
      <SideNav
        snowflakeToken="t"
        connected
        onNewChat={() => {}}
        collapsed={false}
        onToggleCollapsed={() => {}}
      />,
    )

    await waitFor(() => expect(listThreads).toHaveBeenCalled())
    expect(document.querySelector('.history-list')?.hasAttribute('hidden')).toBe(false)
    expect(screen.getByText('History')).toBeTruthy()
    expect(screen.getByRole('button', { name: /new chat/i })).toBeTruthy()
  })

  it('shows the history list in the narrow drawer where collapsed is unset', async () => {
    render(<SideNav snowflakeToken="t" connected onNewChat={() => {}} />)

    await waitFor(() => expect(listThreads).toHaveBeenCalled())
    expect(document.querySelector('.history-list')?.hasAttribute('hidden')).toBe(false)
    expect(screen.getByText('History')).toBeTruthy()
  })
})
