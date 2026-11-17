// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { parseAutomationInput } from './automationStep'

describe('parseAutomationInput', () => {
  it('returns undefined for any tool other than schedule_snowflake_task', () => {
    expect(parseAutomationInput('cortex_analyst_text_to_sql', { action: 'setup' })).toBeUndefined()
  })

  it('extracts action/schedule/target from the expected field names', () => {
    expect(parseAutomationInput('schedule_snowflake_task', {
      action: 'setup', schedule: '0 9 * * *', target: 'nightly_refresh',
    })).toEqual({ action: 'setup', schedule: '0 9 * * *', target: 'nightly_refresh' })
  })

  it('tolerates alternate field names per value', () => {
    expect(parseAutomationInput('schedule_snowflake_task', {
      operation: 'pause', cron_expression: '*/5 * * * *', task_name: 'sync_task',
    })).toEqual({ action: 'pause', schedule: '*/5 * * * *', target: 'sync_task' })
  })

  it('returns undefined when the input has none of the recognized fields', () => {
    expect(parseAutomationInput('schedule_snowflake_task', { unrelated: 'x' })).toBeUndefined()
    expect(parseAutomationInput('schedule_snowflake_task', undefined)).toBeUndefined()
    expect(parseAutomationInput('schedule_snowflake_task', null)).toBeUndefined()
  })

  it('omits fields absent from the input rather than filling them with empty strings', () => {
    expect(parseAutomationInput('schedule_snowflake_task', { action: 'show' })).toEqual({
      action: 'show', schedule: undefined, target: undefined,
    })
  })
})
