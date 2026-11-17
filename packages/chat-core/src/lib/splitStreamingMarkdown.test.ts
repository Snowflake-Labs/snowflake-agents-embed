// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { splitStreamingMarkdown } from './splitStreamingMarkdown'

describe('splitStreamingMarkdown', () => {
  it('returns the whole text as tail when there is no complete block', () => {
    expect(splitStreamingMarkdown('Hello world')).toEqual({ prefix: '', tail: 'Hello world' })
    expect(splitStreamingMarkdown('')).toEqual({ prefix: '', tail: '' })
  })

  it('splits at the last blank line', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nLive tail'
    expect(splitStreamingMarkdown(text)).toEqual({
      prefix: 'First paragraph.\n\nSecond paragraph.\n\n',
      tail: 'Live tail',
    })
  })

  it('does not treat a blank line inside a fenced code block as a boundary', () => {
    const text = 'Intro\n\n```sql\nSELECT 1\n\nSELECT 2\n'
    expect(splitStreamingMarkdown(text)).toEqual({
      prefix: 'Intro\n\n',
      tail: '```sql\nSELECT 1\n\nSELECT 2\n',
    })
  })

  it('resumes splitting after a closed fence', () => {
    const text = 'Intro\n\n```sql\nSELECT 1\n\nSELECT 2\n```\n\nAfter the fence'
    expect(splitStreamingMarkdown(text)).toEqual({
      prefix: 'Intro\n\n```sql\nSELECT 1\n\nSELECT 2\n```\n\n',
      tail: 'After the fence',
    })
  })

  it('keeps a trailing incomplete fence entirely in the tail', () => {
    const text = 'Done block.\n\n```\npartial'
    expect(splitStreamingMarkdown(text)).toEqual({
      prefix: 'Done block.\n\n',
      tail: '```\npartial',
    })
  })
})
