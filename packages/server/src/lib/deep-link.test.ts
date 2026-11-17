// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { buildDeepLinkServer } from './deep-link.js'

describe('buildDeepLinkServer', () => {
  it('uses agents-tab entityId (not cowork-personal)', () => {
    const url = buildDeepLinkServer('app-123', 42)
    expect(url).toContain('/agents-tab')
    expect(url).not.toContain('cowork-personal')
  })

  it('encodes thread:<id> in subEntityId when threadId provided', () => {
    const url = buildDeepLinkServer('app-id', 55)
    const contextParam = new URL(url).searchParams.get('context')
    const context = JSON.parse(contextParam!)
    expect(context.subEntityId).toBe('thread:55')
  })
})
