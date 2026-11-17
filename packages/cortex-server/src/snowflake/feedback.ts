// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { parseAgentRef } from './agent-ref.js'
import { snowflakeBase, snowflakeHeaders, type SnowflakeCredential } from './credential.js'
import { fetchWithTimeout } from './fetch-timeout.js'

/**
 * Submit end-user feedback via Cortex's native Feedback REST API
 * (https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-feedback-rest-api).
 * This is a documented public endpoint, not a table we own — there is no
 * `message_id`/per-turn granularity, only `thread_id` (and `orig_request_id`,
 * which we don't have on the happy path — see ConversationTurn.tsx). Returns
 * `ok: false` on any failure so the caller can no-op the UI rather than throw.
 */
export async function submitFeedback(
  account: string,
  cred: SnowflakeCredential,
  fqn: string,
  feedback: {
    positive: boolean
    feedbackMessage?: string
    categories?: string[]
    threadId?: number
  },
): Promise<{ ok: boolean; status?: number }> {
  const { database, schema, name } = parseAgentRef(fqn)
  try {
    const res = await fetchWithTimeout(
      `${snowflakeBase(account)}/api/v2/databases/${database}/schemas/${schema}/agents/${name}:feedback`,
      {
        method: 'POST',
        headers: snowflakeHeaders(cred),
        body: JSON.stringify({
          positive: feedback.positive,
          ...(feedback.feedbackMessage ? { feedback_message: feedback.feedbackMessage } : {}),
          ...(feedback.categories?.length ? { categories: feedback.categories } : {}),
          ...(feedback.threadId ? { thread_id: feedback.threadId } : {}),
        }),
      },
    )
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false }
  }
}
