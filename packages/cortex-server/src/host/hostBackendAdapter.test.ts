// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { assertHostBackendAdapter, type HostBackendAdapter } from './hostBackendAdapter.js'

function adapter(originApp: string): HostBackendAdapter {
  return { originApp, credentials: { resolve: async () => ({ token: 't', tokenType: 'OAUTH' }) } }
}

describe('assertHostBackendAdapter', () => {
  it('accepts an originApp at exactly 16 bytes', () => {
    expect(() => assertHostBackendAdapter(adapter('cowork_16bytes!!'))).not.toThrow()
  })

  it('accepts the two existing hosts', () => {
    expect(() => assertHostBackendAdapter(adapter('agents_sfdc'))).not.toThrow()
    expect(() => assertHostBackendAdapter(adapter('agents_teams'))).not.toThrow()
  })

  it('rejects an originApp over 16 bytes, naming the byte count', () => {
    // 'cowork_salesforce' is the real-world case that motivated this check - Cortex
    // rejected it with HTTP 400 / code 390400 before it was shortened to agents_sfdc.
    expect(() => assertHostBackendAdapter(adapter('cowork_salesforce'))).toThrow(/17 bytes/)
  })

  it('counts UTF-8 bytes, not characters, so multi-byte originApps are caught too', () => {
    // 8 characters, but each multi-byte code point pushes the byte count well past 16.
    expect(() => assertHostBackendAdapter(adapter('日本語日本語日本語'))).toThrow(/bytes/)
  })
})
