// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { classifyError } from './classifyError'
import { ApiError } from '../api/apiError'

describe('classifyError', () => {
  it('classifies a 401/403 as permanent with a sign-in message', () => {
    expect(classifyError(new ApiError('unauthorized', 401), 'fallback')).toEqual({
      tone: 'permanent', message: 'Your session has expired. Please refresh the page and sign in again.', raw: 'unauthorized',
    })
  })

  it('classifies agent_forbidden as a resource-access failure, not a session expiry', () => {
    expect(classifyError(new ApiError('You do not have access to that resource.', 401, 'agent_forbidden'), 'fallback')).toEqual({
      tone: 'permanent', message: 'You do not have access to that resource.', raw: 'You do not have access to that resource.',
    })
  })

  it('classifies other 4xx as permanent, using translateError\'s sentence', () => {
    const c = classifyError(new ApiError('bad request', 400), 'fallback')
    expect(c.tone).toBe('permanent')
    expect(c.message).toBe('bad request')
    expect(c.raw).toBe('bad request')
  })

  it('classifies 429 as transient with the rate-limit sentence', () => {
    const c = classifyError(new ApiError('Too Many Requests', 429), 'fallback')
    expect(c.tone).toBe('transient')
    expect(c.message).toBe("You're sending messages too quickly. Please wait a moment and try again.")
    expect(c.raw).toBe('Too Many Requests')
  })

  it('classifies 408 and 425 as transient', () => {
    expect(classifyError(new ApiError('timeout', 408), 'fallback').tone).toBe('transient')
    expect(classifyError(new ApiError('too early', 425), 'fallback').tone).toBe('transient')
  })

  it('classifies 5xx as transient with translateError\'s unavailable sentence', () => {
    const c = classifyError(new ApiError('INTERNAL_ERROR: statement timed out after 30s', 500), 'fallback')
    expect(c.tone).toBe('transient')
    expect(c.message).toBe('Cortex is temporarily unavailable. Please try again in a moment.')
    expect(c.raw).toBe('INTERNAL_ERROR: statement timed out after 30s')
  })

  it('classifies a plain network error as transient with the reachability sentence', () => {
    const c = classifyError(new TypeError('Failed to fetch'), 'fallback')
    expect(c.tone).toBe('transient')
    expect(c.message).toBe("Couldn't reach Snowflake. Check your connection and try again.")
    expect(c.raw).toBe('Failed to fetch')
  })

  it('falls back to the provided message when the error is not an Error', () => {
    const c = classifyError('not an error object', 'Failed to load history')
    expect(c.raw).toBe('Failed to load history')
    expect(c.tone).toBe('transient')
    expect(c.message).toBe('Something went wrong. Please try again.')
  })
})
