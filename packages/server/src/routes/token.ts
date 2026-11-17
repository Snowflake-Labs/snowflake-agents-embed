// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Context, Hono } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Config } from '../config.js'
import { createEntraValidator } from '../auth/entra.js'
import { exchangeOnBehalfOf, OboExchangeError } from '../auth/obo.js'
import { logSafeError } from '@snowflake-agents-embed/cortex-server/http/log-safe-error'
import { snowflakeBase, snowflakeHeaders } from '@snowflake-agents-embed/cortex-server/snowflake/credential'

const LOCAL_PAT_EXPIRES_IN = 300

// local-pat echoes the caller's PAT back as a "Snowflake token"; only a socket-level loopback
// peer may use it. Unresolvable peers (no node bindings) are denied.
function isLoopbackPeer(c: Context): boolean {
  try {
    const addr = getConnInfo(c).remote.address
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  } catch {
    return false
  }
}

async function probeLocalPat(account: string, pat: string): Promise<boolean> {
  const url = `${snowflakeBase(account)}/api/v2/cortex/threads?page_size=1`
  try {
    const res = await fetch(url, {
      headers: snowflakeHeaders({ token: pat, tokenType: 'PROGRAMMATIC_ACCESS_TOKEN' }),
    })
    // 401/403 = rejected/expired. Any other status (including empty-list 200 or a
    // transient 5xx) means the credential was accepted enough to not fail closed here.
    return res.status !== 401 && res.status !== 403
  } catch {
    return false
  }
}

export function registerTokenRoutes(app: Hono, config: Config) {
  // Production traffic exchanges on the edge (/token/exchange) and must never
  // be able to pull a raw Snowflake token from this container, including via
  // an encoded /api/token/exchange that slipped past a proxy.
  if (config.authMode === 'production') return

  const validateEntra = createEntraValidator(config)

  app.post('/api/token/exchange', async (c) => {
    if (config.authMode === 'local-pat') {
      if (!isLoopbackPeer(c)) return c.json({ error: 'local-pat exchange is localhost-only' }, 403)
      const pat = c.req.header('X-Snowflake-Pat')
      if (!pat) return c.json({ error: 'X-Snowflake-Pat header required in local-pat mode' }, 400)
      const ok = await probeLocalPat(config.snowflakeAccount, pat)
      if (!ok) return c.json({ error: 'PAT rejected or expired' }, 401)
      return c.json({ snowflakeToken: pat, expiresIn: LOCAL_PAT_EXPIRES_IN })
    }

    const body = await c.req.json().catch(() => null)
    if (!body?.entraToken) return c.json({ error: 'entraToken required' }, 400)

    try {
      const verified = await validateEntra!(body.entraToken)
      const result = await exchangeOnBehalfOf(body.entraToken, config, verified)
      return c.json(result)
    } catch (err: unknown) {
      if (err instanceof OboExchangeError) {
        return c.json(
          { error: 'OBO exchange failed', status: err.status, ...(err.code ? { code: err.code } : {}) },
          401,
        )
      }
      logSafeError('Token exchange failed', err)
      return c.json({ error: 'Unauthorized' }, 401)
    }
  })
}
