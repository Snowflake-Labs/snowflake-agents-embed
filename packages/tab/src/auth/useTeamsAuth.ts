// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import * as microsoftTeams from '@microsoft/teams-js'
import { resolveUserName, nameFromEntraToken, type UserNameSources } from './teamsUserName.js'
import { setTabEdgeSession, setTabOnUnauthorized } from '../host/hostAdapter.js'

interface AuthState {
  /** Opaque edge session (JWE) in production; local-pat stores the PAT echo here. */
  edgeSession: string | null
  error: string | null
  loading: boolean
}

const REFRESH_LEAD_S = 60
const MIN_REFRESH_S = 30
const DEFAULT_EXPIRES_S = 3600
const REFRESH_RETRY_MS = [1000, 2000, 4000]

/** Normalize Entra/local-pat expiresIn so a tiny or missing value cannot hot-loop. */
export function refreshDelayMs(expiresIn: unknown): number {
  const n = Number(expiresIn)
  const lifetime = Number.isFinite(n) && n > REFRESH_LEAD_S ? n : DEFAULT_EXPIRES_S
  return Math.max(lifetime - REFRESH_LEAD_S, MIN_REFRESH_S) * 1000
}

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4))
}

// Maps the handful of failure causes a user can actually act on to plain-language copy.
// Everything else (unrecognized AADSTS codes, network errors, the raw OBO 401 body) falls
// back to a generic message rather than showing Entra's machine-readable string verbatim.
export function classifyAuthError(message: string): string {
  if (message.includes('ERR_JWT_EXPIRED')) {
    return 'Your Teams sign-in session has expired. Sign out of Teams and sign back in, then retry.'
  }
  if (message.includes('AADSTS65001')) {
    return "You haven't consented to this app yet. Ask your Teams admin to approve it, or try signing in again."
  }
  if (message.includes('AADSTS700016')) {
    return 'This app is not set up correctly for your organization. Contact your Snowflake admin.'
  }
  if (/network|fetch|timeout/i.test(message)) {
    return "Couldn't reach Snowflake — check your connection and try again."
  }
  return "Couldn't sign you in. Try again in a moment, or contact your Snowflake admin if this persists."
}

function errorFromExchangeBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>
    if (typeof rec.code === 'string' && rec.code) return rec.code
    if (typeof rec.error === 'string' && rec.error) return rec.error
  }
  return fallback
}

function isExpiredJwtError(body: unknown): boolean {
  return Boolean(
    body
    && typeof body === 'object'
    && (body as Record<string, unknown>).code === 'ERR_JWT_EXPIRED',
  )
}

