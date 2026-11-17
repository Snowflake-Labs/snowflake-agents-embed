// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
export class BodyTooLargeError extends Error {}

/** Reads the request body as text, aborting as soon as it exceeds maxBytes (Content-Length can lie or be absent). */
export async function readTextCapped(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('Content-Length') ?? 0)
  if (declared > maxBytes) throw new BodyTooLargeError()
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new BodyTooLargeError()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(out)
}

/** Parses a capped JSON body. Returns null for invalid JSON; throws BodyTooLargeError when too large. */
export async function readJsonCapped(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readTextCapped(request, maxBytes)
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const MAX_TOKEN_BODY_BYTES = 16_384
