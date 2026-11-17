// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { toolLabel } from './toolLabel'

describe('toolLabel', () => {
  it('returns the mapped label for a known tool type', () => {
    expect(toolLabel('system_execute_sql')).toBe('Executing SQL...')
  })

  it('de-snake-cases an unmapped tool type instead of leaking the raw identifier', () => {
    expect(toolLabel('custom_bash_tool')).toBe('Running custom bash tool...')
  })

  it('leaves an unmapped non-snake-case type as-is', () => {
    expect(toolLabel('bash')).toBe('Running bash...')
  })
})
