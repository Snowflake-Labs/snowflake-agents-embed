// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Backend-styled Vega-Lite contract, ported from @snowflake/chart-utils
 * (`shouldSkipStyleMerge` / `resolveBackendConfig`) without the Snowsight flag —
 * embed always honors `usermeta["ui-merge"]`.
 */

export function shouldSkipStyleMerge(spec: object | null | undefined): boolean {
  if (spec == null) return false
  if (!('usermeta' in spec)) return false
  const meta = (spec as { usermeta?: unknown }).usermeta
  if (meta == null || typeof meta !== 'object') return false
  return 'ui-merge' in meta && (meta as { 'ui-merge'?: unknown })['ui-merge'] === 'none'
}

/**
 * Resolves the Vega `config` for the current color scheme when the backend
 * ships theme-aware configs:
 * - `spec.config` is the primary theme
 * - `usermeta["ui-color-scheme"]` says which theme that config was built for
 * - `usermeta["ui-config-{opposite}"]` holds the alternate
 */
export function resolveBackendConfig(
  spec: object | null | undefined,
  colorScheme: 'light' | 'dark',
): object {
  const rec = spec as Record<string, unknown> | undefined
  const meta = rec?.usermeta as Record<string, unknown> | undefined
  const specConfig = (rec?.config as object) ?? {}

  let specScheme = meta?.['ui-color-scheme'] as string | undefined
  if (!specScheme && meta) {
    if ('ui-config-dark' in meta) specScheme = 'light'
    else if ('ui-config-light' in meta) specScheme = 'dark'
  }

  if (!specScheme || specScheme === colorScheme) return specConfig
  const altKey = `ui-config-${colorScheme}`
  return (meta?.[altKey] as object) ?? specConfig
}

export function themeToColorScheme(theme: string): 'light' | 'dark' {
  return theme === 'dark' || theme === 'contrast' ? 'dark' : 'light'
}
