// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { registerTelemetryRoutes } from './telemetry.routes.js'
import type { CortexRouteDeps } from './deps.js'
import { STUB_HOST } from './test-support.js'

const UNAUTH_HOST = {
  originApp: 'agents_test',
  credentials: {
    async resolve() {
      return { error: 'Unauthorized', status: 401 as const }
    },
  },
}

const DEPS = { config: {}, host: STUB_HOST } as CortexRouteDeps

afterEach(() => { vi.restoreAllMocks() })

describe('POST /api/telemetry', () => {
  it('returns 401 without a resolved credential', async () => {
    const app = new Hono()
    registerTelemetryRoutes(app, { ...DEPS, host: UNAUTH_HOST })
    const res = await app.request('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'agent_run', fields: { ttftMs: 200 } }),
    })
    expect(res.status).toBe(401)
  })

  it('accepts a well-formed event with a resolved credential and returns 204', async () => {
    const app = new Hono()
    registerTelemetryRoutes(app, DEPS)
    const res = await app.request('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'agent_run', fields: { ttftMs: 200 } }),
    })
    expect(res.status).toBe(204)
  })

  it('returns 204 even on malformed JSON, rather than erroring', async () => {
    const app = new Hono()
    registerTelemetryRoutes(app, DEPS)
    const res = await app.request('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(204)
  })

  it('logs the event and fields', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = new Hono()
    registerTelemetryRoutes(app, DEPS)
    await app.request('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'agent_run', fields: { ttftMs: 200 } }),
    })
    expect(logSpy).toHaveBeenCalledWith('[telemetry] agent_run', '{"ttftMs":200}')
  })

  it('caps event length and strips control characters from the log line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = new Hono()
    registerTelemetryRoutes(app, DEPS)
    await app.request('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'x'.repeat(80) + '\nINFO fake',
        fields: { note: 'a'.repeat(600) },
      }),
    })
    const [label, fields] = logSpy.mock.calls[0]
    expect(String(label).length).toBeLessThanOrEqual('[telemetry] '.length + 64)
    expect(String(label)).not.toContain('\n')
    expect(String(fields).length).toBeLessThanOrEqual(512)
  })
})
