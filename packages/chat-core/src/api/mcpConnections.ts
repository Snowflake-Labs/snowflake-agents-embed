// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { throwFromResponse } from './apiError.js'
import { getHostAdapter } from '../host/hostAdapter.js'
import { hostFetch } from './hostFetch.js'

export interface McpConnection {
  fqn: string
  displayName: string
  /** null only while the connections fetch has not landed. */
  connected: boolean | null
}

export interface McpConnectionsResponse {
  coworkUrl: string
  servers: McpConnection[]
}

const CACHE_TTL_MS = 30_000
const connectionsCache = new Map<string, { at: number; value: McpConnectionsResponse }>()

export function invalidateMcpConnectionsCache(): void {
  connectionsCache.clear()
}

export async function fetchMcpConnections(
  snowflakeToken: string,
  agentFqn: string,
): Promise<McpConnectionsResponse> {
  const key = `${snowflakeToken}\0${agentFqn}`
  const hit = connectionsCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  const res = await hostFetch(
    snowflakeToken,
    `${getHostAdapter().baseUrl()}/api/mcp/connections?fqn=${encodeURIComponent(agentFqn)}`,
  )
  if (!res.ok) await throwFromResponse(res, 'Failed to load connectors')
  const body = await res.json() as McpConnectionsResponse
  const value: McpConnectionsResponse = {
    coworkUrl: typeof body.coworkUrl === 'string' ? body.coworkUrl : '',
    servers: Array.isArray(body.servers) ? body.servers : [],
  }
  connectionsCache.set(key, { at: Date.now(), value })
  return value
}
