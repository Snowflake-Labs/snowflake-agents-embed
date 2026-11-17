// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Returns the in-progress @-mention text right before the cursor (without the leading `@`),
 * or null when the cursor isn't inside an open mention token.
 */
export function extractMentionQuery(value: string, cursor: number): string | null {
  const upto = value.slice(0, cursor)
  const match = upto.match(/@([\w-]*)$/)
  return match ? match[1] : null
}

/** Removes the open @-mention token (its `@` and partial query) up to the cursor. */
export function removeMention(value: string, cursor: number): string {
  const upto = value.slice(0, cursor).replace(/@[\w-]*$/, '')
  return upto + value.slice(cursor)
}
