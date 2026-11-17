// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { joinThinking } from './thinkingText'

describe('joinThinking', () => {
  it('returns an empty string for an empty map', () => {
    expect(joinThinking(new Map())).toBe('')
  })

  it('returns an empty string when every entry is empty', () => {
    expect(joinThinking(new Map([[0, ''], [3, ''], [9, '']]))).toBe('')
  })

  it('skips empty entries and joins the rest in index order', () => {
    const byIndex = new Map([
      [9, ''],
      [0, 'This question looks like a verified query.'],
      [3, ''],
    ])
    expect(joinThinking(byIndex)).toBe('This question looks like a verified query.')
  })

  it('joins multiple non-empty entries with a blank line', () => {
    const byIndex = new Map([
      [0, 'First burst.'],
      [5, 'Second burst.'],
    ])
    expect(joinThinking(byIndex)).toBe('First burst.\n\nSecond burst.')
  })
})
