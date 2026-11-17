// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { registerMcpOAuthRoutes } from './mcp-oauth.routes.js'
import { resetMcpOAuthFlows } from '../snowflake/mcp-oauth.js'
import type { CortexRouteDeps } from './deps.js'
import type { SnowflakeCredential } from '../snowflake/credential.js'
import type { CredentialFailure } from '../host/credentialResolver.js'

function depsWith(
  resolve: () => Promise<SnowflakeCredential | CredentialFailure>,
): CortexRouteDeps {
  return {
    config: {
      snowflakeAccount: 'testacct',
      defaultAgentFqn: 'DB.SCH.AG',
    } as CortexRouteDeps['config'],
    host: { originApp: 'agents_test', credentials: { resolve } },
  }
}

const OAUTH: SnowflakeCredential = { token: 'tok', tokenType: 'OAUTH' }
const MCP = 'DEMO_DB.AGENTS.JIRA_MCP'
const AUTH_URL = 'https://testacct.snowflakecomputing.com/oauth/start?sfc_code=abc'

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

afterEach(async () => {
  await resetMcpOAuthFlows()
  vi.restoreAllMocks()
})

describe('POST /api/mcp/oauth/start', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const deps = depsWith(async () => ({ error: 'Unauthorized', status: 401 }))
    const app = new Hono()
    registerMcpOAuthRoutes(app, deps)
    const res = await app.request('/api/mcp/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServer: MCP }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 on invalid JSON', async () => {
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerMcpOAuthRoutes(app, deps)
    const res = await app.request('/api/mcp/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('returns the authorization URL and flowId on success', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonRes({ success: true, data: { token: 'sess' } }))
      .mockResolvedValueOnce(jsonRes({
        success: true,
        data: {
          rowtype: [{ name: 'INTEGRATION' }],
          rowset: [['JIRA_MCP_INTEGRATION']],
        },
      }))
      .mockResolvedValueOnce(jsonRes({
        success: true,
        data: { rowtype: [{ name: 'SYSTEM$START_USER_OAUTH_FLOW' }], rowset: [[AUTH_URL]] },
      })))
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerMcpOAuthRoutes(app, deps)
    const res = await app.request('/api/mcp/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServer: MCP }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { authorizationUrl: string; flowId: string }
    expect(body.authorizationUrl).toBe(AUTH_URL)
    expect(body.flowId).toBeTruthy()
  })
})

describe('GET /api/mcp/connections', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const deps = depsWith(async () => ({ error: 'Unauthorized', status: 401 }))
    const app = new Hono()
    registerMcpOAuthRoutes(app, deps)
    const res = await app.request('/api/mcp/connections?fqn=DB.SCH.AG')
    expect(res.status).toBe(401)
  })

  it('returns the agent MCP list and the native CoWork URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const statement = JSON.parse(String(init?.body)).statement as string
      if (statement.includes('DESCRIBE AGENT')) {
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'agent_spec' }] },
          data: [[JSON.stringify({
            tools: [],
            mcp_servers: [{ server_spec: { name: MCP } }],
          })]],
        })
      }
      if (statement.includes('DESCRIBE EXTERNAL MCP SERVER')) {
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'INTEGRATION' }] },
          data: [['JIRA_MCP_INTEGRATION']],
        })
      }
      if (statement.includes('GET_USER_INTEGRATION_AUTHORIZATIONS')) {
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'SYSTEM$GET_USER_INTEGRATION_AUTHORIZATIONS' }] },
          data: [[JSON.stringify([{
            integrationName: 'JIRA_MCP_INTEGRATION',
            status: 'CONNECTED',
          }])]],
        })
      }
      return jsonRes({}, 500)
    }))
    const deps = depsWith(async () => OAUTH)
    deps.config.snowflakeAccount = 'myorg-myaccount'
    const app = new Hono()
    registerMcpOAuthRoutes(app, deps)
    const res = await app.request('/api/mcp/connections?fqn=DB.SCH.AG')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      coworkUrl: 'https://ai.snowflake.com/myorg/myaccount/#/capabilities/connectors',
      servers: [{ fqn: MCP, displayName: 'JIRA', connected: true }],
    })
  })

  it('returns connected false when the integration is not CONNECTED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const statement = JSON.parse(String(init?.body)).statement as string
      if (statement.includes('DESCRIBE AGENT')) {
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'agent_spec' }] },
          data: [[JSON.stringify({
            tools: [],
            mcp_servers: [{ server_spec: { name: MCP } }],
          })]],
        })
      }
      if (statement.includes('DESCRIBE EXTERNAL MCP SERVER')) {
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'INTEGRATION' }] },
          data: [['JIRA_MCP_INTEGRATION']],
        })
      }
      if (statement.includes('GET_USER_INTEGRATION_AUTHORIZATIONS')) {
        return jsonRes({
          resultSetMetaData: { rowType: [{ name: 'SYSTEM$GET_USER_INTEGRATION_AUTHORIZATIONS' }] },
          data: [[JSON.stringify([{
            integrationName: 'JIRA_MCP_INTEGRATION',
            status: 'NOT_CONNECTED',
          }])]],
        })
      }
      return jsonRes({}, 500)
    }))
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerMcpOAuthRoutes(app, deps)
    const res = await app.request('/api/mcp/connections?fqn=DB.SCH.AG')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      servers: [{ fqn: MCP, displayName: 'JIRA', connected: false }],
    })
  })
})

describe('POST /api/mcp/oauth/finish', () => {
  it('returns 404 when no start is in flight', async () => {
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerMcpOAuthRoutes(app, deps)
    const res = await app.request('/api/mcp/oauth/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId: 'missing', redirect: 'state=1' }),
    })
    expect(res.status).toBe(404)
  })
})
