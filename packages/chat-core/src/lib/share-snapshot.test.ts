// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { encodeSnapshot, decodeSnapshot } from './share-snapshot'

describe('share-snapshot encode/decode', () => {
  it('round-trips a full snapshot', () => {
    const snapshot = {
      title: 'Sales Q1 Review',
      question: 'What were sales last quarter?',
      answer: 'Sales were $2.5M across all regions.',
      threadId: 42,
    }
    const encoded = encodeSnapshot(snapshot)
    const decoded = decodeSnapshot(encoded)
    expect(decoded.title).toBe(snapshot.title)
    expect(decoded.question).toBe(snapshot.question)
    expect(decoded.answer).toBe(snapshot.answer)
    expect(decoded.threadId).toBe(42)
  })

  it('round-trips a minimal snapshot with no optional fields', () => {
    const snapshot = { answer: 'The answer is 42.' }
    const decoded = decodeSnapshot(encodeSnapshot(snapshot))
    expect(decoded.answer).toBe('The answer is 42.')
    expect(decoded.title).toBeUndefined()
    expect(decoded.question).toBeUndefined()
    expect(decoded.threadId).toBeUndefined()
  })

  it('truncates title to 120 chars', () => {
    const long = 'A'.repeat(200)
    const decoded = decodeSnapshot(encodeSnapshot({ title: long, answer: 'x' }))
    expect(decoded.title!.length).toBeLessThanOrEqual(120)
    expect(decoded.title).toContain('…')
  })

  it('truncates question to 200 chars', () => {
    const long = 'Q'.repeat(300)
    const decoded = decodeSnapshot(encodeSnapshot({ question: long, answer: 'x' }))
    expect(decoded.question!.length).toBeLessThanOrEqual(200)
  })

  it('truncates answer to 1200 chars', () => {
    const long = 'A'.repeat(2000)
    const decoded = decodeSnapshot(encodeSnapshot({ answer: long }))
    expect(decoded.answer!.length).toBeLessThanOrEqual(1200)
  })

  it('encoded string contains only URL-safe characters', () => {
    const encoded = encodeSnapshot({
      title: 'Q1 review',
      question: 'What happened?',
      answer: 'Here is the result: 100% complete!',
      threadId: 1,
    })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/)
  })

  it('decodeSnapshot returns empty object for invalid input', () => {
    expect(decodeSnapshot('!!!invalid')).toEqual({})
    expect(decodeSnapshot('')).toEqual({})
  })
})
