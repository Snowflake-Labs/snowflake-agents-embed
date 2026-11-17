// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { HostShellAdapter } from '@snowflake-agents-embed/chat-core/host/hostShellAdapter'
import { useTeamsAuth } from '../auth/useTeamsAuth.js'
import { useTeamsTheme } from '../hooks/useTeamsTheme.js'
import { ShareButton } from '../components/Chat/ShareButton.js'

export const tabShellAdapter: HostShellAdapter = {
  useAuth() {
    const { edgeSession, error, loading, currentUserName, retry } = useTeamsAuth()
    return { ready: Boolean(edgeSession), token: edgeSession, error, loading, currentUserName, onRetry: retry }
  },
  useTheme: useTeamsTheme,
  useShellEffects() {
    // Teams has no persist/navigation concerns of its own — the tab is a normal page.
    // Iframe sizing is handled via viewport units in index.css plus the SDK's
    // notifyAppLoaded/notifySuccess load signal in main.tsx, not a resize handler here.
  },
  ShareButton,
  perUserHistory: import.meta.env.VITE_AUTH_MODE !== 'local-pat',
}
