// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { buildAgentRunUrl, type CortexAgentRef } from '@snowflake-agents-embed/cortex-server/snowflake/agent-ref'
import { parseSseStream, type AgentEvent } from '@snowflake-agents-embed/chat-core/api/sseParser'
import {
  snowflakeBase,
  snowflakeHeaders,
  type SnowflakeTokenType,
} from '@snowflake-agents-embed/cortex-server/snowflake/credential'

export type { CortexAgentRef, AgentEvent }

export interface CortexAgentOptions {
  agent: CortexAgentRef
  query: string
  snowflakeToken: string
  snowflakeAccount: string
  tokenType?: SnowflakeTokenType
  threadId?: number
  parentMessageId?: number
  timeoutMs?: number
}

/**
 * Streams a Cortex agent run incrementally over SSE, reusing chat-core's `parseSseStream`/
 * `parseSseEvent` instead of a second hand-rolled SSE loop - the bot now parses events
 * identically to the tab/ui clients. Replaces the old buffer-then-filter `callCortexAgent`,
 * which discarded everything until the whole response arrived and hit its own 12s timeout on
 * any answer that took longer - the caller (bot/handler.ts) accumulates text and posts/updates
 * the Teams message as events arrive instead of waiting for the end.
 */
export async function* streamCortexAgent(opts: CortexAgentOptions): AsyncGenerator<AgentEvent> {
  const { query, snowflakeToken, snowflakeAccount, tokenType = 'OAUTH', timeoutMs = 55000 } = opts
  const url = buildAgentRunUrl(snowflakeAccount, opts.agent)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: snowflakeHeaders({ token: snowflakeToken, tokenType }, 'text/event-stream'),
      body: JSON.stringify({
        // With no thread, omit both: Cortex rejects `0` as a reference to a nonexistent
        // thread. With a thread, parent_message_id is required (400 "cannot be null"), and
        // 0 means the first message of a freshly created thread.
        ...(opts.threadId
          ? { thread_id: opts.threadId, parent_message_id: opts.parentMessageId ?? 0 }
          : opts.parentMessageId ? { parent_message_id: opts.parentMessageId } : {}),
        messages: [{ role: 'user', content: [{ type: 'text', text: query }] }],
        stream: true,
      }),
    })
    if (!res.ok) throw new Error(`Cortex Agents API error: ${res.status}`)
    yield* parseSseStream(res)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cortex only returns a thread_id on a run that was given one, so a new bot conversation
 * must create its thread first (as the tab does). Best-effort: undefined means "run
 * without a thread" and the deep link falls back to the tab's home.
 */
export async function createCortexThread(opts: {
  snowflakeToken: string
  snowflakeAccount: string
  tokenType?: SnowflakeTokenType
  originApp: string
}): Promise<number | undefined> {
  const { snowflakeToken, snowflakeAccount, tokenType = 'OAUTH', originApp } = opts
  try {
    const res = await fetch(`${snowflakeBase(snowflakeAccount)}/api/v2/cortex/threads`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: snowflakeHeaders({ token: snowflakeToken, tokenType }),
      body: JSON.stringify({ origin_application: originApp }),
    })
    if (!res.ok) {
      console.warn(`[bot] create thread failed: ${res.status}`)
      return undefined
    }
    const data = (await res.json()) as { thread_id?: unknown; id?: unknown }
    const id = Number(data.thread_id ?? data.id)
    return Number.isSafeInteger(id) && id > 0 ? id : undefined
  } catch (e: unknown) {
    console.warn(`[bot] create thread failed: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
}
