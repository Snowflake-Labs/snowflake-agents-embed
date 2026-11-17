// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto'
import { parseAgentRef } from './agent-ref.js'
import { assertIdentifier } from './path-id.js'
import type { SnowflakeCredential } from './credential.js'
import { isUpstreamTimeoutError } from './fetch-timeout.js'
import { openSnowflakeSession, type SnowflakeSession, type SessionQueryResult } from './session.js'

// Characters that would let an FQN break out of IDENTIFIER('...').
const UNSAFE_IN_SQL_LITERAL = [String.fromCharCode(39), String.fromCharCode(92)]


const FLOW_TTL_MS = 10 * 60 * 1000
const FLOW_MAX = 32

export class McpOAuthError extends Error {
  readonly status: 400 | 403 | 404 | 502 | 504
  constructor(message: string, status: 400 | 403 | 404 | 502 | 504) {
    super(message)
    this.name = 'McpOAuthError'
    this.status = status
  }
}

interface PendingFlow {
  tokenHash: string
  session: SnowflakeSession
  expiresAt: number
}

const flows = new Map<string, PendingFlow>()

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function sweep(now: number): void {
  for (const [id, flow] of flows) {
    if (flow.expiresAt <= now) {
      flows.delete(id)
      void flow.session.close()
    }
  }
  while (flows.size > FLOW_MAX) {
    const oldest = flows.keys().next().value
    if (oldest === undefined) break
    const flow = flows.get(oldest)
    flows.delete(oldest)
    if (flow) void flow.session.close()
  }
}

/** Test helper: drop every held OAuth session. */
export async function resetMcpOAuthFlows(): Promise<void> {
  const pending = [...flows.values()]
  flows.clear()
  await Promise.all(pending.map((f) => f.session.close()))
}

/**
 * Dollar-quote a value for a Snowflake string literal so caller-supplied
 * redirect query strings cannot break out of SYSTEM$FINISH_OAUTH_FLOW(...).
 */
export function dollarQuote(value: string): string {
  let tag = 'oauth'
  while (value.includes(`$${tag}$`)) tag += 'x'
  return `$${tag}$${value}$${tag}$`
}

export function assertMcpServerFqn(fqn: string): string {
  const trimmed = fqn.trim()
  if (UNSAFE_IN_SQL_LITERAL.some((ch) => trimmed.includes(ch))) {
    throw new McpOAuthError('Invalid MCP server name.', 400)
  }
  try {
    parseAgentRef(trimmed)
  } catch (err) {
    if (err instanceof McpOAuthError) throw err
    throw new McpOAuthError('Invalid MCP server name.', 400)
  }
  return trimmed
}

function columnIndex(result: SessionQueryResult, name: string): number {
  return result.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase())
}

function firstCell(result: SessionQueryResult): string {
  return result.rows[0]?.[0] ?? ''
}

function integrationFromDescribe(result: SessionQueryResult): string {
  const idx = columnIndex(result, 'integration')
  const value = idx >= 0 ? (result.rows[0]?.[idx] ?? '') : firstCell(result)
  try {
    return assertIdentifier(value)
  } catch {
    throw new McpOAuthError('That MCP server could not be found.', 404)
  }
}

function authorizationUrlFromStart(result: SessionQueryResult): string {
  const url = firstCell(result).trim()
  if (!url.startsWith('https://')) {
    throw new McpOAuthError('Could not start the connector sign-in.', 502)
  }
  return url
}

export function extractOAuthQueryString(redirect: string): string {
  const trimmed = redirect.trim()
  if (!trimmed) throw new McpOAuthError('Paste the URL from the sign-in page.', 400)
  try {
    const url = new URL(trimmed)
    const qs = url.search.startsWith('?') ? url.search.slice(1) : url.search
    if (!qs) throw new McpOAuthError('Paste the URL from the sign-in page.', 400)
    return qs
  } catch (err) {
    if (err instanceof McpOAuthError) throw err
    return trimmed.startsWith('?') ? trimmed.slice(1) : trimmed
  }
}

export async function startMcpUserOAuth(
  account: string,
  cred: SnowflakeCredential,
  mcpServer: string,
): Promise<{ authorizationUrl: string; flowId: string }> {
  const fqn = assertMcpServerFqn(mcpServer)
  sweep(Date.now())

  let session: SnowflakeSession
  try {
    session = await openSnowflakeSession(account, cred)
  } catch (err) {
    if (isUpstreamTimeoutError(err)) throw new McpOAuthError('The upstream service timed out.', 504)
    throw new McpOAuthError('Could not start the connector sign-in.', 502)
  }

  try {
    const described = await session.execute(
      `DESCRIBE EXTERNAL MCP SERVER IDENTIFIER('${fqn}')`,
    )
    const integration = integrationFromDescribe(described)
    const started = await session.execute(
      `SELECT SYSTEM$START_USER_OAUTH_FLOW(${dollarQuote(integration)})`,
    )
    const authorizationUrl = authorizationUrlFromStart(started)
    const flowId = randomUUID()
    flows.set(flowId, {
      tokenHash: tokenHash(cred.token),
      session,
      expiresAt: Date.now() + FLOW_TTL_MS,
    })
    sweep(Date.now())
    return { authorizationUrl, flowId }
  } catch (err) {
    await session.close()
    if (err instanceof McpOAuthError) throw err
    if (isUpstreamTimeoutError(err)) throw new McpOAuthError('The upstream service timed out.', 504)
    throw new McpOAuthError('Could not start the connector sign-in.', 502)
  }
}

export async function finishMcpUserOAuth(
  cred: SnowflakeCredential,
  flowId: string,
  redirect: string,
): Promise<void> {
  sweep(Date.now())
  if (!flowId.trim()) throw new McpOAuthError('This sign-in expired. Click Connect again.', 404)
  const flow = flows.get(flowId)
  if (!flow || flow.expiresAt <= Date.now()) {
    if (flow) {
      flows.delete(flowId)
      void flow.session.close()
    }
    throw new McpOAuthError('This sign-in expired. Click Connect again.', 404)
  }
  if (flow.tokenHash !== tokenHash(cred.token)) {
    throw new McpOAuthError('This sign-in expired. Click Connect again.', 403)
  }
  const queryString = extractOAuthQueryString(redirect)
  try {
    await flow.session.execute(
      `SELECT SYSTEM$FINISH_OAUTH_FLOW(${dollarQuote(queryString)})`,
    )
  } catch (err) {
    if (err instanceof McpOAuthError) throw err
    if (isUpstreamTimeoutError(err)) throw new McpOAuthError('The upstream service timed out.', 504)
    throw new McpOAuthError('Could not finish the connector sign-in. Check the pasted URL and try again.', 502)
  }
  flows.delete(flowId)
  await flow.session.close()
}
