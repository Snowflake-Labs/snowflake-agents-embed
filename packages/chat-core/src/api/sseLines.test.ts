// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { appendSseChunk, type SseLineBuffer } from './sseParser'

function empty(): SseLineBuffer {
  return { buffer: '', searchedUpTo: 0 }
}

describe('appendSseChunk', () => {
  it('emits complete lines and keeps the incomplete remainder', () => {
    const state = empty()
    expect(appendSseChunk(state, 'event: a\ndata: 1\ndata:')).toEqual(['event: a', 'data: 1'])
    expect(state.buffer).toBe('data:')
  })

  it('does not re-scan the already-searched prefix of a long incomplete line', () => {
    const state = empty()
    const first = 'data: ' + 'x'.repeat(1000)
    expect(appendSseChunk(state, first)).toEqual([])
    expect(state.searchedUpTo).toBe(first.length)
    expect(appendSseChunk(state, 'yyy\nevent: next\n')).toEqual([first + 'yyy', 'event: next'])
    expect(state.buffer).toBe('')
  })

  it('handles a line split across many chunks without dropping or doubling', () => {
    const state = empty()
    const pieces = ['data: {"t', 'ext":"hel', 'lo"}\n']
    const lines: string[] = []
    for (const p of pieces) lines.push(...appendSseChunk(state, p))
    expect(lines).toEqual(['data: {"text":"hello"}'])
    expect(state.buffer).toBe('')
  })
})
