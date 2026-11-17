// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { parseAgentRef } from './agent-ref.js'
import { mcpDisplayName } from './connectors-url.js'
import { snowflakeBase, snowflakeHeaders, type SnowflakeCredential } from './credential.js'
import {
  fetchWithTimeout,
  isUpstreamTimeoutError,
  SQL_API_FETCH_TIMEOUT_MS,
  SQL_API_STATEMENT_TIMEOUT_SEC,
} from './fetch-timeout.js'

// Shape of the Snowflake SQL API (/api/v2/statements) result we read.
interface SqlApiResult {
  resultSetMetaData?: { rowType?: { name: string }[] }
  data?: string[][]
}

// Characters that would let an FQN break out of the single-quoted SQL literal
// in the DESCRIBE AGENT statement below: a quote or a backslash escape.
// Built with fromCharCode so the literal quote and backslash characters do
// not need escaping in this source file.
const UNSAFE_IN_SQL_LITERAL = [String.fromCharCode(39), String.fromCharCode(92)]

async function describeAgent(
  account: string,
  cred: SnowflakeCredential,
  fqn: string,
): Promise<SqlApiResult | null> {
  if (UNSAFE_IN_SQL_LITERAL.some((ch) => fqn.includes(ch))) return null
  parseAgentRef(fqn)
  try {
    const res = await fetchWithTimeout(`${snowflakeBase(account)}/api/v2/statements`, {
      method: 'POST',
      headers: snowflakeHeaders(cred),
      body: JSON.stringify({
        statement: `DESCRIBE AGENT IDENTIFIER('${fqn}')`,
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

/**
 * Fetch an agent's sample ("starter") questions via DESCRIBE AGENT, RBAC-filtered
 * by the forwarded token. Snowflake Intelligence stores these in the agent spec
 * under `instructions.sample_questions` (each `{ question }`). DESCRIBE returns
 * the spec as text in one of its columns; we scan the result for it and pull the
 * questions out wherever they live. Returns [] on any failure so the UI cleanly
 * falls back to its own default prompts.
 *
 * Verified against DESCRIBE AGENT on the validation account: the spec lands in
 * the `agent_spec` column as a JSON string with sample_questions as
 * [{"question": "..."}]. See packages/relay/test/fixtures/describe-agent.json.
 */
export async function getSampleQuestions(
  account: string,
  cred: SnowflakeCredential,
  fqn: string,
): Promise<string[]> {
  const json = await describeAgent(account, cred, fqn)
  return json ? parseSampleQuestions(json) : []
}

/**
 * Fetch the fuller agent surface (orchestration model, response/orchestration
 * instructions, tool list, data sources) via the same DESCRIBE AGENT call.
 * Returns null on any failure - RBAC failure, network error, or a response that
 * doesn't contain a recognizable agent spec - so the caller can omit the panel
 * entirely rather than render something half-populated.
 */
export async function getAgentDetails(
  account: string,
  cred: SnowflakeCredential,
  fqn: string,
): Promise<AgentDetails | null> {
  const json = await describeAgent(account, cred, fqn)
  return json ? parseAgentDetails(json) : null
}

/**
 * Extract sample questions from a DESCRIBE AGENT SQL-API result. The agent spec is
 * a JSON string in one of the cells; we parse each cell that looks like JSON and
 * recursively find a `sample_questions` array (tolerating both string items and
 * `{ question }` objects, and wherever it's nested in the spec).
 */
export function parseSampleQuestions(result: SqlApiResult): string[] {
  for (const row of result.data ?? []) {
    for (const cell of row) {
      if (typeof cell !== 'string') continue
      const trimmed = cell.trim()
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue
      let parsed: unknown
      try { parsed = JSON.parse(trimmed) } catch { continue }
      const found = findSampleQuestions(parsed)
      if (found.length) return found
    }
  }
  return []
}

// Depth-first search for a `sample_questions` array anywhere in the spec object.
function findSampleQuestions(node: unknown): string[] {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findSampleQuestions(item)
      if (found.length) return found
    }
    return []
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const [key, value] of Object.entries(obj)) {
      if (key.toLowerCase() === 'sample_questions' && Array.isArray(value)) {
        const questions = value
          .map((q) => (typeof q === 'string' ? q : (q as Record<string, unknown>)?.question))
          .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        if (questions.length) return questions
      }
      const found = findSampleQuestions(value)
      if (found.length) return found
    }
  }
  return []
}

export interface AgentToolInfo {
  name?: string
  type?: string
  description?: string
}

export interface AgentDataSource {
  toolName: string
  warehouse?: string
  semanticModelFile?: string
}

export interface AgentSkillInfo {
  name: string
  stagePath: string
}

export interface McpServerInfo {
  fqn: string
  displayName: string
}

export interface AgentDetails {
  orchestrationModel?: string
  responseInstructions?: string
  orchestrationInstructions?: string
  sampleQuestions: string[]
  tools: AgentToolInfo[]
  dataSources: AgentDataSource[]
  skills: AgentSkillInfo[]
  mcpServers: McpServerInfo[]
}

// The agent_spec cell parses into an object with `models`/`orchestration`/`instructions`/
// `tools` as top-level siblings - unlike sample_questions, which can be nested arbitrarily
// deep under `instructions`, the spec root itself is always the first JSON object found that
// has at least one of those keys.
function findAgentSpec(result: SqlApiResult): Record<string, unknown> | null {
  for (const row of result.data ?? []) {
    for (const cell of row) {
      if (typeof cell !== 'string') continue
      const trimmed = cell.trim()
      if (!trimmed.startsWith('{')) continue
      let parsed: unknown
      try { parsed = JSON.parse(trimmed) } catch { continue }
      if (
        parsed && typeof parsed === 'object' &&
        ('models' in parsed || 'orchestration' in parsed || 'instructions' in parsed
          || 'tools' in parsed || 'skills' in parsed || 'mcp_servers' in parsed)
      ) {
        return parsed as Record<string, unknown>
      }
    }
  }
  return null
}

/**
 * Parse the fuller agent surface out of a DESCRIBE AGENT result. Everything is
 * best-effort: any field absent from the spec (or of an unexpected type) is simply
 * omitted rather than throwing, since the spec shape is Snowflake Intelligence's
 * internal storage format, not a documented contract.
 */
export function parseAgentDetails(result: SqlApiResult): AgentDetails {
  const empty: AgentDetails = { sampleQuestions: [], tools: [], dataSources: [], skills: [], mcpServers: [] }
  const spec = findAgentSpec(result)
  if (!spec) return empty

  const models = asRecord(spec.models)
  const instructions = asRecord(spec.instructions)
  const toolsRaw = Array.isArray(spec.tools) ? spec.tools : []
  const toolResources = asRecord(spec.tool_resources)
  const skillsRaw = Array.isArray(spec.skills) ? spec.skills : []

  const tools: AgentToolInfo[] = toolsRaw.map((t) => {
    const toolSpec = asRecord(asRecord(t)?.tool_spec)
    return {
      name: asString(toolSpec?.name),
      type: asString(toolSpec?.type),
      description: asString(toolSpec?.description),
    }
  })

  const dataSources: AgentDataSource[] = Object.entries(toolResources ?? {}).map(([toolName, res]) => {
    const r = asRecord(res)
    const env = asRecord(r?.execution_environment)
    return {
      toolName,
      warehouse: asString(env?.warehouse),
      semanticModelFile: asString(r?.semantic_model_file),
    }
  })

  const sampleQuestionsRaw = instructions?.sample_questions
  const sampleQuestions = Array.isArray(sampleQuestionsRaw)
    ? sampleQuestionsRaw
        .map((q) => (typeof q === 'string' ? q : asRecord(q)?.question))
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    : []

  // Skills are a top-level spec key, not a tool - {name, source: {type, path}}. No
  // description here; that lives in the skill's own SKILL.md frontmatter, but we don't
  // fetch it - the agent resolves and runs the skill server-side itself once it judges
  // a request relevant, so the client only ever needs the name (see skillPreamble.ts in
  // packages/chat-core).
  const skills: AgentSkillInfo[] = skillsRaw
    .map((s) => {
      const skill = asRecord(s)
      const name = asString(skill?.name)
      const stagePath = asString(asRecord(skill?.source)?.path)
      return name && stagePath ? { name, stagePath } : null
    })
    .filter((s): s is AgentSkillInfo => s !== null)

  const mcpRaw = Array.isArray(spec.mcp_servers) ? spec.mcp_servers : []
  const mcpServers: McpServerInfo[] = mcpRaw
    .map((entry) => {
      const name = asString(asRecord(asRecord(entry)?.server_spec)?.name)
        ?? asString(asRecord(entry)?.name)
        ?? (typeof entry === 'string' ? entry : undefined)
      if (!name || !name.includes('.')) return null
      try { parseAgentRef(name) } catch { return null }
      return { fqn: name, displayName: mcpDisplayName(name) }
    })
    .filter((s): s is McpServerInfo => s !== null)

  return {
    orchestrationModel: asString(models?.orchestration),
    responseInstructions: asString(instructions?.response),
    orchestrationInstructions: asString(instructions?.orchestration),
    sampleQuestions,
    tools,
    dataSources,
    skills,
    mcpServers,
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
