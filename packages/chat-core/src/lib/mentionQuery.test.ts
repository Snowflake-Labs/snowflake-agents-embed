// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { extractMentionQuery, removeMention } from './mentionQuery'

describe('extractMentionQuery', () => {
  it('returns the partial query right after an @ at the cursor', () => {
    expect(extractMentionQuery('hello @sup', 10)).toBe('sup')
  })

  it('returns an empty string for a bare @ with nothing typed yet', () => {
    expect(extractMentionQuery('hello @', 7)).toBe('')
  })

  it('returns null when the cursor is not inside a mention token', () => {
    expect(extractMentionQuery('hello world', 11)).toBeNull()
  })

  it('returns null once whitespace closes the mention', () => {
    expect(extractMentionQuery('hello @sup there', 16)).toBeNull()
  })

  it('ignores mentions before the cursor position', () => {
    expect(extractMentionQuery('@sup hello', 10)).toBeNull()
  })
})

describe('removeMention', () => {
  it('strips the @ and partial query, keeping the rest of the text', () => {
    expect(removeMention('hello @sup', 10)).toBe('hello ')
  })

  it('keeps text after the cursor intact', () => {
    expect(removeMention('hello @sup world', 10)).toBe('hello  world')
  })
})
