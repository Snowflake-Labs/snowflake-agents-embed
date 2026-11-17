// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { filterResponseHeaders, filterUpstreamResponse } from './filter-headers'

describe('filterResponseHeaders', () => {
  it('keeps the allow-list and drops Set-Cookie, CORS and Location', () => {
    const src = new Headers({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Retry-After': '5',
      'X-Request-Id': 'abc',
      'Set-Cookie': 'sf=token',
      'Access-Control-Allow-Origin': '*',
      Location: 'https://evil.example',
    })
    const out = filterResponseHeaders(src)
    expect(out.get('Content-Type')).toBe('text/event-stream')
    expect(out.get('Cache-Control')).toBe('no-cache')
    expect(out.get('X-Accel-Buffering')).toBe('no')
    expect(out.get('Retry-After')).toBe('5')
    expect(out.get('X-Request-Id')).toBe('abc')
    expect(out.get('Set-Cookie')).toBeNull()
    expect(out.get('Access-Control-Allow-Origin')).toBeNull()
    expect(out.get('Location')).toBeNull()
  })
})

describe('filterUpstreamResponse', () => {
  it('preserves status and body while filtering headers', async () => {
    const res = filterUpstreamResponse(
      new Response('chunk', { status: 200, headers: { 'Content-Type': 'text/plain', 'Set-Cookie': 'x' } }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('chunk')
    expect(res.headers.get('Content-Type')).toBe('text/plain')
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })
})
