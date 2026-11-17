// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { getHostAdapter } from '../host/hostAdapter.js'

/**
 * Submits feedback via Cortex's native Feedback REST API (server-proxied — see
 * packages/server/src/lib/feedback.ts / packages/relay/src/lib/feedback.ts).
 * Best-effort: swallows failures so a feedback submission never surfaces an
 * error in the chat UI. There is no `messageId` field — the native endpoint
 * only supports `thread_id` granularity, not per-turn.
 */
export async function submitFeedback(snowflakeToken: string, opts: {
  agentFqn: string
  positive: boolean
  feedbackMessage?: string
  categories?: string[]
  threadId?: number
}): Promise<void> {
  try {
    const adapter = getHostAdapter()
    await fetch(`${adapter.baseUrl()}/api/feedback`, {
      method: 'POST',
      headers: adapter.headers(snowflakeToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        agentFqn: opts.agentFqn,
        positive: opts.positive,
        feedbackMessage: opts.feedbackMessage,
        categories: opts.categories,
        threadId: opts.threadId,
      }),
    })
  } catch {
    // best-effort — a failed feedback submission must not disrupt the chat
  }
}
