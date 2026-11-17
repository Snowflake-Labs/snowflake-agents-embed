// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useRefreshThread } from './useRefreshThread'
import { useChatStore } from '../store/chatStore.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useRefreshThread', () => {
  it('re-fetches an open thread and replaces its turns in place', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')
    useChatStore.getState().reconcileThreadId(tempId, 42)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        thread_id: 42,
        messages: [
          { message_id: 1, role: 'user', message_payload: { content: [{ type: 'text', text: 'hello' }] } },
          { message_id: 2, role: 'assistant', message_payload: { content: [{ type: 'text', text: 'hi there' }] } },
        ],
      }), { status: 200 }),
    ))

    const { result } = renderHook(() => useRefreshThread('tok'))
    await act(async () => { await result.current(tempId, 42) })

    const t = useChatStore.getState().openThreads[tempId]
    expect(t.threadId).toBe(42)
    expect(t.turns).toHaveLength(2)
    expect(t.turns[1].text).toBe('hi there')
    expect(t.thread.lastAssistantMessageId).toBe(2)
  })
})
