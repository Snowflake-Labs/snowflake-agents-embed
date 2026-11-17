// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
export interface ShareSnapshot {
  title?: string
  question?: string
  answer?: string
  threadId?: number
}

import { createHmac, timingSafeEqual } from 'node:crypto'

/** HMAC-SHA256 over the exact `s` parameter text, base64url. Sign server-side only. */
export function signSnapshotParam(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded).digest('base64url')
}

function validSignature(encoded: string, sig: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !sig) return false
  const expected = Buffer.from(signSnapshotParam(encoded, secret))
  const given = Buffer.from(sig)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

// Base64url decode — mirrors the client's share-snapshot encoder (UTF-8 safe).
// Keys: t=title, q=question, a=answer, id=threadId
//
// The payload is attacker-writable (anyone can craft a link to the tab host), so it is only
// decoded when it carries a valid HMAC from SHARE_SIGNING_SECRET. Unsigned, badly signed,
// or no-secret-configured all yield an empty snapshot (fail closed).
export function decodeSnapshot(
  encoded: string,
  sig?: string | null,
  secret?: string,
): ShareSnapshot {
  if (!validSignature(encoded, sig, secret)) return {}
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') +
      '=='.slice(0, (4 - encoded.length % 4) % 4)
    const binary = Buffer.from(padded, 'base64').toString('utf-8')
    const raw = JSON.parse(binary)
    return {
      title: typeof raw.t === 'string' ? raw.t : undefined,
      question: typeof raw.q === 'string' ? raw.q : undefined,
      answer: typeof raw.a === 'string' ? raw.a : undefined,
      threadId: typeof raw.id === 'number' ? raw.id : undefined,
    }
  } catch {
    return {}
  }
}
