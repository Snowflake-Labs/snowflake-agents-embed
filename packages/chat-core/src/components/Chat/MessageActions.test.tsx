// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MessageActions } from './MessageActions'
import { useChatStore } from '../../store/chatStore'
import type { ConversationTurn } from '../../types'

const FakeShareButton = () => <button>Share</button>

function turn(partial: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 't', role: 'assistant', steps: [], text: 'the answer',
    citations: [], artifacts: [], status: 'done', ...partial,
  }
}

describe('MessageActions', () => {
  beforeEach(() => {
    if (useChatStore.getState().showSql) useChatStore.getState().toggleShowSql()
  })

  it('copies the answer with its table, not just the prose', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    render(
      <MessageActions
        turn={turn({
          text: 'Here are the total sales by region:',
          artifacts: [{
            id: 'a1', type: 'table',
            rowType: [{ name: 'REGION', type: 'TEXT' }, { name: 'SALES', type: 'FIXED' }],
            data: [['Central', 1000]],
          }],
        })}
        ShareButton={FakeShareButton}
      />,
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })

    const copied = writeText.mock.calls[0][0]
    expect(copied).toContain('Here are the total sales by region:')
    expect(copied).toContain('| Central | 1000 |')

    vi.unstubAllGlobals()
  })

  it('includes SQL only while the SQL toggle is on', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    const t = turn({
      steps: [{ id: 's1', toolType: 'system_execute_sql', status: 'done', label: 'SQL', sql: 'SELECT 1' }],
    })
    const { rerender } = render(<MessageActions turn={t} ShareButton={FakeShareButton} />)
    // Held by reference: after the first click the label reads "✓ Copied" for 2s, so it can't
    // be found by name again.
    const copyBtn = screen.getByRole('button', { name: 'Copy' })
    await act(async () => { fireEvent.click(copyBtn) })
    expect(writeText.mock.calls[0][0]).not.toContain('SELECT 1')

    useChatStore.getState().toggleShowSql()
    rerender(<MessageActions turn={t} ShareButton={FakeShareButton} />)
    await act(async () => { fireEvent.click(copyBtn) })
    expect(writeText.mock.calls[1][0]).toContain('SELECT 1')

    vi.unstubAllGlobals()
  })

  // The dead-end /share?s= link: nothing in the repo ever served that route, so pasting one
  // gave you a base64 blob that resolved to nothing.
  it('no longer offers a share link', () => {
    render(<MessageActions turn={turn()} ShareButton={FakeShareButton} />)
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
  })

  it('confirms the copy happened', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    render(<MessageActions turn={turn()} ShareButton={FakeShareButton} />)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
    expect(await screen.findByRole('button', { name: '✓ Copied' })).toBeTruthy()

    vi.unstubAllGlobals()
  })

  it('renders Regenerate only when onRegenerate is provided', () => {
    render(<MessageActions turn={turn()} ShareButton={FakeShareButton} />)
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull()

    render(<MessageActions turn={turn()} ShareButton={FakeShareButton} onRegenerate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy()
  })
})
