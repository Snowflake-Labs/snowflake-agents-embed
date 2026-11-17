// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/** Parse a GEOGRAPHY cell: Snowflake serializes these as GeoJSON text. */
export function parseGeoValue(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined
  if (typeof value === 'object') return value as Record<string, unknown>
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed == null || typeof parsed !== 'object') return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}
