// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logSafeError } from './log-safe-error.js'

afterEach(() => vi.restoreAllMocks())

describe('logSafeError', () => {
  it('logs only name, code, status and message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSafeError('boom', { name: 'JoseError', code: 'ERR_JWT', status: 401, message: 'bad', payload: { upn: 'secret' } })
    expect(spy).toHaveBeenCalledWith('boom', { name: 'JoseError', code: 'ERR_JWT', status: 401, message: 'bad' })
  })
})
