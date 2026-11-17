// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Maps a run failure (an ApiError with an HTTP status, an SSE `error` event's {code, message},
// or a plain network failure) to a sentence a user can act on. `errorCode`/`requestId` on the
// turn stay untranslated - the support flow's "Copy request ID" button needs the real value -
// only the sentence shown in the bubble goes through this.
export function translateError(err: { status?: number; code?: string; name?: string; message?: string }): string {
  if (err.status === 429) {
    return "You're sending messages too quickly. Please wait a moment and try again."
  }
  if (err.code === 'stream_stall' || err.name === 'StreamStallError') {
    return 'The connection stalled. Please try again.'
  }
  if (err.status !== undefined && err.status >= 500) {
    return 'Cortex is temporarily unavailable. Please try again in a moment.'
  }
  if (err.code === 'agent_forbidden') {
    return 'You do not have access to that resource.'
  }
  if (err.code === 'network_policy_blocked') {
    return "Your Snowflake account's network policy is blocking this connection. Contact your Snowflake administrator."
  }
  if (err.status === 401 || err.status === 403) {
    return 'Your session has expired. Please refresh the page and sign in again.'
  }
  if (err.status !== undefined && err.status >= 400) {
    return err.message || 'That request could not be completed.'
  }
  const lower = err.message?.toLowerCase() ?? ''
  if (lower.includes('fetch') || lower.includes('network')) {
    return "Couldn't reach Snowflake. Check your connection and try again."
  }
  // Structured Cortex/API errors carry a machine-readable `code`. A bare Error.message
  // (SyntaxError from a parser, an untyped throw) is not shown — it stays in
  // classifyError's `raw` channel for support.
  if (err.code && err.message) return err.message
  return 'Something went wrong. Please try again.'
}
