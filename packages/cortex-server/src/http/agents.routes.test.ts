// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { registerAgentsRoutes } from './agents.routes.js'
import { resetListAgentsCache } from '../snowflake/list-agents.js'
import type { CortexRouteDeps } from './deps.js'
import type { SnowflakeCredential } from '../snowflake/credential.js'
import type { CredentialFailure } from '../host/credentialResolver.js'

function depsWith(
  resolve: () => Promise<SnowflakeCredential | CredentialFailure>,
  configOverrides: Partial<CortexRouteDeps['config']> = {},
): CortexRouteDeps {
  return {
    config: {
      snowflakeAccount: 'testacct',
      defaultAgentFqn: 'DB.SCH.AG',
      agentAllowList: [],
      agentDiscovery: 'dynamic',
      ...configOverrides,
    } as CortexRouteDeps['config'],
    host: { originApp: 'agents_test', credentials: { resolve } },
  }
}

const OAUTH: SnowflakeCredential = { token: 'tok', tokenType: 'OAUTH' }

function showAgentsResult(rows: string[][]) {
  return {
    resultSetMetaData: { rowType: [{ name: 'name' }, { name: 'database_name' }, { name: 'schema_name' }, { name: 'comment' }] },
    data: rows,
  }
}

afterEach(() => { resetListAgentsCache(); vi.restoreAllMocks() })

describe('GET /api/agents', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const deps = depsWith(async () => ({ error: 'Unauthorized', status: 401 }))
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents')
    expect(res.status).toBe(401)
  })

  it('returns the allow-list verbatim in static discovery mode, without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => OAUTH, {
      agentDiscovery: 'static',
      agentAllowList: [{ fqn: 'DB.SCH.AG', displayName: 'Test Agent' }],
    })
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents')
    expect(await res.json()).toEqual([{ fqn: 'DB.SCH.AG', displayName: 'Test Agent' }])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('discovers agents via SHOW AGENTS in dynamic mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(showAgentsResult([
      ['SALES_AGENT', 'DB', 'SCH', ''],
    ])), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => OAUTH, { agentDiscovery: 'dynamic' })
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents')
    expect(await res.json()).toEqual([{ fqn: 'DB.SCH.SALES_AGENT', displayName: 'SALES_AGENT' }])
  })
})

describe('GET /api/agents/sample-questions', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const deps = depsWith(async () => ({ error: 'Unauthorized', status: 401 }))
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents/sample-questions')
    expect(res.status).toBe(401)
  })

  it('falls back to config.defaultAgentFqn when ?fqn= is omitted', async () => {
    // The deliberate behavior change made canonical in this stage: the
    // originally-Teams-only route required an explicit fqn and returned []
    // otherwise. A caller with no agent selected yet now gets the default
    // agent's starter questions instead.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      resultSetMetaData: { rowType: [{ name: 'property' }, { name: 'value' }] },
      data: [['agent_spec', JSON.stringify({ instructions: { sample_questions: [{ question: 'Q from default agent' }] } })]],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents/sample-questions')
    expect(await res.json()).toEqual({ questions: ['Q from default agent'] })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).statement).toBe("DESCRIBE AGENT IDENTIFIER('DB.SCH.AG')")
  })

  it('returns [] with no call to fetch when neither ?fqn= nor a default is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => OAUTH, { defaultAgentFqn: '' })
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents/sample-questions')
    expect(await res.json()).toEqual({ questions: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses an explicit ?fqn= over the default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    await app.request('/api/agents/sample-questions?fqn=OTHER.DB.AGENT')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).statement).toBe("DESCRIBE AGENT IDENTIFIER('OTHER.DB.AGENT')")
  })

  it('returns [] in static mode for an FQN outside the allow-list, without DESCRIBE', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => OAUTH, {
      agentDiscovery: 'static',
      agentAllowList: [{ fqn: 'DB.SCH.AG', displayName: 'Allowed' }],
    })
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents/sample-questions?fqn=OTHER.DB.AGENT')
    expect(await res.json()).toEqual({ questions: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns [] rather than an error for a malformed ?fqn=', async () => {
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents/sample-questions?fqn=not-a-fqn')
    expect(await res.json()).toEqual({ questions: [] })
  })
})

describe('GET /api/agents/details', () => {
  it('returns the credential failure status/error when the resolver fails', async () => {
    const deps = depsWith(async () => ({ error: 'Unauthorized', status: 401 }))
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents/details')
    expect(res.status).toBe(401)
  })

  it('falls back to config.defaultAgentFqn when ?fqn= is omitted, returning 200 not 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      resultSetMetaData: { rowType: [{ name: 'property' }, { name: 'value' }] },
      data: [['agent_spec', JSON.stringify({ models: { orchestration: 'claude-sonnet-4-5' } })]],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents/details')
    expect(res.status).toBe(200)
    expect((await res.json()).orchestrationModel).toBe('claude-sonnet-4-5')
  })

  it('returns 400 when neither ?fqn= nor a default is configured', async () => {
    const deps = depsWith(async () => OAUTH, { defaultAgentFqn: '' })
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents/details')
    expect(res.status).toBe(400)
  })

  it('returns 400 on a malformed ?fqn=', async () => {
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents/details?fqn=not-a-fqn')
    expect(res.status).toBe(400)
  })

  it('returns 403 in static mode for an FQN outside the allow-list', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const deps = depsWith(async () => OAUTH, {
      agentDiscovery: 'static',
      agentAllowList: [{ fqn: 'DB.SCH.AG', displayName: 'Allowed' }],
    })
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents/details?fqn=OTHER.DB.AGENT')
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 502 when DESCRIBE AGENT fails upstream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })))
    const deps = depsWith(async () => OAUTH)
    const app = new Hono()
    registerAgentsRoutes(app, deps)
    const res = await app.request('/api/agents/details')
    expect(res.status).toBe(502)
  })
})
