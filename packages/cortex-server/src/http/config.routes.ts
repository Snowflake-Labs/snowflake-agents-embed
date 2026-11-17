// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono'
import type { CortexRouteDeps } from './deps.js'
import { isCredentialFailure } from '../host/credentialResolver.js'

/**
 * Runtime feature flags plus the org default agent FQN. chat-core's lib/featureFlags.ts
 * fetches this once at boot (with the host token) and falls back to build-time VITE_FF_*
 * / no default FQN if the fetch fails.
 */
export function registerConfigRoutes(app: Hono, deps: CortexRouteDeps) {
  app.get('/api/config', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)
    return c.json({
      ...deps.config.featureFlags,
      defaultAgentFqn: deps.config.defaultAgentFqn ?? '',
    })
  })
}
