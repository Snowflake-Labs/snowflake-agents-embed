// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
export interface ShareSnapshot {
  title?: string
  question?: string
  answer?: string
  threadId?: number
}

const MAX_TITLE = 120
const MAX_QUESTION = 200
const MAX_ANSWER = 1200

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

// base64url (no padding, UTF-8 safe) so it round-trips cleanly in URLs.
function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - s.length % 4) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

// Keys kept short to stay under ~1.8 KB URL budget.
export function encodeSnapshot(snapshot: ShareSnapshot): string {
  const payload: Record<string, string | number> = {}
  if (snapshot.title) payload.t = truncate(snapshot.title, MAX_TITLE)!
  if (snapshot.question) payload.q = truncate(snapshot.question, MAX_QUESTION)!
  if (snapshot.answer) payload.a = truncate(snapshot.answer, MAX_ANSWER)!
  if (snapshot.threadId !== undefined) payload.id = snapshot.threadId
  return toBase64Url(JSON.stringify(payload))
}

export function decodeSnapshot(encoded: string): ShareSnapshot {
  try {
    const raw = JSON.parse(fromBase64Url(encoded))
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

// Not used by the ShareButton yet — the tab links back into Teams via deep-link.ts. Kept because encode/decode are
// the tested half and a future public share page would need exactly this;
// VITE_SHARE_BASE must be set for the URL to mean anything.
export function buildShareUrl(snapshot: ShareSnapshot): string {
  const base = import.meta.env.VITE_SHARE_BASE ?? ''
  return `${base}/share?s=${encodeSnapshot(snapshot)}`
}
