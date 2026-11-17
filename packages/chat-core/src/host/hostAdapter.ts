// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// The seam between chat-core's api/* modules and each host's relay. Set once at app boot
// (before any component renders), then read by every fetch call — deliberately outside
// React, so no React context is needed to reach it.
/**
 * Which host embeds this app. Deliberately an open string rather than a closed union:
 * onboarding a new host (another embedding surface) should not require
 * editing a type in this package. Known value today: 'teams' (packages/tab).
 *
 * Consumers must therefore treat an unrecognized value the same as an absent one - see
 * hooks/useVoiceDictation.ts, which opts out on 'teams' specifically and otherwise assumes
 * dictation is available.
 */
export type HostPlatform = string

export interface HostAdapter {
  /** Trailing slash stripped by the implementation, so `${baseUrl()}/api/...` can't double up. */
  baseUrl(): string
  /** Headers for a relay call. `token` is the caller's Snowflake/session token, if any. */
  headers(token?: string, extra?: Record<string, string>): Record<string, string>
  /**
   * Which host embeds this app. Optional so existing bare test mocks (e.g. test-setup.ts)
   * don't need updating - callers that care (e.g. useVoiceDictation's Teams-specific mic
   * permission copy) treat an absent value as "unknown host, use the generic message".
   */
  platform?: HostPlatform
  /**
   * Host-facing product name shown in copy-as-markdown and other in-app attribution.
   * Optional so existing bare test mocks don't need updating — callers fall back to
   * the family name "Snowflake Agents Embed" when this is absent.
   */
  productName?: string
  /**
   * Fire-and-forget operational telemetry (time-to-first-token, duration, abort, error class -
   * not Datadog RUM). Optional: a host that doesn't implement it just gets no telemetry, not a
   * crash. Never awaited by callers and must never throw or block on its own account.
   */
  telemetry?(token: string | undefined, event: string, fields?: Record<string, unknown>): void
  /**
   * Called when a relay request is rejected as unauthenticated (401/403). Return a
   * fresh token to retry once, or null to surface the session-expired error. Optional:
   * a host that cannot re-exchange leaves this unset and the existing error copy
   * stands. Teams re-exchanges via Entra OBO.
   */
  onUnauthorized?(): Promise<string | null>
  /**
   * Open an https URL outside this SPA (MCP connector OAuth, etc.). Optional: a host
   * that does not implement it falls back to `window.open`.
   */
  openExternalUrl?(url: string): void
}

let adapter: HostAdapter | null = null

export function setHostAdapter(next: HostAdapter): void {
  adapter = next
}

export function getHostAdapter(): HostAdapter {
  if (!adapter) {
    throw new Error('HostAdapter not initialized — call setHostAdapter() before making API calls')
  }
  return adapter
}

/** Test helper: return the module to its pre-init state. */
export function resetHostAdapter(): void {
  adapter = null
}
