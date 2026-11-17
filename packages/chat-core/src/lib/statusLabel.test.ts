// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { statusLabel } from './statusLabel'

describe('statusLabel', () => {
  // Observed in a live agent:run against SALES_AGENT.
  it('maps every status code seen on a live stream', () => {
    expect(statusLabel('planning')).toBe('Planning the next steps')
    expect(statusLabel('extracting_tool_calls')).toBe('Deciding which tools to use')
    expect(statusLabel('executing_tools')).toBe('Running tools')
    expect(statusLabel('reasoning_agent_stop')).toBe('Reviewing the results')
    expect(statusLabel('reevaluating_plan')).toBe('Reconsidering the approach')
    expect(statusLabel('proceeding_to_answer')).toBe('Writing the answer')
  })

  // Observed in the native-app HAR, from an agent with skills and a sandbox. Note the singular
  // `executing_tool` - the live stream sends the plural, so both have to map.
  it('maps the extra codes seen in the native-app HAR capture', () => {
    expect(statusLabel('executing_tool')).toBe('Running a tool')
    expect(statusLabel('reading_skills')).toBe('Loading skills')
    expect(statusLabel('sandbox_provisioning')).toBe('Preparing a sandbox')
    expect(statusLabel('sandbox_ready')).toBe('Sandbox ready')
  })

  it('passes through Cortex\'s own prose statusMessage untouched', () => {
    // sseParser prefers `message` over `status`, so these arrive already human-readable.
    expect(statusLabel('Running Sales_Analyst')).toBe('Running Sales_Analyst')
    expect(statusLabel('Validating SQL')).toBe('Validating SQL')
    expect(statusLabel('Executing SQL')).toBe('Executing SQL')
  })

  it('de-snake-cases an unrecognised code rather than showing a raw identifier', () => {
    expect(statusLabel('some_future_status')).toBe('Some future status')
  })

  it('is case-insensitive on known codes', () => {
    expect(statusLabel('PLANNING')).toBe('Planning the next steps')
  })

  it('returns undefined for nothing to show', () => {
    expect(statusLabel('')).toBeUndefined()
    expect(statusLabel('   ')).toBeUndefined()
    expect(statusLabel(undefined as unknown as string)).toBeUndefined()
  })
})
