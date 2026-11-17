// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useCallback } from 'react'
import { useChatStore } from '../store/chatStore.js'
import { describeThread, sortThreadMessages } from '../api/threads.js'
import { reconstructTurns } from '../api/reconstructTurns.js'
import { getThreadAgent } from '../lib/threadAgents.js'

export function useOpenThread(snowflakeToken: string) {
  // Actions only - zustand keeps their identities stable, so this subscribes to nothing that
  // changes while an answer streams. `openThreads`/`activeAgentFqn` are read via getState()
  // below rather than subscribed to: this is an event handler, so it wants the value at click
  // time, and subscribing to `openThreads` here would re-run every consumer on every delta.
  const newThread = useChatStore((s) => s.newThread)
  const hydrateThread = useChatStore((s) => s.hydrateThread)
  const activateThread = useChatStore((s) => s.activateThread)
  const setActiveView = useChatStore((s) => s.setActiveView)

  const openThread = useCallback(
    async (threadId: number) => {
      const { openThreads, activeAgentFqn } = useChatStore.getState()
      const existing = Object.values(openThreads).find((t) => t.threadId === threadId)
      if (existing) {
        activateThread(existing.tempId)
        setActiveView('chat')
        return
      }

      const agentFqn = getThreadAgent(threadId) ?? activeAgentFqn
      const tempId = newThread(agentFqn)
      setActiveView('chat')

      try {
        const detail = await describeThread(snowflakeToken, threadId)
        const turns = reconstructTurns(detail.messages)
        const sorted = sortThreadMessages(detail.messages)
        const lastMessageId = sorted.length ? sorted[sorted.length - 1].message_id : undefined
        hydrateThread(tempId, turns, threadId, lastMessageId)
      } catch { /* show empty thread on failure */ }
    },
    [newThread, hydrateThread, activateThread, setActiveView, snowflakeToken],
  )

  return openThread
}
