// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { SnowflakeCredentialResolver } from './credentialResolver.js'

// Cortex rejects an origin_application longer than this with HTTP 400 / code
// 390400: "Origin application name cannot be longer than 16 bytes, provided N
// bytes." Verified 2026-07-25 - see packages/relay/src/routes/threads.ts, whose
// original 'cowork_salesforce' (17 bytes) was rejected before being shortened.
const MAX_ORIGIN_APP_BYTES = 16

/**
 * The seam a host backend implements to compose the shared route factories -
 * the server-side counterpart to chat-core's HostAdapter. Each host constructs
 * one of these directly in its own index.ts; there is no registry or plugin
 * loader, deliberately (see cortex-server/README.md).
 */
export interface HostBackendAdapter {
  /** Tag applied to every thread this host creates, so different hosts' history can be
   *  told apart (and merged) later. MUST be 16 bytes or fewer - see assertHostBackendAdapter. */
  readonly originApp: string
  readonly credentials: SnowflakeCredentialResolver
}

/** Runtime guard for the 16-byte origin_application limit - call this once at boot. */
export function assertHostBackendAdapter(host: HostBackendAdapter): void {
  const bytes = Buffer.byteLength(host.originApp, 'utf8')
  if (bytes > MAX_ORIGIN_APP_BYTES) {
    throw new Error(
      `HostBackendAdapter.originApp "${host.originApp}" is ${bytes} bytes, but Cortex's ` +
        `origin_application is capped at ${MAX_ORIGIN_APP_BYTES} bytes (HTTP 400 / code 390400).`,
    )
  }
}
