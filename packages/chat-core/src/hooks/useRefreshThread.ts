// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useCallback } from 'react'
import { useChatStore } from '../store/chatStore.js'
import { describeThread, sortThreadMessages } from '../api/threads.js'
import { reconstructTurns } from '../api/reconstructTurns.js'

// Re-fetches an already-open thread's messages and replaces its turns in place - unlike
// useOpenThread, which opens a thread not yet in openThreads, this targets a thread that's
// already the active one. Used to recover an interrupted turn: Cortex may already have finished
// the answer server-side by the time the user notices the reload broke the live stream.
export function useRefreshThread(snowflakeToken: string) {
  const { hydrateThread } = useChatStore()

  const refreshThread = useCallback(
    async (tempId: string, threadId: number) => {
      const detail = await describeThread(snowflakeToken, threadId)
      const turns = reconstructTurns(detail.messages)
      const sorted = sortThreadMessages(detail.messages)
      const lastMessageId = sorted.length ? sorted[sorted.length - 1].message_id : undefined
      hydrateThread(tempId, turns, threadId, lastMessageId)
    },
    [snowflakeToken, hydrateThread],
  )

  return refreshThread
}
