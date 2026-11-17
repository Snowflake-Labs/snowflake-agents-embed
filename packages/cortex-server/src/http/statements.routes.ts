// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono'
import { snowflakeBase, snowflakeHeaders } from '../snowflake/credential.js'
import { InvalidPathIdError, statementUrl } from '../snowflake/path-id.js'
import { fetchWithTimeout } from '../snowflake/fetch-timeout.js'
import { isCredentialFailure } from '../host/credentialResolver.js'
import { passThroughOrRedact } from './upstream-error.js'
import type { CortexRouteDeps } from './deps.js'

// Proxies GET /api/v2/statements/{handle} (the SQL Statements API) so the client can fetch
// full, non-truncated table results by the query_id/statement handle a Cortex table artifact
// already carries. Pass-through, same shape as threads.routes.ts's GET /api/threads/:id.
export function registerStatementsRoutes(app: Hono, deps: CortexRouteDeps) {
  app.get('/api/statements/:handle', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    let url: URL
    try {
      url = statementUrl(snowflakeBase(deps.config.snowflakeAccount), c.req.param('handle'), c.req.query('partition'))
    } catch (err) {
      if (err instanceof InvalidPathIdError) return c.json({ error: err.message }, 400)
      throw err
    }

    const res = await fetchWithTimeout(url.toString(), { headers: snowflakeHeaders(cred) })
    return passThroughOrRedact(res)
  })
}
