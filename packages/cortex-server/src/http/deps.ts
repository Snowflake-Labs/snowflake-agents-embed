// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CortexRuntimeConfig } from '../config/runtime.js'
import type { HostBackendAdapter } from '../host/hostBackendAdapter.js'

/**
 * What every shared route factory in this directory needs to register itself: the
 * config fields common to any Cortex-fronting host, and the seam
 * (assertHostBackendAdapter'd once at boot) that supplies the host-specific
 * origin_application tag and credential resolution.
 */
export interface CortexRouteDeps {
  readonly config: CortexRuntimeConfig
  readonly host: HostBackendAdapter
}
