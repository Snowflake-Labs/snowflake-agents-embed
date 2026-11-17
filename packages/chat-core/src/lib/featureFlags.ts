// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react'
import { hostFetch } from '../api/hostFetch.js'

export interface FeatureFlags {
  fileUpload: boolean
  deepResearch: boolean
  skills: boolean
  /** Gates the per-agent Web search toggle; only shown when the active agent also has a `web_search` tool. */
  webSearch: boolean
  /** Gates the Lexical rich-editor composer path; default off, instant rollback via /api/config. */
  richComposer: boolean
  /**
   * Extra undocumented stream fields on top of the date/chart flags that now always go out
   * (enableStepTrace / enableAnalystStreaming / enableRelatedQueries / responseSchemaVersion v2).
   *
   * Default OFF, and note what a probe against a live agent actually showed: Cortex emits the
   * same event mix - response.status narration included - with or without these. They are not
   * required for the reasoning panel; consuming the events we were already receiving was the
   * fix for that. Kept because they're what the native app sends and may matter for agent
   * configs we haven't exercised (streamed Analyst output, sandboxes, skills), but they're
   * undocumented, so this stays a flag rather than unconditional.
   */
  nativeStreamFlags: boolean
}

// Build-time fallback - today's behavior when no host ever calls setFeatureFlags(), e.g.
// before /api/config resolves, or a host that doesn't wire runtime config at all.
// Cached: useSyncExternalStore compares snapshots with Object.is, so a fresh object
// every getSnapshot() looks like a store change and re-renders forever.
const ENV_DEFAULTS: FeatureFlags = {
  fileUpload: import.meta.env.VITE_FF_FILE_UPLOAD === 'true',
  deepResearch: import.meta.env.VITE_FF_DEEP_RESEARCH === 'true',
  skills: import.meta.env.VITE_FF_SKILLS === 'true',
  webSearch: import.meta.env.VITE_FF_WEB_SEARCH === 'true',
  richComposer: import.meta.env.VITE_FF_RICH_COMPOSER === 'true',
  nativeStreamFlags: import.meta.env.VITE_FF_NATIVE_STREAM_FLAGS === 'true',
}

function envDefaults(): FeatureFlags {
  return ENV_DEFAULTS
}

let flags: FeatureFlags | null = null
let defaultAgentFqn = ''
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Org default from GET /api/config. Empty until loadFeatureFlags sees a string field. */
export function getDefaultAgentFqn(): string {
  return defaultAgentFqn
}

/**
 * Called once at boot (after fetching the host's `/api/config`) so flags can flip without a
 * redeploy of the built client. Mirrors host/hostAdapter.ts's setHostAdapter() pattern:
 * module-level state set outside React, read by any call site regardless of component tree
 * position.
 */
export function setFeatureFlags(next: FeatureFlags): void {
  flags = next
  emit()
}

export function getFeatureFlags(): FeatureFlags {
  return flags ?? envDefaults()
}

export function subscribeFeatureFlags(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => { listeners.delete(onStoreChange) }
}

/** Subscribe a component to runtime flag updates via `/api/config`. */
export function useFeatureFlags(): FeatureFlags {
  return useSyncExternalStore(subscribeFeatureFlags, getFeatureFlags, getFeatureFlags)
}

/** Test helper: return the module to its pre-init state. */
export function resetFeatureFlags(): void {
  flags = null
  defaultAgentFqn = ''
  emit()
}

/**
 * Fetches `/api/config` and applies the result via setFeatureFlags(). Called once from
 * AppShell's bootstrap effect; a failed fetch is swallowed entirely, leaving getFeatureFlags()
 * on the build-time fallback rather than surfacing an error the user can't act on.
 */
export async function loadFeatureFlags(baseUrl: string, snowflakeToken = ''): Promise<void> {
  try {
    const res = await hostFetch(snowflakeToken, `${baseUrl}/api/config`)
    if (!res.ok) return
    const data: unknown = await res.json()
    if (!data || typeof data !== 'object') return

    // Hosts can deploy their static client and backend independently. Merge each known
    // boolean over the build defaults so an older backend that predates a newly added flag
    // does not make the client discard every otherwise-valid flag in the response.
    const next = { ...envDefaults() }
    const config = data as Record<string, unknown>
    for (const key of Object.keys(next) as Array<keyof FeatureFlags>) {
      if (typeof config[key] === 'boolean') {
        next[key] = config[key]
      }
    }
    setFeatureFlags(next)
    if (typeof config.defaultAgentFqn === 'string') {
      defaultAgentFqn = config.defaultAgentFqn
    }
  } catch {
    // network error, malformed JSON, etc. - keep the build-time fallback
  }
}

