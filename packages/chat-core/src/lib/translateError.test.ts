// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { translateError } from './translateError'

describe('translateError', () => {
  it('translates a stalled stream into a retry sentence', () => {
    expect(translateError({ code: 'stream_stall', name: 'StreamStallError', message: 'stalled' }))
      .toBe('The connection stalled. Please try again.')
  })

  it('translates 429 into a rate-limit sentence', () => {
    expect(translateError({ status: 429, message: 'Too Many Requests' }))
      .toBe("You're sending messages too quickly. Please wait a moment and try again.")
  })

  it('translates 5xx into a temporarily-unavailable sentence', () => {
    expect(translateError({ status: 503, message: 'Service Unavailable' }))
      .toBe('Cortex is temporarily unavailable. Please try again in a moment.')
  })

  it('translates 401/403 into a session-expired sentence', () => {
    expect(translateError({ status: 401, message: 'Unauthorized' }))
      .toBe('Your session has expired. Please refresh the page and sign in again.')
    expect(translateError({ status: 403, message: 'Forbidden' }))
      .toBe('Your session has expired. Please refresh the page and sign in again.')
  })

  it('does not call an authorization failure a session expiry', () => {
    expect(translateError({
      status: 401,
      code: 'agent_forbidden',
      message: 'You do not have access to that resource.',
    })).toBe('You do not have access to that resource.')
  })

  it('translates network_policy_blocked into an admin-actionable sentence, not a session expiry', () => {
    expect(translateError({
      status: 401,
      code: 'network_policy_blocked',
      message: "Your Snowflake account's network policy is blocking this connection. Contact your Snowflake administrator.",
    })).toBe("Your Snowflake account's network policy is blocking this connection. Contact your Snowflake administrator.")
  })

  it('passes through the server message for other 4xx codes', () => {
    expect(translateError({ status: 400, message: 'thread_id must be provided' }))
      .toBe('thread_id must be provided')
  })

  it('falls back to a generic sentence for a 4xx with no message', () => {
    expect(translateError({ status: 400 })).toBe('That request could not be completed.')
  })

  it('recognizes a network failure by its message, with no status', () => {
    expect(translateError({ message: 'Failed to fetch' }))
      .toBe("Couldn't reach Snowflake. Check your connection and try again.")
    expect(translateError({ message: 'NetworkError when attempting to fetch resource.' }))
      .toBe("Couldn't reach Snowflake. Check your connection and try again.")
  })

  it('passes through a structured Cortex error that carries a code', () => {
    expect(translateError({ code: '399518', message: 'thread_id must be provided' }))
      .toBe('thread_id must be provided')
  })

  it('falls back to a generic sentence for anything else, never echoing a raw Error.message', () => {
    expect(translateError({ message: 'Something odd happened' })).toBe('Something went wrong. Please try again.')
    expect(translateError({ message: 'Unexpected token < in JSON' })).toBe('Something went wrong. Please try again.')
    expect(translateError({})).toBe('Something went wrong. Please try again.')
  })
})
