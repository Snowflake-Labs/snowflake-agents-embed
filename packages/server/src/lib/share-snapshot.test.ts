// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { decodeSnapshot, signSnapshotParam } from './share-snapshot.js'

const SECRET = 'test-signing-secret'
const decodeSigned = (enc: string) => decodeSnapshot(enc, signSnapshotParam(enc, SECRET), SECRET)

// Helper: mirror the client's encodeSnapshot using Node's Buffer.
// Keys: t=title, q=question, a=answer, id=threadId
function encodeForTest(snapshot: {
  title?: string; question?: string; answer?: string; threadId?: number
}): string {
  const payload: Record<string, unknown> = {}
  if (snapshot.title) payload.t = snapshot.title
  if (snapshot.question) payload.q = snapshot.question
  if (snapshot.answer) payload.a = snapshot.answer
  if (snapshot.threadId !== undefined) payload.id = snapshot.threadId
  return Buffer.from(JSON.stringify(payload), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

describe('decodeSnapshot', () => {
  it('decodes a full snapshot round-trip', () => {
    const encoded = encodeForTest({
      title: 'Q1 Review',
      question: 'What happened?',
      answer: 'Revenue was $2.5M.',
      threadId: 99,
    })
    const decoded = decodeSigned(encoded)
    expect(decoded.title).toBe('Q1 Review')
    expect(decoded.question).toBe('What happened?')
    expect(decoded.answer).toBe('Revenue was $2.5M.')
    expect(decoded.threadId).toBe(99)
  })

  it('decodes a minimal snapshot without optional fields', () => {
    const encoded = encodeForTest({ answer: 'Hello' })
    const decoded = decodeSigned(encoded)
    expect(decoded.answer).toBe('Hello')
    expect(decoded.title).toBeUndefined()
    expect(decoded.question).toBeUndefined()
    expect(decoded.threadId).toBeUndefined()
  })

  it('handles non-ASCII characters (UTF-8)', () => {
    const encoded = encodeForTest({ answer: 'Résumé: 100%', title: 'Q1 – Review' })
    const decoded = decodeSigned(encoded)
    expect(decoded.answer).toBe('Résumé: 100%')
    expect(decoded.title).toBe('Q1 – Review')
  })

  it('returns empty object for malformed input', () => {
    expect(decodeSigned('!!!invalid')).toEqual({})
    expect(decodeSigned('')).toEqual({})
  })

  it('rejects a snapshot with no signature', () => {
    const enc = encodeForTest({ answer: 'phish' })
    expect(decodeSnapshot(enc)).toEqual({})
    expect(decodeSnapshot(enc, null, SECRET)).toEqual({})
  })

  it('rejects a snapshot whose signature does not match', () => {
    const enc = encodeForTest({ answer: 'phish' })
    expect(decodeSnapshot(enc, signSnapshotParam(encodeForTest({ answer: 'other' }), SECRET), SECRET)).toEqual({})
    expect(decodeSnapshot(enc, signSnapshotParam(enc, 'wrong-secret'), SECRET)).toEqual({})
    expect(decodeSnapshot(enc, 'short', SECRET)).toEqual({})
  })

  it('fails closed when no signing secret is configured', () => {
    const enc = encodeForTest({ answer: 'phish' })
    expect(decodeSnapshot(enc, signSnapshotParam(enc, SECRET), undefined)).toEqual({})
  })
})
