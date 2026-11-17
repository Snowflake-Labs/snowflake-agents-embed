// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { HostAdapter } from '@snowflake-agents-embed/chat-core/host/hostAdapter'

// useTeamsAuth installs this on mount so a mid-turn 401 can force a re-exchange
// without the stream hook importing the auth hook.
let unauthorizedHandler: (() => Promise<string | null>) | undefined

export function setTabOnUnauthorized(fn: (() => Promise<string | null>) | undefined): void {
  unauthorizedHandler = fn
}

// Set by useTeamsAuth from the /token/exchange response; the Pages proxy requires it
// on every /api/* call before it attaches the SPCS PAT.
let edgeSession: string | null = null

export function setTabEdgeSession(session: string | null): void {
  edgeSession = session
}

// Production: the browser holds only the opaque edge session (passed in as `token`); the
// Pages proxy swaps it for the SPCS PAT and the user's Snowflake token. local-pat (dev)
// talks to the local server directly with the PAT itself.
export const tabHostAdapter: HostAdapter = {
  platform: 'teams',
  productName: 'Snowflake Agent for Teams (Unofficial)',
  baseUrl: () => import.meta.env.VITE_SPCS_BASE ?? '',
  headers: (token, extra) => ({
    'Content-Type': 'application/json',
    ...(import.meta.env.VITE_AUTH_MODE === 'local-pat'
      ? { Authorization: `Snowflake Token="${token ?? ''}"`, 'X-User-Access-Token': token ?? '' }
      : {}),
    ...(edgeSession ? { 'X-Edge-Session': edgeSession } : {}),
    ...extra,
  }),
  onUnauthorized: () => unauthorizedHandler?.() ?? Promise.resolve(null),
  openExternalUrl: (url) => {
    if (!url.startsWith('https://')) return
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  // Fire-and-forget — a failed telemetry POST must never surface to the user or affect the
  // turn it describes, so its own promise is intentionally left unawaited and unchecked here.
  telemetry: (token, event, fields) => {
    fetch(`${tabHostAdapter.baseUrl()}/api/telemetry`, {
      method: 'POST',
      headers: tabHostAdapter.headers(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ event, fields }),
    }).catch(() => {})
  },
}
