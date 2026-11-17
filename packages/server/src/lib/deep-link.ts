// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
export function buildDeepLinkServer(appId: string, threadId?: number): string {
  const context = JSON.stringify({ subEntityId: threadId ? `thread:${threadId}` : '' })
  return `https://teams.microsoft.com/l/entity/${appId}/agents-tab?context=${encodeURIComponent(context)}`
}

export function buildSigninDeepLink(appId: string, code: string): string {
  const context = JSON.stringify({ subEntityId: `signin:${code}` })
  return `https://teams.microsoft.com/l/entity/${appId}/agents-tab?context=${encodeURIComponent(context)}`
}
