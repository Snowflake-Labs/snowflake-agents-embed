// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { securityHeaders } from './security-headers'

describe('securityHeaders', () => {
  it('restricts framing to Teams and Outlook, with no X-Frame-Options', () => {
    const h = securityHeaders()
    expect(h['Content-Security-Policy']).toContain('frame-ancestors https://teams.microsoft.com')
    expect(h['Content-Security-Policy']).toContain("script-src 'self'")
    expect(h['Content-Security-Policy']).toContain("connect-src 'self'")
    expect(h['Content-Security-Policy']).toContain("object-src 'none'")
    expect(h).not.toHaveProperty('X-Frame-Options')
  })

  it('adds connect-src self on request', () => {
    expect(securityHeaders({ connectSelfOnly: true })['Content-Security-Policy']).toContain("connect-src 'self'")
  })

  it('sets nosniff, referrer policy and HSTS', () => {
    const h = securityHeaders()
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d+/)
  })
})
