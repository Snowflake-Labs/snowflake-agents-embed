// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { buildDeepLink } from './deep-link'

describe('buildDeepLink', () => {
  it('uses agents-tab entityId (not cowork-personal)', () => {
    const url = buildDeepLink('app-123', 42)
    expect(url).toContain('/agents-tab')
    expect(url).not.toContain('cowork-personal')
  })

  it('includes the appId in the URL', () => {
    const url = buildDeepLink('my-app-id')
    expect(url).toContain('my-app-id')
  })

  it('encodes thread:<id> in subEntityId when threadId provided', () => {
    const url = buildDeepLink('app-id', 99)
    const contextParam = new URL(url).searchParams.get('context')
    const context = JSON.parse(contextParam!)
    expect(context.subEntityId).toBe('thread:99')
  })

  it('uses empty subEntityId when no threadId', () => {
    const url = buildDeepLink('app-id')
    const contextParam = new URL(url).searchParams.get('context')
    const context = JSON.parse(contextParam!)
    expect(context.subEntityId).toBe('')
  })
})
