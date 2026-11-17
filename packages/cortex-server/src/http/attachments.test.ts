// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { applyAttachments, MAX_ATTACHMENT_BYTES } from './attachments.js'

describe('applyAttachments', () => {
  it('passes through when attachments is absent', () => {
    const body = { messages: [] }
    expect(applyAttachments(body, false)).toEqual({ ok: true, body })
  })

  it('rejects attachments when the fileUpload flag is off', () => {
    const result = applyAttachments(
      { attachments: [{ name: 'notes.txt', data: 'hi' }] },
      false,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('rejects a non-text extension', () => {
    const result = applyAttachments(
      { attachments: [{ name: 'notes.exe', data: 'hi' }] },
      true,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects an oversized attachment', () => {
    const result = applyAttachments(
      { attachments: [{ name: 'notes.txt', data: 'x'.repeat(MAX_ATTACHMENT_BYTES + 1) }] },
      true,
    )
    expect(result.ok).toBe(false)
  })

  it('fences onto the last user text part and strips the attachments field', () => {
    const result = applyAttachments(
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
        attachments: [{ name: 'notes.txt', data: 'secret' }],
      },
      true,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body.attachments).toBeUndefined()
    const text = ((result.body.messages as { content: { text: string }[] }[])[0].content[0].text)
    expect(text).toContain('hello')
    expect(text).toContain('"notes.txt"')
    expect(text).toContain('secret')
    expect(text).toMatch(/--- attach-[0-9a-f-]{36} file:/)
  })
})
