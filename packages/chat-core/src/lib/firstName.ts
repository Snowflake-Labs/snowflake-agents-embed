// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Hosts hand us whatever name shape they have: some send a first name already,
// Teams resolves a full display name. The greeting wants a first
// name from either, while the full string still goes to the LLM date preamble.
export function firstNameOf(full?: string): string | undefined {
  const name = full?.trim()
  if (!name) return undefined

  // "Rivera, Jordan" — some directories format displayName last-name-first.
  const comma = name.indexOf(',')
  const ordered = comma >= 0 ? name.slice(comma + 1) : name

  return ordered.trim().split(/\s+/)[0] || undefined
}
