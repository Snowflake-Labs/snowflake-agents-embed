// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useOpenThread } from './useOpenThread'
import { useChatStore } from '../store/chatStore.js'

beforeEach(() => {
  useChatStore.setState({
    agents: [],
    activeAgentFqn: 'DB.SCH.AG',
    threadSummaries: [],
    openThreads: {},
    activeThreadTempId: null,
    activeView: 'search',
    showSql: false,
    extendedThinking: false,
    deepResearch: false,
    selectedArtifact: null,
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useOpenThread', () => {
  it('activates an already-open thread and switches to chat view', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')
    useChatStore.setState((s) => ({
      openThreads: { ...s.openThreads, [tempId]: { ...s.openThreads[tempId], threadId: 42 } },
    }))
    useChatStore.getState().activateThread(tempId)

    const { result } = renderHook(() => useOpenThread('tok'))
    await act(async () => { await result.current(42) })

    const state = useChatStore.getState()
    expect(state.activeThreadTempId).toBe(tempId)
    expect(state.activeView).toBe('chat')
  })

  it('opens a new thread by fetching its messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        thread_id: 99,
        messages: [
          { message_id: 1, role: 'user', message_payload: { content: [{ type: 'text', text: 'hello' }] } },
        ],
      }), { status: 200 }),
    ))

    const { result } = renderHook(() => useOpenThread('tok'))
    await act(async () => { await result.current(99) })

    const state = useChatStore.getState()
    expect(state.activeView).toBe('chat')
    const active = state.openThreads[state.activeThreadTempId!]
    expect(active).toBeDefined()
    expect(active.threadId).toBe(99)
  })
})
