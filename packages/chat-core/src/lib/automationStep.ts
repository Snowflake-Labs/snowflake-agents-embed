// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { AutomationStepInfo } from '../types.js'

/**
 * Best-effort extraction of `schedule_snowflake_task`'s tool_use.input into a first-class
 * step display instead of the generic "Running schedule_snowflake_task..." label. The wire
 * shape is unconfirmed (no fixture captured it), so this tries a few plausible field names per
 * value rather than assuming one, and returns undefined (not a partially-filled object) for any
 * other tool type so the caller can fall back to the plain label unchanged.
 */
export function parseAutomationInput(toolType: string, input: unknown): AutomationStepInfo | undefined {
  if (toolType !== 'schedule_snowflake_task') return undefined
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>

  const action = firstString(i.action, i.operation, i.type)
  const schedule = firstString(i.schedule, i.cron, i.schedule_expression, i.cron_expression)
  const target = firstString(i.target, i.task_name, i.name, i.taskName)

  if (!action && !schedule && !target) return undefined
  return { action, schedule, target }
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}
