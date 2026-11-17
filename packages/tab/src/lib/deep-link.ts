// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
export function buildDeepLink(appId: string, threadId?: number): string {
  const context = JSON.stringify({ subEntityId: threadId ? `thread:${threadId}` : '' })
  return `https://teams.microsoft.com/l/entity/${appId}/agents-tab?context=${encodeURIComponent(context)}`
}
