// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Human-readable label for a `response.status` event, mirroring api/toolLabel.ts.
 *
 * These events drive the live progress narration while a turn is working, and they're the reason
 * the native app never shows a bare spinner: the ~500ms before the first token, and the
 * multi-second gaps around tool rounds, are filled with what the agent is actually doing.
 *
 * The values below come from two sources: a live agent:run against a Cortex agent, and a
 * native-app (ai.snowflake.com) HAR capture of an agent with skills and a sandbox. They overlap
 * but neither is a superset - the live stream emits `executing_tools` (plural) and
 * `extracting_tool_calls`, the HAR emits `executing_tool` (singular), `reading_skills` and the
 * sandbox pair - so both spellings are mapped rather than guessing which is canonical. The set is
 * undocumented and can grow, hence the de-snake-cased fallback below.
 *
 * sseParser already prefers the event's own `message` over its `status`, so this map only sees a
 * bare code when Cortex sent no narration for it.
 *
 * Several of these codes are now filtered out before they get here - see DENIED_STATUS_CODES in
 * useAgentStream. Their entries are kept because the filter matches on the event's `code`, which
 * is absent on any stream that sends prose without a status field.
 */
const LABELS: Record<string, string> = {
  planning: 'Planning the next steps',
  extracting_tool_calls: 'Deciding which tools to use',
  executing_tools: 'Running tools',
  executing_tool: 'Running a tool',
  reasoning_agent_stop: 'Reviewing the results',
  reevaluating_plan: 'Reconsidering the approach',
  proceeding_to_answer: 'Writing the answer',
  reading_skills: 'Loading skills',
  sandbox_provisioning: 'Preparing a sandbox',
  sandbox_ready: 'Sandbox ready',
}

// Only de-snake-case when the whole string *is* a snake_case identifier - all lowercase, no
// spaces. Testing merely for an underscore would mangle Cortex's own prose statusMessage,
// since tool names legitimately contain them ("Running Sales_Analyst"). Shared with
// api/toolLabel.ts, whose unmapped-type fallback had the exact same "raw identifier leaks
// into the UI" problem this originally shipped to fix here.
export function deSnakeCase(trimmed: string): string {
  if (!/^[a-z0-9]+(_[a-z0-9]+)+$/.test(trimmed)) return trimmed
  const words = trimmed.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function statusLabel(raw: string): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const mapped = LABELS[trimmed.toLowerCase()]
  if (mapped) return mapped
  return deSnakeCase(trimmed)
}
