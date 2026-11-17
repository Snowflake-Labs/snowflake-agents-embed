// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono'
import { listAgentsForUser } from '../snowflake/list-agents.js'
import { getSampleQuestions, getAgentDetails } from '../snowflake/agent-details.js'
import { resolveAuthorizedAgent } from '../snowflake/agent-ref.js'
import { isCredentialFailure } from '../host/credentialResolver.js'
import type { CortexRouteDeps } from './deps.js'

export function registerAgentsRoutes(app: Hono, deps: CortexRouteDeps) {
  app.get('/api/agents', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    // Static mode: an admin curated an explicit AGENT_ALLOW_LIST - return it
    // verbatim. Dynamic mode: discover the agents the caller's role can access
    // via SHOW AGENTS (RBAC-filtered), matching Snowflake Intelligence. These
    // are mutually exclusive (an explicit allow-list forces static mode).
    if (deps.config.agentDiscovery === 'static') {
      return c.json(deps.config.agentAllowList)
    }
    const agents = await listAgentsForUser(deps.config.snowflakeAccount, cred)
    return c.json(agents)
  })

  // Per-agent sample ("starter") questions, sourced from the agent spec via
  // DESCRIBE AGENT. The client shows these on the empty-chat screen and falls
  // back to its own defaults when the list is empty.
  //
  // Falls back to config.defaultAgentFqn when the caller omits ?fqn= - the
  // originally-Teams-only version of this route required an explicit fqn and
  // returned [] otherwise. Adopting the fallback (already present in relay's
  // version) means a caller that hasn't picked an agent yet still gets that
  // agent's starter questions instead of an empty list.
  app.get('/api/agents/sample-questions', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    const fqn = c.req.query('fqn') ?? deps.config.defaultAgentFqn
    if (!fqn) return c.json({ questions: [] })
    const authorized = resolveAuthorizedAgent(fqn, deps.config.agentDiscovery, deps.config.agentAllowList)
    if (!authorized.ok) return c.json({ questions: [] })
    const questions = await getSampleQuestions(deps.config.snowflakeAccount, cred, authorized.fqn)
    return c.json({ questions })
  })

  // Fuller agent surface for the RightPanel's "Agent details" view - orchestration model,
  // response/orchestration instructions, tool list, data sources. Same DESCRIBE AGENT call
  // as sample-questions above, just parsed differently. Same defaultAgentFqn fallback and
  // the same reasoning as sample-questions above - a caller that hasn't picked an agent yet
  // gets a 200 with that agent's details instead of a 400.
  app.get('/api/agents/details', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    const fqn = c.req.query('fqn') ?? deps.config.defaultAgentFqn
    if (!fqn) return c.json({ error: 'Missing fqn' }, 400)
    const authorized = resolveAuthorizedAgent(fqn, deps.config.agentDiscovery, deps.config.agentAllowList)
    if (!authorized.ok) return c.json({ error: authorized.status === 400 ? 'Invalid fqn' : authorized.error }, authorized.status)
    const details = await getAgentDetails(deps.config.snowflakeAccount, cred, authorized.fqn)
    if (!details) return c.json({ error: 'Failed to describe agent' }, 502)
    return c.json(details)
  })
}
