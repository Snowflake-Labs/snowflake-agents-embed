// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { throwFromResponse } from './apiError.js'
import { getHostAdapter } from '../host/hostAdapter.js'
import { hostFetch } from './hostFetch.js'

export interface AgentEntry {
  fqn: string
  displayName: string
  description?: string
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
  mcpServers?: McpServerInfo[]
}

export async function fetchAgents(snowflakeToken: string): Promise<AgentEntry[]> {
  const res = await hostFetch(snowflakeToken, `${getHostAdapter().baseUrl()}/api/agents`)
  if (!res.ok) await throwFromResponse(res, 'Failed to load agents')
  return res.json()
}

// Per-agent starter questions from the agent spec (DESCRIBE AGENT server-side).
// Returns [] on any failure so the caller can fall back to default prompts.
export async function fetchSampleQuestions(snowflakeToken: string, fqn: string): Promise<string[]> {
  try {
    const url = `${getHostAdapter().baseUrl()}/api/agents/sample-questions?fqn=${encodeURIComponent(fqn)}`
    const res = await hostFetch(snowflakeToken, url)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.questions) ? data.questions : []
  } catch {
    return []
  }
}

// Fuller agent surface (orchestration model, instructions, tools, data sources) for the
// RightPanel's "Agent details" view. Returns null on any failure so the caller can skip
// opening the panel rather than show something half-populated.
export async function fetchAgentDetails(snowflakeToken: string, fqn: string): Promise<AgentDetails | null> {
  try {
    const url = `${getHostAdapter().baseUrl()}/api/agents/details?fqn=${encodeURIComponent(fqn)}`
    const res = await hostFetch(snowflakeToken, url)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// Keyed on fqn only, not the token - the details don't vary by user, only the token does.
// ComposerMenu's Skills submenu and ChatControls' "Agent details" button both fetch the same
// agent's details independently; without a shared cache, opening the submenu right after (or
// during) the details fetch re-requests it and re-renders the empty state while in flight -
// the "flashes 'No skills configured'" bug. Caches the in-flight promise (not just the
// resolved value) so concurrent openers share one request; a failed fetch (null) is not
// cached, so a transient error doesn't permanently stick.
const detailsCache = new Map<string, Promise<AgentDetails | null>>()

export function fetchAgentDetailsCached(snowflakeToken: string, fqn: string): Promise<AgentDetails | null> {
  const cached = detailsCache.get(fqn)
  if (cached) return cached
  const promise = fetchAgentDetails(snowflakeToken, fqn).then((details) => {
    if (details === null) detailsCache.delete(fqn)
    return details
  })
  detailsCache.set(fqn, promise)
  return promise
}

export function clearAgentDetailsCache(): void {
  detailsCache.clear()
}

// Same in-flight-promise-cache pattern as fetchAgentDetailsCached above. EmptyState
// paints starters only after this resolves, so sharing the in-flight promise keeps an
// agent switch from firing a second DESCRIBE AGENT.
const sampleQuestionsCache = new Map<string, Promise<string[]>>()

export function fetchSampleQuestionsCached(snowflakeToken: string, fqn: string): Promise<string[]> {
  const cached = sampleQuestionsCache.get(fqn)
  if (cached) return cached
  const promise = fetchSampleQuestions(snowflakeToken, fqn).then((questions) => {
    if (questions.length === 0) sampleQuestionsCache.delete(fqn)
    return questions
  })
  sampleQuestionsCache.set(fqn, promise)
  return promise
}

export function clearSampleQuestionsCache(): void {
  sampleQuestionsCache.clear()
}
