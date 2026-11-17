// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import type { AgentEntry } from './agent-ref.js'
import { snowflakeBase, snowflakeHeaders, type SnowflakeCredential } from './credential.js'
import {
  fetchWithTimeout,
  isUpstreamTimeoutError,
  SQL_API_FETCH_TIMEOUT_MS,
  SQL_API_STATEMENT_TIMEOUT_SEC,
} from './fetch-timeout.js'

// Snowflake Intelligence stores its agents in this fixed schema. We probe it
// (matching the Intelligence app's cascade) and also scan account-wide.
const SI_AGENTS_SCHEMA = 'SNOWFLAKE_INTELLIGENCE.AGENTS'

// Shape of the Snowflake SQL API (/api/v2/statements) success response we care
// about: column definitions under resultSetMetaData.rowType and rows in `data`
// (each row is an array of stringified cell values, positionally aligned).
interface SqlApiResult {
  resultSetMetaData?: { rowType?: { name: string }[] }
  data?: string[][]
}

/**
 * Discover the Cortex Agents the calling identity can access, RBAC-filtered.
 *
 * `SHOW AGENTS` runs under the token's own role, so Snowflake returns only agents
 * that role is granted - no separate allow-list needed. Returns [] on a
 * non-timeout failure so the route degrades gracefully; an HTTP abort
 * (`UpstreamTimeoutError`) is rethrown so the host can surface 504 instead
 * of an authoritative empty list.
 *
 * We merge the SNOWFLAKE_INTELLIGENCE.AGENTS scan with an account-wide scan rather
 * than short-circuiting on the first: an account can hold agents outside that schema
 * that a schema-only scan would hide even when the schema scan itself returns results.
 * On a typical account the Intelligence schema holds a handful of agents while the
 * account-wide scan can return many more, including agents outside that schema.
 */
const CACHE_TTL_MS = 45_000
const CACHE_MAX = 64

interface CacheEntry {
  expiresAt: number
  promise: Promise<AgentEntry[]>
}

const cache = new Map<string, CacheEntry>()
let opsSinceSweep = 0

function cacheKey(account: string, cred: SnowflakeCredential): string {
  const hash = createHash('sha256').update(cred.token).digest('hex').slice(0, 16)
  return `${account}:${cred.tokenType}:${hash}`
}

function sweep(now: number) {
  for (const [k, e] of cache) if (e.expiresAt <= now) cache.delete(k)
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value
    if (first === undefined) break
    cache.delete(first)
  }
}

/** Test helper: drop every cached listing. */
export function resetListAgentsCache(): void {
  cache.clear()
  opsSinceSweep = 0
}

export async function listAgentsForUser(
  account: string,
  cred: SnowflakeCredential,
): Promise<AgentEntry[]> {
  const key = cacheKey(account, cred)
  const now = Date.now()
  if (++opsSinceSweep >= 32) {
    opsSinceSweep = 0
    sweep(now)
  }
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now) return hit.promise

  const promise = listAgentsUncached(account, cred).then(
    (agents) => {
      if (agents.length === 0) cache.delete(key)
      return agents
    },
    (err: unknown) => {
      cache.delete(key)
      throw err
    },
  )
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, promise })
  if (cache.size > CACHE_MAX) sweep(now)
  return promise
}

async function listAgentsUncached(
  account: string,
  cred: SnowflakeCredential,
): Promise<AgentEntry[]> {
  const [scoped, wide] = await Promise.all([
    runShowAgents(account, cred, `SHOW AGENTS IN SCHEMA ${SI_AGENTS_SCHEMA}`),
    runShowAgents(account, cred, 'SHOW AGENTS IN ACCOUNT'),
  ])
  const byFqn = new Map<string, AgentEntry>()
  for (const a of [...scoped, ...wide]) byFqn.set(a.fqn.toUpperCase(), a)
  return [...byFqn.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

async function runShowAgents(
  account: string,
  cred: SnowflakeCredential,
  statement: string,
): Promise<AgentEntry[]> {
  try {
    const res = await fetchWithTimeout(`${snowflakeBase(account)}/api/v2/statements`, {
      method: 'POST',
      headers: snowflakeHeaders(cred),
      // SHOW commands need no warehouse; timeout guards against a hung session.
      body: JSON.stringify({ statement, timeout: SQL_API_STATEMENT_TIMEOUT_SEC }),
    }, SQL_API_FETCH_TIMEOUT_MS)
    if (!res.ok) return []
    const json = (await res.json()) as SqlApiResult
    return parseAgents(json)
  } catch (err) {
    if (isUpstreamTimeoutError(err)) throw err
    return []
  }
}

/** Map a SHOW AGENTS SQL-API result into AgentEntry[] by column name. */
export function parseAgents(result: SqlApiResult): AgentEntry[] {
  const cols = result.resultSetMetaData?.rowType ?? []
  const rows = result.data ?? []
  const idx = (name: string) => cols.findIndex((c) => c.name.toLowerCase() === name)
  const nameI = idx('name')
  const dbI = idx('database_name')
  const schemaI = idx('schema_name')
  const commentI = idx('comment')
  if (nameI < 0 || dbI < 0 || schemaI < 0) return []

  const agents: AgentEntry[] = []
  for (const row of rows) {
    const name = row[nameI]
    const database = row[dbI]
    const schema = row[schemaI]
    if (!name || !database || !schema) continue
    const description = commentI >= 0 ? (row[commentI] ?? '') : ''
    agents.push({
      fqn: `${database}.${schema}.${name}`,
      // No profile display-name in SHOW output; fall back to the object name.
      displayName: name,
      ...(description ? { description } : {}),
    })
  }
  return agents
}
