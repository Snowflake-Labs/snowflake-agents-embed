// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { isCredentialFailure } from './credentialResolver.js'

describe('isCredentialFailure', () => {
  it('narrows a credential to false', () => {
    expect(isCredentialFailure({ token: 't', tokenType: 'OAUTH' })).toBe(false)
  })
  it('narrows a failure to true', () => {
    expect(isCredentialFailure({ error: 'Unauthorized', status: 401 })).toBe(true)
  })
})
