// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { ApiError, throwFromResponse } from './apiError'

describe('ApiError', () => {
  it('carries the HTTP status alongside the message', () => {
    const err = new ApiError('boom', 429)
    expect(err.message).toBe('boom')
    expect(err.status).toBe(429)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('throwFromResponse', () => {
  it('throws an ApiError with the response detail and status', async () => {
    const res = new Response(JSON.stringify({ detail: 'thread not found' }), { status: 404 })
    await expect(throwFromResponse(res, 'Failed to describe thread'))
      .rejects.toMatchObject({ message: 'thread not found', status: 404 })
  })

  it('falls back to the error field when detail is absent', async () => {
    const res = new Response(JSON.stringify({ error: 'Missing fqn', code: 'upstream_error' }), { status: 400 })
    await expect(throwFromResponse(res, 'Failed to describe agent'))
      .rejects.toMatchObject({ message: 'Missing fqn', status: 400, code: 'upstream_error' })
  })

  it('prefers detail over error when both are present', async () => {
    const res = new Response(JSON.stringify({ detail: 'from detail', error: 'from error' }), { status: 400 })
    await expect(throwFromResponse(res, 'Failed'))
      .rejects.toMatchObject({ message: 'from detail', status: 400 })
  })

  it('falls back to a generic message when the body has no detail', async () => {
    const res = new Response('not json', { status: 500 })
    await expect(throwFromResponse(res, 'Failed to list threads'))
      .rejects.toMatchObject({ message: 'Failed to list threads: 500', status: 500 })
  })
})
