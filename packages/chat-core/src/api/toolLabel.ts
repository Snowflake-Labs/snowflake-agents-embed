// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { deSnakeCase } from '../lib/statusLabel.js'

// Human-readable label for a tool-use step. Shared by the live stream
// (useAgentStream) and history reconstruction (reconstructTurns) so a reopened
// thread's thinking steps read identically to a freshly streamed one.
export function toolLabel(toolType: string): string {
  const labels: Record<string, string> = {
    cortex_analyst_text_to_sql: 'Running SQL query...',
    cortex_search: 'Searching Cortex Search...',
    sql_execution: 'Executing SQL...',
    system_execute_sql: 'Executing SQL...',
    data_to_chart: 'Generating visualization...',
    schedule_snowflake_task: 'Managing a scheduled task...',
  }
  if (labels[toolType]) return labels[toolType]
  // An unmapped type - some future tool this map hasn't caught up with yet - used to leak
  // the raw snake_case identifier ("Running custom_bash_tool...") straight into the UI.
  // deSnakeCase capitalizes for a standalone sentence; lowercase it back since it's embedded
  // mid-sentence here ("Running custom bash tool...", not "Running Custom bash tool...").
  const words = deSnakeCase(toolType)
  return `Running ${words.charAt(0).toLowerCase()}${words.slice(1)}...`
}

/**
 * Tense-aware step text, ported from the native app's `toolTypeToStepLabel` +
 * `STEP_LABEL_DESCRIPTORS`. A finished step reads as history ("Retrieved data"), a running one as
 * work in flight ("Querying data").
 *
 * This is deliberately preferred over the server's own `statusMessage` for tool types we know
 * (see ThinkingSteps), because those messages are written for a running step and never revised:
 * the last of the six `response.tool_result.status` events in a SQL round still says
 * "Executing SQL" after the query has succeeded, and one of the six is a bare
 * "Query ID: 01c6…" that has no business being the visible step text.
 *
 * `undefined` for an unmapped tool type, so callers can fall back to `statusMessage`.
 */
const STEP_LABELS: Record<string, { running: string; done: string }> = {
  system_execute_sql: { running: 'Querying data', done: 'Retrieved data' },
  sql_execution: { running: 'Querying data', done: 'Retrieved data' },
  sql_exec: { running: 'Querying data', done: 'Retrieved data' },
  cortex_analyst_text_to_sql: { running: 'Searching sources', done: 'Searched sources' },
  cortex_analyst_data_to_answer: { running: 'Searching sources', done: 'Searched sources' },
  cortex_search: { running: 'Searching sources', done: 'Searched sources' },
  system_agentic_semantic_context: { running: 'Reviewing context', done: 'Reviewed context' },
  data_to_chart: { running: 'Creating chart', done: 'Created chart' },
  server_skill: { running: 'Loading skill', done: 'Loaded skill' },
  schedule_snowflake_task: { running: 'Scheduling a task', done: 'Scheduled a task' },
}

export function stepLabel(toolType: string, status: 'running' | 'done' | 'error'): string | undefined {
  const pair = STEP_LABELS[toolType]
  if (!pair) return undefined
  // An errored step is finished, so it reads in past tense too - the row's own icon and colour
  // carry the failure.
  return status === 'running' ? pair.running : pair.done
}
