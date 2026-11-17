// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono'
import { resolveAuthorizedAgent } from '../snowflake/agent-ref.js'
import { getAgentDetails } from '../snowflake/agent-details.js'
import { connectorsUrlFromAccount } from '../snowflake/connectors-url.js'
import { isCredentialFailure } from '../host/credentialResolver.js'
import { isUpstreamTimeoutError } from '../snowflake/fetch-timeout.js'
import { resolveMcpConnectionStatus } from '../snowflake/mcp-authorizations.js'
import { finishMcpUserOAuth, McpOAuthError, startMcpUserOAuth } from '../snowflake/mcp-oauth.js'
import type { CortexRouteDeps } from './deps.js'

export function registerMcpOAuthRoutes(app: Hono, deps: CortexRouteDeps) {
  // Lists MCP servers on the current agent and the native CoWork URL to connect
  // them. `connected` is SYSTEM$GET_USER_INTEGRATION_AUTHORIZATIONS status
  // CONNECTED — the same check native CoWork uses — not thread evidence.
  app.get('/api/mcp/connections', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    const fqn = c.req.query('fqn') ?? deps.config.defaultAgentFqn
    if (!fqn) return c.json({ error: 'Missing fqn' }, 400)
    const authorized = resolveAuthorizedAgent(fqn, deps.config.agentDiscovery, deps.config.agentAllowList)
    if (!authorized.ok) {
      return c.json(
        { error: authorized.status === 400 ? 'Invalid fqn' : authorized.error },
        authorized.status,
      )
    }

    try {
      const details = await getAgentDetails(deps.config.snowflakeAccount, cred, authorized.fqn)
      if (!details) return c.json({ error: 'Failed to describe agent' }, 502)
      const servers = await resolveMcpConnectionStatus(
        deps.config.snowflakeAccount,
        cred,
        details.mcpServers,
      )
      return c.json({
        coworkUrl: connectorsUrlFromAccount(deps.config.snowflakeAccount),
        servers,
      })
    } catch (err) {
      if (isUpstreamTimeoutError(err)) return c.json({ error: 'The upstream service timed out.' }, 504)
      throw err
    }
  })

  app.post('/api/mcp/oauth/start', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    let body: Record<string, unknown>
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    const mcpServer = typeof body.mcpServer === 'string' ? body.mcpServer : ''

    try {
      const result = await startMcpUserOAuth(deps.config.snowflakeAccount, cred, mcpServer)
      return c.json(result)
    } catch (err) {
      if (err instanceof McpOAuthError) return c.json({ error: err.message }, err.status)
      if (isUpstreamTimeoutError(err)) return c.json({ error: 'The upstream service timed out.' }, 504)
      console.error('MCP OAuth start failed:', err)
      return c.json({ error: 'Could not start the connector sign-in.' }, 502)
    }
  })

  app.post('/api/mcp/oauth/finish', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    let body: Record<string, unknown>
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    const flowId = typeof body.flowId === 'string' ? body.flowId : ''
    const redirect = typeof body.redirect === 'string' ? body.redirect : ''

    try {
      await finishMcpUserOAuth(cred, flowId, redirect)
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof McpOAuthError) return c.json({ error: err.message }, err.status)
      if (isUpstreamTimeoutError(err)) return c.json({ error: 'The upstream service timed out.' }, 504)
      console.error('MCP OAuth finish failed:', err)
      return c.json({ error: 'Could not finish the connector sign-in.' }, 502)
    }
  })
}
