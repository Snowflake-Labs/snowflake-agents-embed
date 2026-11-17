// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { SearchView } from './SearchView'
import { searchThreads } from '../../api/threads'

vi.mock('../../api/threads.js', () => ({
  searchThreads: vi.fn(),
  listThreads: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  describeThread: vi.fn(),
}))

vi.mock('../../hooks/useOpenThread.js', () => ({
  useOpenThread: () => vi.fn(),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(searchThreads).mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('SearchView', () => {
  it('does not search until the query is at least 3 characters', async () => {
    render(<SearchView snowflakeToken="t" />)
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'ab' } })
    await vi.advanceTimersByTimeAsync(400)
    expect(searchThreads).not.toHaveBeenCalled()
  })

  it('aborts an in-flight search when the query changes', async () => {
    vi.useRealTimers()
    vi.mocked(searchThreads)
      .mockImplementationOnce((_t, _q, signal) => new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }))
      .mockResolvedValueOnce([{ thread_id: 2, thread_name: 'Later' }])

    render(<SearchView snowflakeToken="t" />)
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'aaa' } })
    await new Promise((r) => setTimeout(r, 320))
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'bbb' } })
    await waitFor(() => expect(screen.getByText('Later')).toBeTruthy())
    expect(searchThreads).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Search failed')).toBeNull()
  })

  it('shows each available latest-activity timestamp in the local date and time format', async () => {
    const updatedAt = '2026-09-22T10:42:00Z'
    const createdAt = '2026-09-21T09:30:00Z'
    vi.mocked(searchThreads).mockResolvedValue([
      {
        thread_id: 1,
        thread_name: 'Updated conversation',
        updated_at: updatedAt,
        created_at: '2026-01-01T00:00:00Z',
      },
      { thread_id: 2, thread_name: 'Created conversation', created_at: createdAt },
      { thread_id: 3, thread_name: 'Undated conversation' },
    ])
    const { container } = render(<SearchView snowflakeToken="t" />)

    fireEvent.change(screen.getByLabelText('Search conversations'), {
      target: { value: 'conversation' },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    const formatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
    expect(screen.getByText(formatter.format(new Date(updatedAt)))).toBeTruthy()
    expect(screen.getByText(formatter.format(new Date(createdAt)))).toBeTruthy()
    expect(screen.getByText('Undated conversation')).toBeTruthy()
    expect(container.querySelectorAll('time')).toHaveLength(2)
  })
})
