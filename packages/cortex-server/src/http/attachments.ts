// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'

export const MAX_ATTACHMENT_BYTES = 100_000
export const MAX_ATTACHMENTS = 8
const TEXT_EXTENSIONS = /\.(csv|txt|json|md)$/i

export interface TextAttachment {
  name: string
  data: string
}

export type AttachmentResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 403; error: string }

function fenceFiles(attachments: TextAttachment[]): string {
  const boundary = `attach-${randomUUID()}`
  return attachments
    .map((a) => `--- ${boundary} file: ${JSON.stringify(a.name)} ---\n${a.data}\n--- ${boundary} end ---`)
    .join('\n\n')
}

function lastUserText(messages: unknown[]): { index: number; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || typeof msg !== 'object') continue
    const rec = msg as Record<string, unknown>
    if (rec.role !== 'user') continue
    const content = rec.content
    if (!Array.isArray(content)) continue
    const textPart = content.find((p) => p && typeof p === 'object' && (p as { type?: string }).type === 'text')
    if (!textPart || typeof textPart !== 'object') continue
    const text = (textPart as { text?: unknown }).text
    if (typeof text !== 'string') continue
    return { index: i, text }
  }
  return null
}

export function applyAttachments(
  body: Record<string, unknown>,
  fileUploadEnabled: boolean,
): AttachmentResult {
  const raw = body.attachments
  if (raw == null) return { ok: true, body }

  if (!fileUploadEnabled) {
    return { ok: false, status: 403, error: 'File upload is disabled' }
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, status: 400, error: 'attachments must be a non-empty array' }
  }
  if (raw.length > MAX_ATTACHMENTS) {
    return { ok: false, status: 400, error: `At most ${MAX_ATTACHMENTS} attachments` }
  }

  const attachments: TextAttachment[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { ok: false, status: 400, error: 'Each attachment must be an object' }
    }
    const name = (item as { name?: unknown }).name
    const data = (item as { data?: unknown }).data
    if (typeof name !== 'string' || typeof data !== 'string') {
      return { ok: false, status: 400, error: 'Each attachment needs name and data strings' }
    }
    if (!TEXT_EXTENSIONS.test(name)) {
      return { ok: false, status: 400, error: `Unsupported attachment type: ${name}` }
    }
    if (Buffer.byteLength(data, 'utf8') > MAX_ATTACHMENT_BYTES) {
      return { ok: false, status: 400, error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit` }
    }
    attachments.push({ name, data })
  }

  const next = { ...body }
  const messages = Array.isArray(next.messages) ? [...(next.messages as unknown[])] : []
  const fenced = fenceFiles(attachments)
  const target = lastUserText(messages)
  if (target) {
    const msg = { ...(messages[target.index] as Record<string, unknown>) }
    const content = [...(msg.content as unknown[])]
    const partIdx = content.findIndex((p) => p && typeof p === 'object' && (p as { type?: string }).type === 'text')
    const part = { ...(content[partIdx] as Record<string, unknown>), text: `${target.text}\n\n${fenced}` }
    content[partIdx] = part
    msg.content = content
    messages[target.index] = msg
    next.messages = messages
  } else {
    next.messages = [
      ...messages,
      { role: 'user', content: [{ type: 'text', text: fenced }] },
    ]
  }
  delete next.attachments
  return { ok: true, body: next }
}
