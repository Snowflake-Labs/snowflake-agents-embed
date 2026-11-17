// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { BodyTooLargeError, readJsonCapped, readTextCapped } from './body-limit'

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request('https://x.test/', { method: 'POST', body, headers })

describe('readTextCapped', () => {
  it('reads a body under the cap', async () => {
    expect(await readTextCapped(post('hello'), 10)).toBe('hello')
  })

  it('rejects a body over the cap without trusting Content-Length', async () => {
    await expect(readTextCapped(post('x'.repeat(50), { 'Content-Length': '1' }), 10)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    )
  })

  it('rejects early on a large declared Content-Length', async () => {
    await expect(readTextCapped(post('x', { 'Content-Length': '999' }), 10)).rejects.toBeInstanceOf(BodyTooLargeError)
  })
})

describe('readJsonCapped', () => {
  it('returns null for invalid JSON', async () => {
    expect(await readJsonCapped(post('{nope'), 100)).toBeNull()
  })

  it('parses valid JSON', async () => {
    expect(await readJsonCapped(post('{"a":1}'), 100)).toEqual({ a: 1 })
  })
})
