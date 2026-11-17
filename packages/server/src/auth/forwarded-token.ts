// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Context } from 'hono'
import {
  isCredentialFailure,
  type CredentialFailure,
  type SnowflakeCredentialResolver,
} from '@snowflake-agents-embed/cortex-server/host/credentialResolver'
import type { SnowflakeCredential } from '@snowflake-agents-embed/cortex-server/snowflake/credential'

export { isCredentialFailure }
export type { CredentialFailure }

/**
 * The Teams tab obtains a per-user Snowflake token via Entra on-behalf-of and forwards
 * it in `X-User-Access-Token` on every route - there is no service-token fallback like
 * relay's (see packages/relay/src/lib/auth.ts), because the tab always has its own
 * token by the time it calls the SPCS backend.
 *
 * In `local-pat` mode, `/api/token/exchange` (routes/token.ts) echoes the raw PAT back
 * as that same token rather than performing an OBO exchange, so it must be tagged
 * `PROGRAMMATIC_ACCESS_TOKEN` here too - tagging it `OAUTH` sends the right bearer value
 * with the wrong `X-Snowflake-Authorization-Token-Type`, which Snowflake rejects as an
 * invalid OAuth token (390303) rather than accepting it as the PAT it actually is.
 */
export function forwardedTokenResolver(authMode: 'local-pat' | 'local-oauth' | 'production'): SnowflakeCredentialResolver {
  return {
    async resolve(c: Context): Promise<SnowflakeCredential | CredentialFailure> {
      const token = c.req.header('X-User-Access-Token')
      if (!token) return { error: 'Unauthorized', status: 401 }
      return { token, tokenType: authMode === 'local-pat' ? 'PROGRAMMATIC_ACCESS_TOKEN' : 'OAUTH' }
    },
  }
}
