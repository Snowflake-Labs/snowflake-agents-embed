// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest'
import { defaultRuntime } from './runtime'

describe('defaultRuntime', () => {
  it('reads the client IP from CF-Connecting-IP only', () => {
    const withIp = new Request('https://x.test/', { headers: { 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '1.2.3.4' } })
    expect(defaultRuntime.clientIp(withIp)).toBe('203.0.113.9')
    expect(defaultRuntime.clientIp(new Request('https://x.test/', { headers: { 'X-Forwarded-For': '1.2.3.4' } }))).toBeNull()
  })

  it('verifies the bot JWT on every topology, including the public path', () => {
    expect(defaultRuntime.requireBotVerify).toBe(true)
  })

  it('sends upstream requests through the global fetch', async () => {
    const f = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', f)
    const req = new Request('https://spcs.example.com/api/x')
    await defaultRuntime.upstreamFetch(req)
    expect(f).toHaveBeenCalledWith(req)
    vi.unstubAllGlobals()
  })
})
