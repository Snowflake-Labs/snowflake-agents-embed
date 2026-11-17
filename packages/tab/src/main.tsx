// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import React from 'react'
import ReactDOM from 'react-dom/client'
import * as microsoftTeams from '@microsoft/teams-js'
import { setHostAdapter } from '@snowflake-agents-embed/chat-core/host/hostAdapter'
import { tabHostAdapter } from './host/hostAdapter.js'
import { tabShellAdapter } from './host/shellAdapter.js'
import { AppShell } from '@snowflake-agents-embed/chat-core/components/Layout/AppShell'
import { ChatErrorBoundary } from '@snowflake-agents-embed/chat-core/components/Layout/ChatErrorBoundary'
import { TabConfig } from './components/TabConfig.js'
import { LinkScreen } from './components/LinkScreen.js'
import { renderBootstrapError } from './bootstrap-error.js'
import '@snowflake-agents-embed/chat-core/styles/index.css'
import './index.css'

setHostAdapter(tabHostAdapter)

async function notifyLoaded() {
  try {
    microsoftTeams.app.notifyAppLoaded()
  } catch {
    // SDK may not be initialized if bootstrap itself failed.
  }
}

async function main() {
  try {
    await microsoftTeams.app.initialize()
    const ctx = await microsoftTeams.app.getContext()

    document.documentElement.setAttribute('data-teams-theme', ctx.app?.theme ?? 'default')

    const isConfig = window.location.pathname.endsWith('/config')

    // Read agentFqn from the tab content URL (set by TabConfig via pages.config.setConfig).
    const urlParams = new URLSearchParams(window.location.search)
    const initialAgentFqn = urlParams.get('agentFqn') ?? undefined

    // Deep-link: subEntityId = "thread:<id>" — open that thread on load.
    let openThreadId: number | undefined
    let signinCode: string | undefined
    const subEntityId = ctx.page?.subPageId
    // Deep-link: subEntityId = "signin:<code>" — finish linking a bot chat user.
    if (subEntityId?.startsWith('signin:')) signinCode = subEntityId.slice('signin:'.length) || undefined
    if (subEntityId?.startsWith('thread:')) {
      const id = parseInt(subEntityId.slice('thread:'.length), 10)
      if (!isNaN(id)) openThreadId = id
    }

    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ChatErrorBoundary>
          {isConfig
            ? <TabConfig />
            : signinCode
            ? <LinkScreen code={signinCode} />
            : <AppShell adapter={tabShellAdapter} initialAgentFqn={initialAgentFqn} openThreadId={openThreadId} />
          }
        </ChatErrorBoundary>
      </React.StrictMode>
    )

    // Tells Teams the tab has finished loading. Without this the client can leave the
    // iframe's layout/sizing in a provisional state, which is what breaks the
    // height:100% cascade the message list relies on to become scrollable.
    microsoftTeams.app.notifyAppLoaded()
    void microsoftTeams.app.notifySuccess()
  } catch (err: unknown) {
    console.error('[tab] bootstrap failed:', err)
    renderBootstrapError()
    await notifyLoaded()
  }
}

main().catch((err: unknown) => {
  console.error('[tab] bootstrap failed:', err)
  renderBootstrapError()
})
