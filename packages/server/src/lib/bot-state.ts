// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import {
  fetchWithTimeout,
  isUpstreamTimeoutError,
  SQL_API_FETCH_TIMEOUT_MS,
  SQL_API_STATEMENT_TIMEOUT_SEC,
} from '@snowflake-agents-embed/cortex-server/snowflake/fetch-timeout'
import { snowflakeBase, snowflakeHeaders } from '@snowflake-agents-embed/cortex-server/snowflake/credential'
import type { SnowflakeTokenType } from '@snowflake-agents-embed/cortex-server/snowflake/credential'

export interface BotUserState {
  agentFqn?: string
  threadId?: number
  parentMessageId?: number
  /** JSON-serialized Bot Framework ConversationReference, captured from the last message this
   * user sent - the prerequisite for ever sending a proactive message to them (see
   * bot/proactive.ts). Opaque to this module; callers serialize/deserialize it themselves. */
  conversationReference?: string
}

interface SqlApiResult {
  data?: string[][]
}

async function execStatement(
  account: string,
  token: string,
  tokenType: SnowflakeTokenType,
  statement: string,
  bindings?: Record<string, { type: string; value: string }>,
): Promise<SqlApiResult> {
  const res = await fetchWithTimeout(`${snowflakeBase(account)}/api/v2/statements`, {
    method: 'POST',
    headers: snowflakeHeaders({ token, tokenType }),
    body: JSON.stringify({
      statement,
      timeout: SQL_API_STATEMENT_TIMEOUT_SEC,
      ...(bindings ? { bindings } : {}),
    }),
  }, SQL_API_FETCH_TIMEOUT_MS)
  if (!res.ok) throw new Error(`Snowflake SQL API error: ${res.status}`)
  return res.json()
}

/**
 * Per-user bot state (active agent + Cortex thread/parent-message chain), persisted to a
 * Snowflake table instead of the in-memory Maps bot/handler.ts used to hold - those reset on
 * every container restart or SPCS scale-out event, which is routine, not exceptional. `table`
 * is server-controlled deploy config (BOT_STATE_TABLE), not user input, so it's interpolated
 * directly; `userId` and every value column go through SQL API bindings instead. All three
 * functions below are best-effort: a failure here should degrade the bot's memory for one
 * turn, not break the reply.
 */
export type BotUserStateResult =
  | { ok: true; state: BotUserState | null }
  | { ok: false; timeout?: true }

export async function getBotUserState(
  account: string, token: string, tokenType: SnowflakeTokenType, table: string, userId: string,
): Promise<BotUserStateResult> {
  try {
    const result = await execStatement(
      account, token, tokenType,
      `SELECT agent_fqn, thread_id, parent_message_id, conversation_reference FROM ${table} WHERE user_id = :1`,
      { '1': { type: 'TEXT', value: userId } },
    )
    const row = result.data?.[0]
    if (!row) return { ok: true, state: null }
    return {
      ok: true,
      state: {
        agentFqn: row[0] || undefined,
        threadId: row[1] ? Number(row[1]) : undefined,
        parentMessageId: row[2] ? Number(row[2]) : undefined,
        conversationReference: row[3] || undefined,
      },
    }
  } catch (err) {
    if (isUpstreamTimeoutError(err)) return { ok: false, timeout: true }
    return { ok: false }
  }
}

export async function setBotUserState(
  account: string, token: string, tokenType: SnowflakeTokenType, table: string, userId: string, state: BotUserState,
): Promise<boolean> {
  try {
    await execStatement(
      account, token, tokenType,
      `MERGE INTO ${table} AS t USING (SELECT :1 AS user_id) AS s ON t.user_id = s.user_id ` +
      'WHEN MATCHED THEN UPDATE SET agent_fqn = :2, thread_id = :3, parent_message_id = :4, conversation_reference = :5, updated_at = CURRENT_TIMESTAMP() ' +
      'WHEN NOT MATCHED THEN INSERT (user_id, agent_fqn, thread_id, parent_message_id, conversation_reference, updated_at) VALUES (:1, :2, :3, :4, :5, CURRENT_TIMESTAMP())',
      {
        '1': { type: 'TEXT', value: userId },
        '2': { type: 'TEXT', value: state.agentFqn ?? '' },
        '3': { type: 'TEXT', value: state.threadId != null ? String(state.threadId) : '' },
        '4': { type: 'TEXT', value: state.parentMessageId != null ? String(state.parentMessageId) : '' },
        '5': { type: 'TEXT', value: state.conversationReference ?? '' },
      },
    )
    return true
  } catch {
    // best-effort - the caller's in-memory cache keeps the bot usable this turn regardless
    return false
  }
}

export async function clearBotUserState(
  account: string, token: string, tokenType: SnowflakeTokenType, table: string, userId: string,
): Promise<void> {
  try {
    await execStatement(
      account, token, tokenType,
      `DELETE FROM ${table} WHERE user_id = :1`,
      { '1': { type: 'TEXT', value: userId } },
    )
  } catch {
    // best-effort
  }
}
