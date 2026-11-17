// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { createEntraValidator } from './entra.js'

describe('createEntraValidator', () => {
  it('returns null in local-pat mode without calling JWKS', async () => {
    const validate = createEntraValidator({ authMode: 'local-pat' } as any)
    expect(validate).toBeNull()
  })
})
