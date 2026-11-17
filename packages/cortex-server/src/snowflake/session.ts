// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import { snowflakeBase, type SnowflakeCredential, type SnowflakeTokenType } from './credential.js'
import { fetchWithTimeout, SQL_API_FETCH_TIMEOUT_MS } from './fetch-timeout.js'

/**
 * A live Snowflake session (the same REST the official connectors use).
 *
 * The public SQL API (`/api/v2/statements`) is stateless: each POST is a new
 * session. SYSTEM$START_USER_OAUTH_FLOW / SYSTEM$FINISH_OAUTH_FLOW store PKCE
 * state on the session, so MCP connector OAuth has to hold one open between
 * start and finish. See https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp-connectors
 */
export interface SnowflakeSession {
  execute(sql: string): Promise<SessionQueryResult>
  close(): Promise<void>
}

export interface SessionQueryResult {
  columns: string[]
  rows: string[][]
}

interface LoginResponse {
  success?: boolean
  message?: string
  data?: {
    token?: string
    masterToken?: string
  }
}

interface QueryResponse {
  success?: boolean
  message?: string
  data?: {
    rowtype?: { name?: string }[]
    rowset?: unknown[][]
  }
}

function authenticatorFor(tokenType: SnowflakeTokenType): string {
  if (tokenType === 'PROGRAMMATIC_ACCESS_TOKEN') return 'PROGRAMMATIC_ACCESS_TOKEN'
  if (tokenType === 'KEYPAIR_JWT') return 'SNOWFLAKE_JWT'
  return 'OAUTH'
}

/** LOGIN_NAME from an External OAuth / OBO JWT `sub`; empty for a PAT. */
export function loginNameFromToken(token: string): string {
  const parts = token.split('.')
  if (parts.length !== 3) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { sub?: unknown }
    return typeof payload.sub === 'string' ? payload.sub : ''
  } catch {
    return ''
  }
}

function sessionHeaders(sessionToken: string): Record<string, string> {
  return {
    Authorization: `Snowflake Token="${sessionToken}"`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}

function cellString(value: unknown): string {
  if (value == null) return ''
  return typeof value === 'string' ? value : String(value)
}

export function parseSessionQuery(json: QueryResponse): SessionQueryResult {
  const columns = (json.data?.rowtype ?? []).map((c) => c.name ?? '')
  const rows = (json.data?.rowset ?? []).map((row) =>
    (Array.isArray(row) ? row : []).map(cellString),
  )
  return { columns, rows }
}

export async function openSnowflakeSession(
  account: string,
  cred: SnowflakeCredential,
): Promise<SnowflakeSession> {
  const base = snowflakeBase(account)
  const loginRes = await fetchWithTimeout(
    `${base}/session/v1/login-request?requestId=${randomUUID()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        data: {
          ACCOUNT_NAME: account,
          LOGIN_NAME: loginNameFromToken(cred.token),
          AUTHENTICATOR: authenticatorFor(cred.tokenType),
          TOKEN: cred.token,
          CLIENT_APP_ID: 'JavaScript',
          CLIENT_APP_VERSION: '1.15.0',
          SESSION_PARAMETERS: { CLIENT_SESSION_KEEP_ALIVE: true },
        },
      }),
    },
    SQL_API_FETCH_TIMEOUT_MS,
  )
  const loginJson = (await loginRes.json().catch(() => ({}))) as LoginResponse
  const sessionToken = loginJson.data?.token
  if (!loginRes.ok || loginJson.success === false || !sessionToken) {
    const detail = loginJson.message || `HTTP ${loginRes.status}`
    throw new Error(`Snowflake session login failed: ${detail}`)
  }

  let closed = false

  return {
    async execute(sql: string): Promise<SessionQueryResult> {
      if (closed) throw new Error('Snowflake session is closed')
      const res = await fetchWithTimeout(
        `${base}/queries/v1/query-request?requestId=${randomUUID()}`,
        {
          method: 'POST',
          headers: sessionHeaders(sessionToken),
          body: JSON.stringify({ sqlText: sql, asyncExec: false }),
        },
        SQL_API_FETCH_TIMEOUT_MS,
      )
      const json = (await res.json().catch(() => ({}))) as QueryResponse
      if (!res.ok || json.success === false) {
        throw new Error(json.message || `Snowflake query failed: HTTP ${res.status}`)
      }
      return parseSessionQuery(json)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await fetchWithTimeout(
        `${base}/session/v1/logout-request`,
        { method: 'POST', headers: sessionHeaders(sessionToken) },
        5_000,
      ).catch(() => {})
    },
  }
}
