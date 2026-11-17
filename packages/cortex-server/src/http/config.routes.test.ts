// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { registerConfigRoutes } from './config.routes.js'
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

const DEPS: CortexRouteDeps = {
  config: {
    snowflakeAccount: 'testacct',
    port: 3000,
    defaultAgentFqn: '',
    agentAllowList: [],
    agentDiscovery: 'dynamic',
    featureFlags: { fileUpload: true, deepResearch: true, skills: true, webSearch: true, richComposer: true, nativeStreamFlags: true },
  },
  host: STUB_HOST,
}

describe('GET /api/config', () => {
  it('returns 401 without a resolved credential', async () => {
    const app = new Hono()
    registerConfigRoutes(app, { ...DEPS, host: UNAUTH_HOST })
    const res = await app.request('/api/config')
    expect(res.status).toBe(401)
  })

  it('returns feature flags and defaultAgentFqn when authenticated', async () => {
    const app = new Hono()
    registerConfigRoutes(app, DEPS)
    const res = await app.request('/api/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      fileUpload: true,
      deepResearch: true,
      skills: true,
      webSearch: true,
      richComposer: true,
      nativeStreamFlags: true,
      defaultAgentFqn: '',
    })
  })

  it('includes a configured defaultAgentFqn', async () => {
    const app = new Hono()
    registerConfigRoutes(app, {
      ...DEPS,
      config: { ...DEPS.config, defaultAgentFqn: 'DB.SCH.AG' },
    })
    const res = await app.request('/api/config')
    expect(await res.json()).toMatchObject({ defaultAgentFqn: 'DB.SCH.AG' })
  })
})
