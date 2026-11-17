// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { REQUEST_ALLOW } from './strip-headers.js'

describe('REQUEST_ALLOW', () => {
  it.each(['content-type', 'accept', 'accept-language', 'x-request-id'] as const)('allows %s', (name) => {
    expect(REQUEST_ALLOW.has(name)).toBe(true)
  })

  it.each(['cookie', 'host', 'x-forwarded-for', 'forwarded', 'authorization', 'x-bot-auth'] as const)(
    'does not allow %s',
    (name) => {
      expect(REQUEST_ALLOW.has(name)).toBe(false)
    },
  )
})
