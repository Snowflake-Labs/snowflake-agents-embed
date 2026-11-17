// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { codeForUpstreamStatus, redactedUpstreamError, redactedUpstreamErrorFrom, passThroughOrRedact } from './upstream-error.js'

afterEach(() => { vi.restoreAllMocks() })

describe('codeForUpstreamStatus', () => {
  it('maps 401/403 to agent_forbidden, 404 to thread_not_found, 429 to rate-limited', () => {
    expect(codeForUpstreamStatus(401)).toBe('agent_forbidden')
    expect(codeForUpstreamStatus(403)).toBe('agent_forbidden')
    expect(codeForUpstreamStatus(404)).toBe('thread_not_found')
    expect(codeForUpstreamStatus(429)).toBe('upstream_rate_limited')
    expect(codeForUpstreamStatus(500)).toBe('upstream_error')
  })

  it('maps a 401 carrying Snowflake error 390422 to network_policy_blocked, not agent_forbidden', () => {
    const detail = JSON.stringify({ code: '390422', message: 'Incoming request with IP/Token 1.2.3.4 is not allowed.' })
    expect(codeForUpstreamStatus(401, detail)).toBe('network_policy_blocked')
  })

  it('maps a 401 carrying Snowflake error 395090 to host_mode_rejects_user_token', () => {
    const detail = JSON.stringify({ code: '395090', message: 'Please use OAuth when connecting to Snowflake via Snowpark Container Services.' })
    expect(codeForUpstreamStatus(401, detail)).toBe('host_mode_rejects_user_token')
  })

  it('falls back to agent_forbidden when the 401 body has no recognized Snowflake code', () => {
    expect(codeForUpstreamStatus(401, JSON.stringify({ code: '390100' }))).toBe('agent_forbidden')
    expect(codeForUpstreamStatus(401, 'not json')).toBe('agent_forbidden')
    expect(codeForUpstreamStatus(401, '')).toBe('agent_forbidden')
  })
})

describe('redactedUpstreamError', () => {
  it('keeps the upstream status and omits the upstream body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await redactedUpstreamError(new Response('role SYSADMIN denied on DB.SCH.T', { status: 403 }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: 'You do not have access to that resource.',
      code: 'agent_forbidden',
    })
    expect(log).toHaveBeenCalled()
    expect(String(log.mock.calls[0])).toContain('SYSADMIN')
  })
})

describe('redactedUpstreamErrorFrom', () => {
  it('surfaces network_policy_blocked distinctly, and still logs the full detail server-side', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const detail = JSON.stringify({ code: '390422', message: 'Incoming request with IP/Token 1.2.3.4 is not allowed.' })
    const res = redactedUpstreamErrorFrom(401, detail)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: "Your Snowflake account's network policy is blocking this connection. Contact your Snowflake administrator.",
      code: 'network_policy_blocked',
    })
    expect(String(log.mock.calls[0])).toContain('1.2.3.4')
  })
})

describe('passThroughOrRedact', () => {
  it('forwards a 200 body unchanged', async () => {
    const res = await passThroughOrRedact(new Response('{"thread_id":1}', { status: 200 }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"thread_id":1}')
  })

  it('redacts a non-OK body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await passThroughOrRedact(new Response('statementHandle=abc sql=SELECT 1', { status: 422 }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('upstream_error')
    expect(JSON.stringify(body)).not.toContain('SELECT')
  })
})