export function useTeamsAuth() {
  const [state, setState] = useState<AuthState>({ edgeSession: null, error: null, loading: true })
  // Raw name inputs are kept separate and resolved on render so precedence is
  // deterministic no matter which async source (Teams context vs token exchange) lands first.
  const [teamsUser, setTeamsUser] = useState<UserNameSources>({})
  const [tokenName, setTokenName] = useState<string | undefined>()
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelled = useRef(false)
  const refreshAttempts = useRef(0)
  const tokenRef = useRef<string | null>(null)
  tokenRef.current = state.edgeSession
  const fetchTokenRef = useRef<() => Promise<string | null>>(async () => null)
  const inFlight = useRef<Promise<string | null> | null>(null)

  const fetchTokenOnce = useCallback(async (): Promise<string | null> => {
    try {
      // Token exchange runs on the no-auth edge (same-origin edge Worker by default);
      // agent run goes to SPCS. Keeping them on separate bases is deliberate: the SPCS
      // ingress login wall would break token exchange (see docs/superpowers spec §393-400).
      const spcsBase = import.meta.env.VITE_SPCS_BASE ?? ''
      const edgeBase = import.meta.env.VITE_EDGE_BASE ?? ''

      // local-pat mode: skip Teams SSO and hand the local server a PAT directly.
      // Mirrors the server's local-pat branch (routes/token.ts) and the CI smoke test.
      if (import.meta.env.VITE_AUTH_MODE === 'local-pat') {
        const res = await fetch(`${spcsBase}/api/token/exchange`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Snowflake-Pat': import.meta.env.VITE_SNOWFLAKE_PAT ?? '',
          },
          body: JSON.stringify({}),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(errorFromExchangeBody(body, 'token exchange failed'))
        }
        const { snowflakeToken, expiresIn } = await res.json()
        if (cancelled.current) return null
        setState({ edgeSession: snowflakeToken, error: null, loading: false })
        refreshAttempts.current = 0
        clearTimeout(refreshTimer.current)
        if (cancelled.current) return snowflakeToken
        refreshTimer.current = setTimeout(() => { void fetchTokenRef.current() }, refreshDelayMs(expiresIn))
        return snowflakeToken
      }

      // Split from the OBO exchange below so a log line (and, if this ever needs to branch
      // on it, the caller) can tell "user never got past Teams SSO" apart from "Teams SSO
      // succeeded but the server-side OBO leg failed" - the two have different remedies.
      let entraToken: string
      try {
        await microsoftTeams.app.initialize()
        entraToken = await microsoftTeams.authentication.getAuthToken()
      } catch (err: any) {
        if (cancelled.current) return null
        console.warn(`[useTeamsAuth] Teams SSO failed: ${err?.message ?? err}`)
        setState({ edgeSession: null, error: classifyAuthError(err?.message ?? String(err)), loading: false })
        return null
      }
      const exchange = (token: string) => fetch(`${edgeBase}/token/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entraToken: token }),
      })

      let res = await exchange(entraToken)
      if (!res.ok) {
        let body = await res.json().catch(() => null)
        if (isExpiredJwtError(body)) {
          // Teams owns the SSO-token cache and exposes no force-refresh flag. A second
          // request with silent=false lets the host prompt/renew instead of restricting
          // itself to its stale silent cache. Retry exactly once to avoid request loops.
          entraToken = await microsoftTeams.authentication.getAuthToken({ silent: false })
          res = await exchange(entraToken)
          if (!res.ok) body = await res.json().catch(() => null)
        }
        if (!res.ok) throw new Error(errorFromExchangeBody(body, 'OBO exchange failed'))
      }
      // Claims are a display-only fallback for when the Teams context has no displayName;
      // the edge still verifies this same token before exchanging it.
      setTokenName(nameFromEntraToken(entraToken))
      // The Snowflake token stays at the edge (inside the encrypted session). The browser's
      // "token" is that opaque session: enough to prove it is authenticated, useless elsewhere.
      const { expiresIn, edgeSession } = await res.json()
      if (typeof edgeSession !== 'string' || !edgeSession) throw new Error('token exchange returned no session')
      if (cancelled.current) return null
      setTabEdgeSession(edgeSession)
      setState({ edgeSession, error: null, loading: false })
      refreshAttempts.current = 0

      clearTimeout(refreshTimer.current)
      if (cancelled.current) return edgeSession
      refreshTimer.current = setTimeout(() => { void fetchTokenRef.current() }, refreshDelayMs(expiresIn))
      return edgeSession
    } catch (err: any) {
      if (cancelled.current) return null
      const held = tokenRef.current
      if (held && refreshAttempts.current < REFRESH_RETRY_MS.length) {
        const delay = jitter(REFRESH_RETRY_MS[refreshAttempts.current])
        refreshAttempts.current += 1
        clearTimeout(refreshTimer.current)
        refreshTimer.current = setTimeout(() => { void fetchTokenRef.current() }, delay)
        return held
      }
      console.warn(`[useTeamsAuth] OBO exchange failed: ${err?.message ?? err}`)
      setState({ edgeSession: null, error: classifyAuthError(err?.message ?? String(err)), loading: false })
      return null
    }
  }, [])
  // Concurrent 401s (threads, agents, ...) must share one exchange or they trip the edge limiter.
  const fetchToken = useCallback((): Promise<string | null> => {
    if (!inFlight.current) {
      inFlight.current = fetchTokenOnce().finally(() => { inFlight.current = null })
    }
    return inFlight.current
  }, [fetchTokenOnce])
  fetchTokenRef.current = fetchToken

  useEffect(() => {
    cancelled.current = false
    setTabOnUnauthorized(() => fetchTokenRef.current())
    void fetchToken()
    return () => {
      cancelled.current = true
      clearTimeout(refreshTimer.current)
      setTabOnUnauthorized(undefined)
    }
  }, [fetchToken])

  // fetchToken is already the stable function both mount and the refresh timer call - expose
  // it as a Retry action for the terminal auth-error state, rather than the only recovery
  // being a full tab reload.
  const retry = useCallback(() => {
    cancelled.current = false
    refreshAttempts.current = 0
    setState((s) => ({ ...s, loading: true, error: null }))
    void fetchToken()
  }, [fetchToken])

  // Independent of the token-refresh cycle above so a token refresh never resets it.
  // Runs in local-pat mode too, so a sideloaded dev build still greets by name; outside a
  // Teams host (plain browser dev server) initialize/getContext rejects and the sources
  // stay empty, matching the "date-only" fallback the preamble is built to handle.
  useEffect(() => {
    microsoftTeams.app.initialize()
      .then(() => microsoftTeams.app.getContext())
      .then((ctx) => setTeamsUser({
        displayName: ctx.user?.displayName,
        userPrincipalName: ctx.user?.userPrincipalName,
        loginHint: ctx.user?.loginHint,
      }))
      .catch(() => { /* leave empty - the date-only preamble still ships */ })
  }, [])

  const currentUserName = useMemo(
    () => resolveUserName({ ...teamsUser, tokenName }),
    [teamsUser, tokenName],
  )

  return { ...state, currentUserName, retry }
}
