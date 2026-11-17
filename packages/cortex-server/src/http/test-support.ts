// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { HostBackendAdapter } from '../host/hostBackendAdapter.js'
import type { SnowflakeCredential } from '../snowflake/credential.js'

/**
 * A minimal HostBackendAdapter for route-factory tests in this directory - and the
 * third worked example (after relayCredentialResolver and forwardedTokenResolver) a
 * new host author reads to see the interface implemented. Resolves a fixed OAUTH
 * credential unconditionally; tests that need to exercise the auth-failure path
 * should build their own resolver instead of using this stub.
 */
export const STUB_HOST: HostBackendAdapter = {
  originApp: 'agents_test',
  credentials: {
    async resolve(): Promise<SnowflakeCredential> {
      return { token: 'test-token', tokenType: 'OAUTH' }
    },
  },
}
