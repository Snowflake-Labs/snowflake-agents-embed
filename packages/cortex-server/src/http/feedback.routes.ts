// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono'
import { resolveAuthorizedAgent } from '../snowflake/agent-ref.js'
import { submitFeedback } from '../snowflake/feedback.js'
import { isCredentialFailure } from '../host/credentialResolver.js'
import type { CortexRouteDeps } from './deps.js'

export function registerFeedbackRoutes(app: Hono, deps: CortexRouteDeps) {
  app.post('/api/feedback', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    let body: Record<string, unknown>
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    const fqn = (body.agentFqn as string | undefined) ?? deps.config.defaultAgentFqn
    if (!fqn) return c.json({ error: 'Agent not configured' }, 500)
    const authorized = resolveAuthorizedAgent(fqn, deps.config.agentDiscovery, deps.config.agentAllowList)
    if (!authorized.ok) return c.json({ error: authorized.error }, authorized.status)

    const result = await submitFeedback(deps.config.snowflakeAccount, cred, authorized.fqn, {
      positive: Boolean(body.positive),
      feedbackMessage: body.feedbackMessage as string | undefined,
      categories: body.categories as string[] | undefined,
      threadId: body.threadId as number | undefined,
    })
    return c.json({ ok: result.ok }, result.ok ? 200 : ((result.status ?? 502) as any))
  })
}
