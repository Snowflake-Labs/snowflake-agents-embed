// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Context } from 'hono'
import type { SnowflakeCredential } from '../snowflake/credential.js'

export interface CredentialFailure {
  readonly error: string
  readonly status: 401 | 403
}

export interface SnowflakeCredentialResolver {
  /**
   * Resolve the caller's Snowflake credential from the request. Async so a host can
   * perform a token exchange right here - a bot-style integration whose events arrive
   * with no prior browser handshake needs exactly this, not a sync header read.
   */
  resolve(c: Context): Promise<SnowflakeCredential | CredentialFailure>
}

export function isCredentialFailure(
  v: SnowflakeCredential | CredentialFailure,
): v is CredentialFailure {
  return 'error' in v
}
