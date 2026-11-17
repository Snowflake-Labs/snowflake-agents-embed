// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono'
import type { CortexRouteDeps } from './deps.js'
import { isCredentialFailure } from '../host/credentialResolver.js'
import { rateLimiter } from './rate-limit.js'

interface TelemetryBody {
  event?: string
  fields?: Record<string, unknown>
}

const EVENT_MAX = 64
const FIELDS_MAX = 512

function sanitizeLog(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ')
}

function capEvent(event: string): string {
  return sanitizeLog(event).slice(0, EVENT_MAX)
}

function capFields(fields: Record<string, unknown>): string {
  let raw = ''
  try { raw = JSON.stringify(fields) ?? '' } catch { raw = '[unserializable]' }
  return sanitizeLog(raw).slice(0, FIELDS_MAX)
}

/**
 * Fire-and-forget operational telemetry (time-to-first-token, duration, abort, error class -
 * not Datadog RUM). Requires the same forwarded user credential as other /api/* routes so a
 * PAT holder on the ingress cannot write arbitrary log lines. The client already sends the
 * edge session and ignores a 401.
 *
 * Tighter than the host-wide 60/min cap so this sink does not share the Cortex budget.
 */
export function registerTelemetryRoutes(app: Hono, deps: CortexRouteDeps) {
  app.use('/api/telemetry', rateLimiter({ windowMs: 60_000, max: 20 }))
  app.post('/api/telemetry', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)
    let body: TelemetryBody
    try { body = await c.req.json() } catch { return c.body(null, 204) }
    if (typeof body.event === 'string' && body.event) {
      console.log(`[telemetry] ${capEvent(body.event)}`, capFields(body.fields ?? {}))
    }
    return c.body(null, 204)
  })
}
