// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { createRemoteJWKSet } from 'jose'
import {
  entraJwksUrl,
  validateEntraToken as validate,
  type EntraPayload,
} from '@snowflake-agents-embed/cortex-server/auth/entra-token'
import type { Config } from '../config.js'

export type { EntraPayload }

export function createEntraValidator(config: Config) {
  if (config.authMode === 'local-pat') return null

  const JWKS = createRemoteJWKSet(config.jwksUri ? new URL(config.jwksUri) : entraJwksUrl(config.tenantId!))

  return (token: string): Promise<EntraPayload> =>
    validate(token, JWKS, {
      tenantId: config.tenantId!,
      oboClientId: config.oboClientId,
      audienceUri: config.entraAudienceUri,
      requiredScope: config.entraRequiredScope,
      allowedClientIds: config.entraAllowedClientIds,
    })
}
