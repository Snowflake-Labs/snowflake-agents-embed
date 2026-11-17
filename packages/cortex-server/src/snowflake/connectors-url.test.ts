// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { connectorsUrlFromAccount, mcpDisplayName } from './connectors-url.js'

describe('connectorsUrlFromAccount', () => {
  it('splits the org-account locator on the first hyphen', () => {
    expect(connectorsUrlFromAccount('myorg-myaccount'))
      .toBe('https://ai.snowflake.com/myorg/myaccount/#/capabilities/connectors')
  })

  it('falls back to the org-less connectors URL when the locator has no hyphen', () => {
    expect(connectorsUrlFromAccount('xy12345')).toBe('https://ai.snowflake.com/#/capabilities/connectors')
  })
})

describe('mcpDisplayName', () => {
  it('uses the last identifier and strips a trailing _MCP', () => {
    expect(mcpDisplayName('DEMO_DB.AGENTS.JIRA_MCP')).toBe('JIRA')
    expect(mcpDisplayName('ATLASSIAN')).toBe('ATLASSIAN')
  })
})
