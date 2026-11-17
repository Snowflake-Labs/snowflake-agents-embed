// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { throwFromResponse } from './apiError.js'
import { getHostAdapter } from '../host/hostAdapter.js'
import { hostFetch } from './hostFetch.js'

export { mcpServerFqnFromWarning } from '../lib/turn-warning.js'

export async function startMcpOAuth(
  snowflakeToken: string,
  mcpServer: string,
): Promise<{ authorizationUrl: string; flowId: string }> {
  const res = await hostFetch(snowflakeToken, `${getHostAdapter().baseUrl()}/api/mcp/oauth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpServer }),
  })
  if (!res.ok) await throwFromResponse(res, 'Failed to start connector sign-in')
  const body = await res.json() as { authorizationUrl?: unknown; flowId?: unknown }
  if (typeof body.authorizationUrl !== 'string' || typeof body.flowId !== 'string') {
    throw new Error('Failed to start connector sign-in')
  }
  return { authorizationUrl: body.authorizationUrl, flowId: body.flowId }
}

export async function finishMcpOAuth(
  snowflakeToken: string,
  flowId: string,
  redirect: string,
): Promise<void> {
  const res = await hostFetch(snowflakeToken, `${getHostAdapter().baseUrl()}/api/mcp/oauth/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flowId, redirect }),
  })
  if (!res.ok) await throwFromResponse(res, 'Failed to finish connector sign-in')
}

export function openMcpAuthorizationUrl(url: string): void {
  if (!url.startsWith('https://')) return
  const adapter = getHostAdapter()
  if (adapter.openExternalUrl) {
    adapter.openExternalUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
