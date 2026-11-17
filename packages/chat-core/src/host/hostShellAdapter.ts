// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { ComponentType } from 'react'
import type { ShareButtonSlotProps } from '../components/Chat/MessageActions.js'

export interface HostAuthState {
  /** True once this host's session/auth handshake has completed and requests can be made. */
  ready: boolean
  token: string | null
  loading: boolean
  error: string | null
  /** Org/tenant-configured default agent, if the host has one (ui only). */
  defaultAgentFqn?: string
  /** A thread id the host wants opened on load (ui: from the record's resume state). */
  openThreadId?: number
  /** The signed-in user's display name, if the host can surface one (tab only for now - ui has
   * no user-identity field on its postMessage bridge yet). Used for the date/user preamble. */
  currentUserName?: string
  /** Re-runs the auth handshake from the `.auth-error` state (tab only - ui's session comes
   * from a one-shot postMessage handshake with no retriable step of its own). */
  onRetry?: () => void
}

export interface ShellEffectsContext {
  /** The same `ready` useAuth() returned — passed back in so effects that must not run
   * against a not-yet-landed session (e.g. resize/nav needing the host origin) can gate
   * on it, without re-deriving readiness themselves. */
  ready: boolean
  activeThreadId?: number
  lastAssistantMessageId?: number
  agentFqn?: string
}

/**
 * What AppShell needs from whichever host it's rendered in. Required (not optional) except
 * where noted, because `useAuth`/`useTheme`/`useShellEffects` are hooks — AppShell must call
 * them unconditionally on every render, so a host that has nothing to do there (tab has no
 * persist/resize/navigation concerns) still provides a no-op implementation rather than
 * AppShell branching on whether the function exists.
 */
export interface HostShellAdapter {
  useAuth(): HostAuthState
  useTheme(): string
  useShellEffects(ctx: ShellEffectsContext): void
  /** Optional: tells the agent what record or page the user is looking at. */
  buildContextPreamble?(): string | undefined
  /** Thread list is scoped to the signed-in user's own Snowflake identity (not a shared service
   * credential), so threads with no local agent mapping are safe to show. Default false. */
  perUserHistory?: boolean
  ShareButton: ComponentType<ShareButtonSlotProps>
}
