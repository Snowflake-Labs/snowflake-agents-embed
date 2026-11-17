// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseSampleQuestions, getSampleQuestions, parseAgentDetails, getAgentDetails } from './agent-details.js'
import type { SnowflakeCredential } from './credential.js'
import { SQL_API_STATEMENT_TIMEOUT_SEC, UpstreamTimeoutError } from './fetch-timeout.js'

const OAUTH: SnowflakeCredential = { token: 'tok', tokenType: 'OAUTH' }
const PAT: SnowflakeCredential = { token: 'tok', tokenType: 'PROGRAMMATIC_ACCESS_TOKEN' }

// DESCRIBE AGENT returns the agent spec as a JSON string in one of its cells.
// Snowflake Intelligence stores sample questions under instructions.sample_questions
// as [{ question }]. We tolerate that and simpler shapes.
function describeResult(specObj: unknown) {
  return {
    resultSetMetaData: { rowType: [{ name: 'property' }, { name: 'value' }] },
    data: [
      ['name', 'MY_AGENT'],
      ['agent_spec', JSON.stringify(specObj)],
    ],
  }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('parseSampleQuestions', () => {
  it('extracts questions from instructions.sample_questions [{question}]', () => {
    const spec = {
      models: { orchestration: 'auto' },
      instructions: {
        response: 'Be helpful',
        sample_questions: [
          { question: 'What are my top 10 customers by revenue?' },
          { question: "Summarize last month's sales." },
        ],
      },
    }
    expect(parseSampleQuestions(describeResult(spec))).toEqual([
      'What are my top 10 customers by revenue?',
      "Summarize last month's sales.",
    ])
  })

  it('tolerates a bare-string sample_questions array', () => {
    expect(parseSampleQuestions(describeResult({ sample_questions: ['Q1', 'Q2'] }))).toEqual(['Q1', 'Q2'])
  })

  it('finds sample_questions however deeply nested', () => {
    const spec = { spec: { instructions: { sample_questions: [{ question: 'Deep Q' }] } } }
    expect(parseSampleQuestions(describeResult(spec))).toEqual(['Deep Q'])
  })

  it('returns [] when there are no sample questions', () => {
    expect(parseSampleQuestions(describeResult({ instructions: { response: 'x' } }))).toEqual([])
    expect(parseSampleQuestions({})).toEqual([])
  })

  it('ignores non-JSON cells', () => {
    const result = { resultSetMetaData: { rowType: [{ name: 'v' }] }, data: [['just text'], ['2026-01-01']] }
    expect(parseSampleQuestions(result)).toEqual([])
  })
})

describe('getSampleQuestions', () => {
  it('runs DESCRIBE AGENT with IDENTIFIER and credential-derived headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(describeResult({ instructions: { sample_questions: [{ question: 'Q' }] } })),
      { status: 200 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const questions = await getSampleQuestions('acct', OAUTH, 'DB.SCH.AG')
    expect(questions).toEqual(['Q'])
    const [, opts] = fetchMock.mock.calls[0]
    expect(JSON.parse(opts.body).statement).toBe("DESCRIBE AGENT IDENTIFIER('DB.SCH.AG')")
    expect(JSON.parse(opts.body).timeout).toBe(SQL_API_STATEMENT_TIMEOUT_SEC)
    expect(opts.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
    })
  })

  it('sends the PAT token type when given a PAT credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(describeResult({})), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await getSampleQuestions('acct', PAT, 'DB.SCH.AG')
    expect(fetchMock.mock.calls[0][1].headers['X-Snowflake-Authorization-Token-Type'])
      .toBe('PROGRAMMATIC_ACCESS_TOKEN')
  })

  it('returns [] on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })))
    expect(await getSampleQuestions('acct', OAUTH, 'DB.SCH.AG')).toEqual([])
  })

  it('rethrows an upstream timeout instead of collapsing it to []', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(
      (_url: string | URL, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ))
    const pending = getSampleQuestions('acct', OAUTH, 'DB.SCH.AG')
    const expectation = expect(pending).rejects.toBeInstanceOf(UpstreamTimeoutError)
    await vi.advanceTimersByTimeAsync(40_000)
    await expectation
    vi.useRealTimers()
  })

  it('refuses a FQN containing a quote (injection guard) without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await getSampleQuestions('acct', OAUTH, "DB.SCH.A'; DROP")).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a FQN containing a backslash without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await getSampleQuestions('acct', OAUTH, 'DB.SCH.A\\x')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

const FULL_SPEC = {
  models: { orchestration: 'claude-sonnet-4-5' },
  orchestration: { budget: { seconds: 300, tokens: 16000 } },
  instructions: {
    response: 'Be friendly and concise.',
    orchestration: 'Prefer the semantic model for sales questions.',
    sample_questions: [{ question: 'Top region by profit?' }],
  },
  tools: [
    { tool_spec: { type: 'cortex_analyst_text_to_sql', name: 'Sales_Analyst', description: 'Analyze sales data' } },
  ],
  tool_resources: {
    Sales_Analyst: {
      execution_environment: { type: 'warehouse', warehouse: 'XSMALL' },
      semantic_model_file: '@DB.SCH.STAGE/model.yaml',
    },
  },
  skills: [
    { name: 'review_analyst', source: { type: 'STAGE', path: '@DEMO_DB.AGENTS.SKILLS/review_analyst' } },
  ],
}

describe('parseAgentDetails', () => {
  it('extracts orchestration model, instructions, tools, data sources, and skills', () => {
    const details = parseAgentDetails(describeResult(FULL_SPEC))
    expect(details).toEqual({
      orchestrationModel: 'claude-sonnet-4-5',
      responseInstructions: 'Be friendly and concise.',
      orchestrationInstructions: 'Prefer the semantic model for sales questions.',
      sampleQuestions: ['Top region by profit?'],
      tools: [{ name: 'Sales_Analyst', type: 'cortex_analyst_text_to_sql', description: 'Analyze sales data' }],
      dataSources: [{ toolName: 'Sales_Analyst', warehouse: 'XSMALL', semanticModelFile: '@DB.SCH.STAGE/model.yaml' }],
      skills: [{ name: 'review_analyst', stagePath: '@DEMO_DB.AGENTS.SKILLS/review_analyst' }],
      mcpServers: [],
    })
  })

  it('extracts mcp_servers from server_spec.name', () => {
    const details = parseAgentDetails(describeResult({
      ...FULL_SPEC,
      mcp_servers: [{ server_spec: { name: 'DEMO_DB.AGENTS.JIRA_MCP' } }],
    }))
    expect(details.mcpServers).toEqual([
      { fqn: 'DEMO_DB.AGENTS.JIRA_MCP', displayName: 'JIRA' },
    ])
  })

  it('returns an empty-but-valid shape when no spec is found', () => {
    expect(parseAgentDetails({ data: [['just text']] })).toEqual({ sampleQuestions: [], tools: [], dataSources: [], skills: [], mcpServers: [] })
    expect(parseAgentDetails({})).toEqual({ sampleQuestions: [], tools: [], dataSources: [], skills: [], mcpServers: [] })
  })

  it('omits fields absent from the spec rather than throwing', () => {
    const details = parseAgentDetails(describeResult({ tools: [] }))
    expect(details.orchestrationModel).toBeUndefined()
    expect(details.tools).toEqual([])
    expect(details.dataSources).toEqual([])
  })
})

describe('getAgentDetails', () => {
  it('runs DESCRIBE AGENT and returns the parsed details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(describeResult(FULL_SPEC)), { status: 200 })))
    const details = await getAgentDetails('acct', OAUTH, 'DB.SCH.AG')
    expect(details?.orchestrationModel).toBe('claude-sonnet-4-5')
    expect(details?.tools).toHaveLength(1)
  })

  it('returns null on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })))
    expect(await getAgentDetails('acct', OAUTH, 'DB.SCH.AG')).toBeNull()
  })

  it('refuses a FQN containing a quote without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await getAgentDetails('acct', OAUTH, "DB.SCH.A'; DROP")).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
