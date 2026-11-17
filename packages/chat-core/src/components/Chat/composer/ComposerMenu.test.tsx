// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ComposerMenu } from './ComposerMenu'
import { useChatStore } from '../../../store/chatStore'
import { setFeatureFlags, resetFeatureFlags } from '../../../lib/featureFlags'
import { fetchAgentDetailsCached } from '../../../api/agents.js'
import { fetchMcpConnections } from '../../../api/mcpConnections.js'
import { setHostAdapter, resetHostAdapter, type HostAdapter } from '../../../host/hostAdapter'

vi.mock('../../../api/agents.js', () => ({
  fetchAgentDetailsCached: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../../api/mcpConnections.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/mcpConnections.js')>()
  return {
    ...actual,
    fetchMcpConnections: vi.fn().mockResolvedValue({ coworkUrl: '', servers: [] }),
  }
})

const fakeAdapter: HostAdapter = {
  baseUrl: () => '',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
}

const ATLASSIAN_FQN = 'DEMO_DB.AGENTS.JIRA_MCP'
const COWORK = 'https://ai.snowflake.com/myorg/myaccount/#/capabilities/connectors'

beforeEach(() => {
  setHostAdapter(fakeAdapter)
  useChatStore.setState({
    deepResearch: false,
    webSearch: true,
    activeThreadTempId: null,
    openThreads: {},
  })
  // Every test opening the "+" menu now triggers the eager details fetch (needed to know
  // whether to show Web search); reset the mock's resolved value each time so a prior test's
  // mockResolvedValue/mockImplementation override doesn't leak into the next one.
  vi.mocked(fetchAgentDetailsCached).mockResolvedValue(null)
  vi.mocked(fetchMcpConnections).mockResolvedValue({ coworkUrl: '', servers: [] })
})
afterEach(() => { resetFeatureFlags(); resetHostAdapter(); vi.clearAllMocks() })

function renderMenu(overrides: Partial<Parameters<typeof ComposerMenu>[0]> = {}) {
  const onAddFile = vi.fn()
  const onAddSkill = vi.fn()
  const onRemoveSkill = vi.fn()
  render(
    <ComposerMenu
      onAddFile={onAddFile}
      snowflakeToken="tok"
      agentFqn="DB.SCH.A"
      selectedSkills={[]}
      onAddSkill={onAddSkill}
      onRemoveSkill={onRemoveSkill}
      {...overrides}
    />,
  )
  return { onAddFile, onAddSkill, onRemoveSkill }
}

describe('ComposerMenu', () => {
  it('opens and closes on trigger click, and closes on an outside click', () => {
    setFeatureFlags({ fileUpload: true, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    renderMenu()
    expect(screen.queryByText('Upload files')).toBeNull()

    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    expect(screen.getByText('Upload files')).toBeTruthy()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('Upload files')).toBeNull()
  })

  it('hides Upload files, Deep Research, and Skills when their flags are off', () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    renderMenu()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    expect(screen.queryByText('Upload files')).toBeNull()
    expect(screen.queryByText('Deep Research')).toBeNull()
    expect(screen.queryByText('Skills')).toBeNull()
  })

  it('computes the trigger tooltip/aria-label from the flags actually enabled', () => {
    setFeatureFlags({ fileUpload: true, deepResearch: true, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    renderMenu()
    const trigger = document.querySelector('.composer-menu-trigger')!
    expect(trigger.getAttribute('title')).toBe('Upload files, Deep research')
    expect(trigger.getAttribute('aria-label')).toBe('Upload files, Deep research')
  })

  it('shows an explicit "No options available" row instead of an empty menu when every flag is off', () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    renderMenu()
    const trigger = document.querySelector('.composer-menu-trigger')!
    expect(trigger.getAttribute('aria-label')).toBe('No options available')

    fireEvent.click(trigger)
    expect(screen.getByText('No options available')).toBeTruthy()
  })

  it('shows every supported option when flags and agent capabilities are available', async () => {
    setFeatureFlags({ fileUpload: true, deepResearch: true, skills: true, webSearch: true, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue({
      sampleQuestions: [],
      dataSources: [],
      skills: [{ name: 'forecast', stagePath: '@DB.SCH.SKILLS/forecast' }],
      tools: [{ name: 'web_search', type: 'web_search' }],
      mcpServers: [{ fqn: ATLASSIAN_FQN, displayName: 'JIRA' }],
    })
    vi.mocked(fetchMcpConnections).mockResolvedValue({
      coworkUrl: COWORK,
      servers: [{ fqn: ATLASSIAN_FQN, displayName: 'JIRA', connected: true }],
    })
    renderMenu()

    fireEvent.click(document.querySelector('.composer-menu-trigger')!)

    expect(screen.getByText('Upload files')).toBeTruthy()
    expect(screen.getByText('Deep Research')).toBeTruthy()
    expect(screen.getByText('Skills')).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText('Web search')).toBeTruthy()
      expect(screen.getByText('Connectors')).toBeTruthy()
    })
  })

  it('toggles the deepResearch store boolean and closes the menu', () => {
    setFeatureFlags({ fileUpload: false, deepResearch: true, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    renderMenu()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    fireEvent.click(screen.getByText('Deep Research'))
    expect(useChatStore.getState().deepResearch).toBe(true)
    expect(screen.queryByText('Deep Research')).toBeNull()
  })

  it('fetches agent details as soon as the "+" menu opens (not gated on Skills), and toggles selection', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: true, webSearch: false, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue({
      sampleQuestions: [], tools: [], dataSources: [],
      skills: [{ name: 'forecast', stagePath: '@DB.SCH.SKILLS/forecast' }],
    })
    const { onAddSkill } = renderMenu()

    expect(fetchAgentDetailsCached).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    expect(fetchAgentDetailsCached).toHaveBeenCalledWith('tok', 'DB.SCH.A')

    fireEvent.click(screen.getByText('Skills'))
    await waitFor(() => expect(screen.getByText('forecast')).toBeTruthy())

    fireEvent.click(screen.getByText('forecast'))
    expect(onAddSkill).toHaveBeenCalledWith({ name: 'forecast', stagePath: '@DB.SCH.SKILLS/forecast' })
  })

  it('shows a badge with the selected skill count', () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: true, webSearch: false, richComposer: false, nativeStreamFlags: false })
    renderMenu({ selectedSkills: [{ name: 'forecast', stagePath: '@x' }] })
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('hides Skills when there is no active agent', () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: true, webSearch: false, richComposer: false, nativeStreamFlags: false })
    renderMenu({ agentFqn: undefined })
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    expect(screen.queryByText('Skills')).toBeNull()
  })

  it('shows Loading… not the empty state while the skills fetch is in flight', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: true, webSearch: false, richComposer: false, nativeStreamFlags: false })
    let resolve: (v: Awaited<ReturnType<typeof fetchAgentDetailsCached>>) => void = () => {}
    vi.mocked(fetchAgentDetailsCached).mockImplementation(() => new Promise((r) => { resolve = r }))
    renderMenu()

    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    fireEvent.click(screen.getByText('Skills'))
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('No skills configured on this agent.')).toBeNull()

    resolve({ sampleQuestions: [], tools: [], dataSources: [], skills: [] })
    await waitFor(() => expect(screen.getByText('No skills configured on this agent.')).toBeTruthy())
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('never shows the previous agent\'s skills after switching while the submenu is open', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: true, webSearch: false, richComposer: false, nativeStreamFlags: false })
    let resolveA: (v: Awaited<ReturnType<typeof fetchAgentDetailsCached>>) => void = () => {}
    vi.mocked(fetchAgentDetailsCached).mockImplementation((_tok, fqn) => {
      if (fqn === 'DB.SCH.A') return new Promise((resolve) => { resolveA = resolve })
      return Promise.resolve({
        sampleQuestions: [], tools: [], dataSources: [],
        skills: [{ name: 'summarize', stagePath: '@DB.SCH.SKILLS/summarize' }],
      })
    })
    const { rerender } = render(
      <ComposerMenu
        onAddFile={vi.fn()}
        snowflakeToken="tok"
        agentFqn="DB.SCH.A"
        selectedSkills={[]}
        onAddSkill={vi.fn()}
        onRemoveSkill={vi.fn()}
      />,
    )

    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    fireEvent.click(screen.getByText('Skills'))
    expect(fetchAgentDetailsCached).toHaveBeenCalledWith('tok', 'DB.SCH.A')

    // Switch agents before agent A's slow fetch resolves.
    rerender(
      <ComposerMenu
        onAddFile={vi.fn()}
        snowflakeToken="tok"
        agentFqn="DB.SCH.B"
        selectedSkills={[]}
        onAddSkill={vi.fn()}
        onRemoveSkill={vi.fn()}
      />,
    )
    // The stale list must clear immediately, not stay visible until a fetch resolves - and
    // it shows "Loading…", not the empty state, since the submenu was already open when the
    // agent switched (Bug 3: a flash of "No skills configured" on agent switch).
    expect(screen.queryByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('No skills configured on this agent.')).toBeNull()

    await waitFor(() => expect(screen.getByText('summarize')).toBeTruthy())

    // Agent A's fetch finally resolves after the switch; it must not clobber agent B's list.
    resolveA({ sampleQuestions: [], tools: [], dataSources: [], skills: [{ name: 'forecast', stagePath: '@x' }] })
    await Promise.resolve()
    expect(screen.queryByText('forecast')).toBeNull()
    expect(screen.getByText('summarize')).toBeTruthy()
  })

  it('hides Web search when the flag is off even if the agent has the tool', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue({
      sampleQuestions: [], dataSources: [], skills: [],
      tools: [{ name: 'web_search', type: 'web_search' }],
    })
    renderMenu()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    await waitFor(() => expect(fetchAgentDetailsCached).toHaveBeenCalled())
    expect(screen.queryByText('Web search')).toBeNull()
  })

  it('hides Web search when the active agent has no web_search tool', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: true, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue({
      sampleQuestions: [], dataSources: [], skills: [],
      tools: [{ name: 'cortex_search', type: 'cortex_search' }],
    })
    renderMenu()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    await waitFor(() => expect(fetchAgentDetailsCached).toHaveBeenCalled())
    expect(screen.queryByText('Web search')).toBeNull()
  })

  it('shows Web search on for an agent that has it, and toggles it off without closing on the deep-research row', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: true, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue({
      sampleQuestions: [], dataSources: [], skills: [],
      tools: [{ name: 'web_search', type: 'web_search' }],
    })
    renderMenu()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    await waitFor(() => expect(screen.getByText('Web search')).toBeTruthy())
    expect(useChatStore.getState().webSearch).toBe(true)

    fireEvent.click(screen.getByText('Web search'))
    expect(useChatStore.getState().webSearch).toBe(false)
    expect(screen.queryByText('Web search')).toBeNull()
  })

  it('hides Connectors when the agent has no MCP servers', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue({
      sampleQuestions: [], tools: [], dataSources: [], skills: [], mcpServers: [],
    })
    renderMenu()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    await waitFor(() => expect(fetchAgentDetailsCached).toHaveBeenCalled())
    expect(screen.queryByText('Connectors')).toBeNull()
  })

  it('hides Snowflake-managed MCP servers omitted by the native connector endpoint', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue({
      sampleQuestions: [], tools: [], dataSources: [], skills: [],
      mcpServers: [{ fqn: 'DEMO_DB.AGENTS.DEMO_MCP', displayName: 'DEMO_MCP' }],
    })
    vi.mocked(fetchMcpConnections).mockResolvedValue({ coworkUrl: COWORK, servers: [] })
    renderMenu()

    fireEvent.click(document.querySelector('.composer-menu-trigger')!)

    await waitFor(() => expect(fetchMcpConnections).toHaveBeenCalledOnce())
    expect(screen.queryByText('Connectors')).toBeNull()
    expect(screen.queryByText('DEMO_MCP')).toBeNull()
  })

  it('shows Connectors with a 1 of 1 count and a check when the API reports connected', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchMcpConnections).mockResolvedValue({
      coworkUrl: COWORK,
      servers: [{ fqn: ATLASSIAN_FQN, displayName: 'JIRA', connected: true }],
    })
    renderMenu()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    await waitFor(() => expect(screen.getByText('Connectors')).toBeTruthy())
    expect(screen.getByText('1 of 1')).toBeTruthy()

    fireEvent.click(screen.getByText('Connectors'))
    expect(screen.getByText('JIRA')).toBeTruthy()
    expect(document.querySelector('.connectors-submenu-check')).toBeTruthy()
    expect(screen.getByText('Manage Connectors')).toBeTruthy()
  })

  it('shows Connect when the API reports disconnected', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchMcpConnections).mockResolvedValue({
      coworkUrl: COWORK,
      servers: [{ fqn: ATLASSIAN_FQN, displayName: 'JIRA', connected: false }],
    })
    renderMenu()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    await waitFor(() => expect(screen.getByText('Connectors')).toBeTruthy())
    fireEvent.click(screen.getByText('Connectors'))
    expect(screen.getByText('Connect')).toBeTruthy()
    expect(document.querySelector('.connectors-submenu-check')).toBeNull()
  })

  it('opens native CoWork from Manage Connectors', async () => {
    const openExternalUrl = vi.fn()
    setHostAdapter({ ...fakeAdapter, openExternalUrl })
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchMcpConnections).mockResolvedValue({
      coworkUrl: COWORK,
      servers: [{ fqn: ATLASSIAN_FQN, displayName: 'JIRA', connected: true }],
    })
    renderMenu()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    await waitFor(() => expect(screen.getByText('Connectors')).toBeTruthy())
    fireEvent.click(screen.getByText('Connectors'))
    fireEvent.click(screen.getByText('Manage Connectors'))
    expect(openExternalUrl).toHaveBeenCalledWith(COWORK)
    expect(screen.queryByText('Connect')).toBeNull()
  })

  it('does not label an unknown connector as Connect', async () => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchMcpConnections).mockResolvedValue({
      coworkUrl: COWORK,
      servers: [{ fqn: ATLASSIAN_FQN, displayName: 'JIRA', connected: null }],
    })
    renderMenu()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    await waitFor(() => expect(screen.getByText('Connectors')).toBeTruthy())
    fireEvent.click(screen.getByText('Connectors'))
    expect(screen.getByText('JIRA')).toBeTruthy()
    expect(screen.queryByText('Connect')).toBeNull()
    expect(document.querySelector('.connectors-submenu-check')).toBeNull()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('includes Connectors in the trigger tooltip once the agent list lands', async () => {
    setFeatureFlags({ fileUpload: true, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    vi.mocked(fetchMcpConnections).mockResolvedValue({
      coworkUrl: COWORK,
      servers: [{ fqn: ATLASSIAN_FQN, displayName: 'JIRA', connected: null }],
    })
    renderMenu()
    fireEvent.click(document.querySelector('.composer-menu-trigger')!)
    await waitFor(() => expect(screen.getByText('Connectors')).toBeTruthy())
    expect(document.querySelector('.composer-menu-trigger')!.getAttribute('title'))
      .toBe('Upload files, Connectors')
  })
})
