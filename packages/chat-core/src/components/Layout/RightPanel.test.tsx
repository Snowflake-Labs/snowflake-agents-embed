// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RightPanel } from './RightPanel'
import { setHostAdapter, resetHostAdapter, type HostAdapter } from '../../host/hostAdapter'
import { invalidateMcpConnectionsCache } from '../../api/mcpConnections'

const fakeAdapter: HostAdapter = {
  baseUrl: () => '',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  setHostAdapter(fakeAdapter)
  invalidateMcpConnectionsCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetHostAdapter()
  invalidateMcpConnectionsCache()
})

describe('RightPanel', () => {
  it('renders a table artifact under the "Table" title', () => {
    render(
      <RightPanel
        content={{ kind: 'artifact', artifact: { id: 'a1', type: 'table', rowType: [{ name: 'REGION', type: 'text' }], data: [['Central']] } }}
        snowflakeToken="tok"
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('Table')).toBeTruthy()
    expect(screen.getByText('REGION')).toBeTruthy()
  })

  it('renders a chart artifact under the "Chart" title', () => {
    render(
      <RightPanel
        content={{ kind: 'artifact', artifact: { id: 'a1', type: 'chart', spec: { mark: 'bar' } } }}
        snowflakeToken="tok"
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('Chart')).toBeTruthy()
  })

  it('renders a map artifact under the "Map" title', () => {
    render(
      <RightPanel
        content={{
          kind: 'artifact',
          artifact: {
            id: 'a1', type: 'map',
            spec: { version: 1, title: 'Stores', layer: { type: 'latlon', encoding: {} }, data: { values: [] } },
          },
        }}
        snowflakeToken="tok"
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('Map')).toBeTruthy()
    expect(screen.getByText('Stores')).toBeTruthy()
  })

  it('renders a citations list under the "Sources" title', () => {
    render(
      <RightPanel
        content={{ kind: 'citations', citations: [{ index: 1, docTitle: 'Doc A', url: 'https://a' }, { index: 2, docTitle: 'Doc B' }] }}
        snowflakeToken="tok"
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('Sources')).toBeTruthy()
    expect(screen.getByText('Doc A')).toBeTruthy()
    expect(screen.getByText('Doc B')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open source ↗' })).toBeTruthy()
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    render(
      <RightPanel content={{ kind: 'citations', citations: [] }} snowflakeToken="tok" onClose={onClose} />,
    )
    fireEvent.click(screen.getByTitle('Close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows no "Load full results" button when the table is not truncated', () => {
    render(
      <RightPanel
        content={{ kind: 'artifact', artifact: { id: 'a1', type: 'table', rowType: [{ name: 'REGION', type: 'text' }], data: [['Central']], numRows: 1, queryId: 'q1' } }}
        snowflakeToken="tok"
        onClose={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Load full results' })).toBeNull()
  })

  it('fetches and renders the full result set when "Load full results" is clicked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [['Central', 100], ['East', 200]] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(
      <RightPanel
        content={{
          kind: 'artifact',
          artifact: {
            id: 'a1', type: 'table',
            rowType: [{ name: 'REGION', type: 'text' }, { name: 'SALES', type: 'NUMBER' }],
            data: [['Central', 100]], numRows: 2, queryId: 'q1',
          },
        }}
        snowflakeToken="tok"
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('Showing 1 of 2 rows')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load full results' }))

    await waitFor(() => expect(screen.queryByText(/Showing/)).toBeNull())
    expect(fetchMock).toHaveBeenCalledWith('/api/statements/q1', expect.objectContaining({ headers: expect.objectContaining({ 'X-User-Access-Token': 'tok' }) }))
  })

  it('shows a Retry button alongside a load-full-results failure, and retrying re-fetches', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [['Central', 100], ['East', 200]] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <RightPanel
        content={{
          kind: 'artifact',
          artifact: {
            id: 'a1', type: 'table',
            rowType: [{ name: 'REGION', type: 'text' }, { name: 'SALES', type: 'NUMBER' }],
            data: [['Central', 100]], numRows: 2, queryId: 'q1',
          },
        }}
        snowflakeToken="tok"
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load full results' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('renders agent details under the "Agent details" title, with the agent name and every populated field', () => {
    render(
      <RightPanel
        content={{
          kind: 'agent-details',
          agentName: 'Sales Analyst',
          details: {
            orchestrationModel: 'claude-sonnet-4-5',
            responseInstructions: 'Be concise.',
            orchestrationInstructions: 'Prefer the semantic model.',
            sampleQuestions: ['Top region by profit?'],
            tools: [{ name: 'Sales_Analyst', type: 'cortex_analyst_text_to_sql', description: 'Analyze sales' }],
            dataSources: [{ toolName: 'Sales_Analyst', warehouse: 'XSMALL', semanticModelFile: '@DB.SCH.STAGE/model.yaml' }],
            skills: [{ name: 'review_analyst', stagePath: '@DEMO_DB.AGENTS.SKILLS/review_analyst' }],
          },
        }}
        snowflakeToken="tok"
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('Agent details')).toBeTruthy()
    expect(screen.getByText('Sales Analyst')).toBeTruthy()
    expect(screen.getByText('claude-sonnet-4-5')).toBeTruthy()
    expect(screen.getByText('Be concise.')).toBeTruthy()
    expect(screen.getByText('Prefer the semantic model.')).toBeTruthy()
    expect(screen.getByText('Analyze sales')).toBeTruthy()
    expect(screen.getByText('@DB.SCH.STAGE/model.yaml')).toBeTruthy()
    expect(screen.getByText('review_analyst')).toBeTruthy()
  })

  it('shows a fallback message when the agent details are entirely empty', () => {
    render(
      <RightPanel
        content={{ kind: 'agent-details', details: { sampleQuestions: [], tools: [], dataSources: [], skills: [] } }}
        snowflakeToken="tok"
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('No details available for this agent.')).toBeTruthy()
  })

  it('rewrites MCP warnings under Connectors and opens native CoWork', async () => {
    const openExternalUrl = vi.fn()
    setHostAdapter({ ...fakeAdapter, openExternalUrl })
    const coworkUrl = 'https://ai.snowflake.com/myorg/myaccount/#/capabilities/connectors'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      coworkUrl,
      servers: [{ fqn: 'DEMO_DB.AGENTS.JIRA_MCP', displayName: 'JIRA', connected: false }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const dump = "TOOL_NOT_ACCESSIBLE: DEMO_DB.AGENTS.JIRA_MCP (mcp_server) - mcp_server DEMO_DB.AGENTS.JIRA_MCP: MCP server 'DEMO_DB.AGENTS.JIRA_MCP' does not exist or access is not authorized for the current role."
    render(
      <RightPanel
        content={{
          kind: 'agent-details',
          agentFqn: 'DB.SCH.A',
          details: { sampleQuestions: [], tools: [], dataSources: [], skills: [] },
          warnings: [{ message: dump }],
        }}
        snowflakeToken="tok"
        onClose={() => {}}
      />,
    )

    expect(screen.queryByText(/TOOL_NOT_ACCESSIBLE/)).toBeNull()
    expect(screen.getByText('Connectors')).toBeTruthy()
    expect(screen.getByText('Jira connector unavailable. Open Connectors and authenticate in Snowflake CoWork.')).toBeTruthy()
    expect(screen.queryByText('No details available for this agent.')).toBeNull()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Open CoWork' }))
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(coworkUrl))
    expect(screen.queryByPlaceholderText('Paste the page URL after signing in')).toBeNull()
  })

  it('does not show Open CoWork for a non-MCP warning', () => {
    render(
      <RightPanel
        content={{
          kind: 'agent-details',
          details: { sampleQuestions: [], tools: [], dataSources: [], skills: [] },
          warnings: [{ message: 'SQL query queued. Waiting for warehouse to become available.' }],
        }}
        snowflakeToken="tok"
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('Warnings')).toBeTruthy()
    expect(screen.getByText('SQL query queued.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open CoWork' })).toBeNull()
  })
})
