// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Native CoWork's connectors page. SNOWFLAKE_ACCOUNT is the org-account form
 * (`myorg-myaccount`); the first hyphen splits org from account. When
 * that split is missing, fall back to the org-less hash so a session that
 * already has an account still lands on connectors.
 */
export function connectorsUrlFromAccount(account: string): string {
  const trimmed = account.trim()
  const i = trimmed.indexOf('-')
  if (i <= 0 || i === trimmed.length - 1) {
    return 'https://ai.snowflake.com/#/capabilities/connectors'
  }
  const org = trimmed.slice(0, i)
  const acct = trimmed.slice(i + 1)
  return `https://ai.snowflake.com/${encodeURIComponent(org)}/${encodeURIComponent(acct)}/#/capabilities/connectors`
}

/** Last identifier, `_MCP` stripped — matches native CoWork's JIRA_MCP → JIRA label. */
export function mcpDisplayName(fqn: string): string {
  const last = fqn.split('.').pop() ?? fqn
  return last.replace(/_MCP$/i, '')
}
