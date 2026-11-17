// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as microsoftTeams from '@microsoft/teams-js'
import { fetchAgents } from '@snowflake-agents-embed/chat-core/api/agents'
import { useTeamsAuth } from '../auth/useTeamsAuth.js'
import { TabConfig } from './TabConfig'

vi.mock('@microsoft/teams-js', () => ({
  pages: {
    config: {
      registerOnSaveHandler: vi.fn(),
      setConfig: vi.fn(),
      setValidityState: vi.fn(),
    },
  },
}))
vi.mock('@snowflake-agents-embed/chat-core/api/agents', () => ({
  fetchAgents: vi.fn(),
}))
vi.mock('../auth/useTeamsAuth.js', () => ({
  useTeamsAuth: vi.fn(),
}))

function saveHandler(): (e: microsoftTeams.pages.config.SaveEvent) => void {
  return vi.mocked(microsoftTeams.pages.config.registerOnSaveHandler).mock.calls.at(-1)![0]
}

function fakeSaveEvent() {
  return { notifySuccess: vi.fn(), notifyFailure: vi.fn() } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useTeamsAuth).mockReturnValue({ edgeSession: 'tok', error: null, loading: false, currentUserName: undefined, retry: vi.fn() } as any)
})

describe('TabConfig save validation', () => {
  it('saves immediately without validating when the FQN is left blank', async () => {
    render(<TabConfig />)
    const saveEvent = fakeSaveEvent()
    saveHandler()(saveEvent)

    expect(fetchAgents).not.toHaveBeenCalled()
    expect(saveEvent.notifySuccess).toHaveBeenCalled()
  })

  it('saves when the typed FQN matches a Cortex Agent this account can see', async () => {
    vi.mocked(fetchAgents).mockResolvedValue([{ fqn: 'DB.SCH.SALES_AGENT', displayName: 'Sales' }])
    render(<TabConfig />)
    await userEvent.type(screen.getByRole('textbox'), 'db.sch.sales_agent')

    const saveEvent = fakeSaveEvent()
    saveHandler()(saveEvent)
    await vi.waitFor(() => expect(saveEvent.notifySuccess).toHaveBeenCalled())
  })

  it('fails with an inline message when the FQN does not match any known agent', async () => {
    vi.mocked(fetchAgents).mockResolvedValue([{ fqn: 'DB.SCH.SALES_AGENT', displayName: 'Sales' }])
    render(<TabConfig />)
    await userEvent.type(screen.getByRole('textbox'), 'DB.SCH.NONEXISTENT')

    const saveEvent = fakeSaveEvent()
    saveHandler()(saveEvent)
    await vi.waitFor(() => expect(saveEvent.notifyFailure).toHaveBeenCalledWith(expect.stringContaining('NONEXISTENT')))
  })

  it('fails with a retry message when the agent lookup itself errors', async () => {
    vi.mocked(fetchAgents).mockRejectedValue(new Error('network down'))
    render(<TabConfig />)
    await userEvent.type(screen.getByRole('textbox'), 'DB.SCH.SALES_AGENT')

    const saveEvent = fakeSaveEvent()
    saveHandler()(saveEvent)
    await vi.waitFor(() => expect(saveEvent.notifyFailure).toHaveBeenCalledWith(expect.stringContaining('Try again')))
  })

  it('fails fast when the FQN is non-blank but no token is available yet', async () => {
    vi.mocked(useTeamsAuth).mockReturnValue({ edgeSession: null, error: null, loading: true, currentUserName: undefined, retry: vi.fn() } as any)
    render(<TabConfig />)
    await userEvent.type(screen.getByRole('textbox'), 'DB.SCH.SALES_AGENT')

    const saveEvent = fakeSaveEvent()
    saveHandler()(saveEvent)
    expect(fetchAgents).not.toHaveBeenCalled()
    expect(saveEvent.notifyFailure).toHaveBeenCalledWith(expect.stringContaining('signing in'))
  })
})
