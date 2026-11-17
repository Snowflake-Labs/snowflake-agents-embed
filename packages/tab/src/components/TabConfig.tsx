// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react'
import * as microsoftTeams from '@microsoft/teams-js'
import { fetchAgents } from '@snowflake-agents-embed/chat-core/api/agents'
import { useTeamsAuth } from '../auth/useTeamsAuth.js'

function saveConfig(agentFqn: string, saveEvent: microsoftTeams.pages.config.SaveEvent) {
  void microsoftTeams.pages.config.setConfig({
    entityId: `agents-channel-${agentFqn || 'default'}`,
    contentUrl: `${window.location.origin}/tab?agentFqn=${encodeURIComponent(agentFqn)}`,
    suggestedDisplayName: 'Snowflake Agent for Teams (Unofficial)',
  })
  saveEvent.notifySuccess()
}

export function TabConfig() {
  const [agentFqn, setAgentFqn] = useState('')
  const { edgeSession } = useTeamsAuth()

  useEffect(() => {
    microsoftTeams.pages.config.registerOnSaveHandler((saveEvent) => {
      const trimmed = agentFqn.trim()
      // A blank FQN means "use the account default" - nothing to validate against.
      if (!trimmed) return saveConfig(trimmed, saveEvent)

      if (!edgeSession) {
        saveEvent.notifyFailure('Still signing in — try Save again in a moment.')
        return
      }
      fetchAgents(edgeSession)
        .then((agents) => {
          const known = agents.some((a) => a.fqn.toUpperCase() === trimmed.toUpperCase())
          if (!known) {
            saveEvent.notifyFailure(`"${trimmed}" isn't a Cortex Agent this account can see. Check the FQN and try again.`)
            return
          }
          saveConfig(trimmed, saveEvent)
        })
        .catch(() => saveEvent.notifyFailure("Couldn't verify that agent right now. Try again in a moment."))
    })
    microsoftTeams.pages.config.setValidityState(true)
  }, [agentFqn, edgeSession])

  return (
    <div className="tab-config">
      <label>
        Cortex Agent FQN (DATABASE.SCHEMA.NAME — leave blank for account default):
        <input
          type="text"
          value={agentFqn}
          onChange={(e) => setAgentFqn(e.target.value)}
          placeholder="e.g. MY_DB.PUBLIC.SALES_AGENT"
        />
      </label>
    </div>
  )
}
