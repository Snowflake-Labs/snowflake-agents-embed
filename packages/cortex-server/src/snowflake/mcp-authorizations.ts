// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { snowflakeBase, snowflakeHeaders, type SnowflakeCredential } from './credential.js'
import {
  fetchWithTimeout,
  isUpstreamTimeoutError,
  SQL_API_FETCH_TIMEOUT_MS,
  SQL_API_STATEMENT_TIMEOUT_SEC,
} from './fetch-timeout.js'
import { assertMcpServerFqn } from './mcp-oauth.js'

const UNQUOTED_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/

interface SqlApiResult {
  resultSetMetaData?: { rowType?: { name: string }[] }
  data?: string[][]
}

export interface McpServerRef {
  fqn: string
  displayName: string
}

export interface McpServerConnection extends McpServerRef {
  connected: boolean
}

type McpServerKind =
  | { kind: 'external'; integration: string }
  | { kind: 'native' }
  | { kind: 'unknown' }

/**
 * Native CoWork's per-user MCP check: DESCRIBE each external MCP server for its
 * API integration, then SYSTEM$GET_USER_INTEGRATION_AUTHORIZATIONS. `connected`
 * is `status === "CONNECTED"` (same as snapps `useGetMcpUserAuthorizations`).
 * A failed DESCRIBE or authorizations call leaves that server disconnected so
 * the menu still lists it. Snowflake-managed (native) MCP servers are omitted
 * from the response, matching native CoWork's `serverType: ['external']`
 * connector surfaces — they have no per-user OAuth and are not shown there.
 */
export async function resolveMcpConnectionStatus(
  account: string,
  cred: SnowflakeCredential,
  servers: McpServerRef[],
): Promise<McpServerConnection[]> {
  if (servers.length === 0) return []

  const classified = await Promise.all(
    servers.map(async (s) => ({ fqn: s.fqn, kind: await classifyMcpServer(account, cred, s.fqn) })),
  )

  const names = [...new Set(
    classified
      .map((c) => (c.kind.kind === 'external' ? c.kind.integration : null))
      .filter((n): n is string => !!n),
  )]
  const authorized = names.length > 0
    ? await getUserIntegrationAuthorizations(account, cred, names)
    : new Map<string, boolean>()

  return servers.flatMap((s) => {
    const kind = classified.find((c) => c.fqn === s.fqn)?.kind ?? { kind: 'unknown' as const }
    if (kind.kind === 'native') return []
    if (kind.kind === 'external') {
      return [{ ...s, connected: authorized.get(kind.integration.toUpperCase()) === true }]
    }
    return [{ ...s, connected: false }]
  })
}

export function authorizationsStatement(integrationNames: string[]): string {
  const safe = integrationNames.filter((n) => UNQUOTED_IDENT.test(n))
  // JSON array of unquoted idents never contains `'`, so a standard string
  // literal is safe. `$tag$["…"]$tag$` is not: Snowflake parses `$tag` as a
  // session variable and `[` as a subscript (SQL compilation 001003).
  return `SELECT SYSTEM$GET_USER_INTEGRATION_AUTHORIZATIONS('${JSON.stringify(safe)}')`
}

/** Parse the JSON array SYSTEM$GET_USER_INTEGRATION_AUTHORIZATIONS returns. */
export function parseUserIntegrationAuthorizations(json: string): Map<string, boolean> {
  const map = new Map<string, boolean>()
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return map }
  if (!Array.isArray(parsed)) return map
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue
    const rec = row as { integrationName?: unknown; status?: unknown }
    const name = typeof rec.integrationName === 'string' ? rec.integrationName : ''
    const status = typeof rec.status === 'string' ? rec.status : ''
    if (!name) continue
    map.set(name.toUpperCase(), status.toUpperCase() === 'CONNECTED')
  }
  return map
}

/** Read the API integration name from a DESCRIBE EXTERNAL MCP SERVER SQL-API result. */
export function integrationFromDescribeResult(result: SqlApiResult): string | null {
  const cols = result.resultSetMetaData?.rowType ?? []
  const row = result.data?.[0]
  if (!row) return null
  const idx = cols.findIndex((c) => {
    const n = (c.name ?? '').toLowerCase()
    return n === 'integration' || n === 'api_integration'
  })
  const value = (idx >= 0 ? row[idx] : row[0]) ?? ''
  return value && UNQUOTED_IDENT.test(value) ? value : null
}

/**
 * Determine whether an MCP server FQN is a Snowflake-managed (native) server or
 * a remote-connector (external) one - they are distinct object types with
 * distinct DESCRIBE statements (see snowflake/superstore-360/README.md
 * gotcha #6: `Agent Server '<name>' does not exist or not authorized` is what
 * the wrong DESCRIBE variant returns, not a real missing-object error).
 * Tries EXTERNAL first: every server in production today is external, so this
 * keeps their cost and latency unchanged. Only a server that fails as EXTERNAL
 * pays the extra round trip to check NATIVE.
 */
async function classifyMcpServer(
  account: string,
  cred: SnowflakeCredential,
  fqn: string,
): Promise<McpServerKind> {
  try {
    assertMcpServerFqn(fqn)
  } catch {
    return { kind: 'unknown' }
  }
  const external = await runStatement(
    account,
    cred,
    `DESCRIBE EXTERNAL MCP SERVER IDENTIFIER('${fqn}')`,
  )
  const integration = external ? integrationFromDescribeResult(external) : null
  if (integration) return { kind: 'external', integration }

  const native = await runStatement(
    account,
    cred,
    `DESCRIBE MCP SERVER IDENTIFIER('${fqn}')`,
  )
  return native ? { kind: 'native' } : { kind: 'unknown' }
}

async function getUserIntegrationAuthorizations(
  account: string,
  cred: SnowflakeCredential,
  names: string[],
): Promise<Map<string, boolean>> {
  const result = await runStatement(account, cred, authorizationsStatement(names))
  return result ? parseUserIntegrationAuthorizations(firstCell(result)) : new Map()
}

function firstCell(result: SqlApiResult): string {
  return result.data?.[0]?.[0] ?? ''
}

async function runStatement(
  account: string,
  cred: SnowflakeCredential,
  statement: string,
): Promise<SqlApiResult | null> {
  try {
    const res = await fetchWithTimeout(`${snowflakeBase(account)}/api/v2/statements`, {
      method: 'POST',
      headers: snowflakeHeaders(cred),
      body: JSON.stringify({
        statement,
        timeout: SQL_API_STATEMENT_TIMEOUT_SEC,
      }),
    }, SQL_API_FETCH_TIMEOUT_MS)
    if (!res.ok) return null
    return (await res.json()) as SqlApiResult
  } catch (err) {
    if (isUpstreamTimeoutError(err)) throw err
    return null
  }
}
