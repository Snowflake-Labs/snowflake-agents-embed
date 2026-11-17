// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'

export const DEFAULT_ENTRA_SCOPE = 'access_as_user'
// Microsoft's published Teams client app IDs (the same for every tenant), listed at
// https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/authentication/tab-sso-register-aad
// Pre-authorize both on the Entra API app.
export const TEAMS_DESKTOP_MOBILE_CLIENT_ID = '1fec8e78-bce4-4aaf-ab1b-5451cc387264'
export const TEAMS_WEB_CLIENT_ID = '5e3ce6c0-2b1f-4285-8d4b-75ee78787346'
export const DEFAULT_ALLOWED_CLIENT_IDS = [
  TEAMS_DESKTOP_MOBILE_CLIENT_ID,
  TEAMS_WEB_CLIENT_ID,
] as const

const MAX_TOKEN_AGE_S = 7200

export type EntraPayload = JWTPayload & { upn?: string; unique_name?: string }

export interface EntraValidationOptions {
  tenantId: string
  oboClientId: string
  audienceUri?: string
  requiredScope?: string
  allowedClientIds?: readonly string[]
}

export function entraJwksUrl(tenantId: string): URL {
  return new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)
}

export function parseClientIdList(raw: string | undefined): string[] | undefined {
  const ids = (raw ?? '').split(/[\s,]+/).filter(Boolean)
  return ids.length ? ids : undefined
}

/**
 * Validates a Teams SSO token: signature, tenant issuer (v1 + v2), audience, age, and
 * that it was issued for the `access_as_user` scope to a known Teams client. The one
 * implementation shared by the Pages edge (token/exchange) and the container server.
 */
export async function validateEntraToken(
  token: string,
  jwks: JWTVerifyGetKey,
  opts: EntraValidationOptions,
): Promise<EntraPayload> {
  const audience = [opts.oboClientId, opts.audienceUri].filter((a): a is string => Boolean(a))
  const { payload } = await jwtVerify(token, jwks, {
    issuer: [
      `https://login.microsoftonline.com/${opts.tenantId}/v2.0`,
      `https://sts.windows.net/${opts.tenantId}/`,
    ],
    audience,
    algorithms: ['RS256'],
    maxTokenAge: MAX_TOKEN_AGE_S,
  })

  const scope = opts.requiredScope ?? DEFAULT_ENTRA_SCOPE
  const scopes = typeof payload.scp === 'string' ? payload.scp.split(/\s+/) : []
  if (!scopes.includes(scope)) throw new Error(`token lacks required scope ${scope}`)

  const allowed = opts.allowedClientIds ?? DEFAULT_ALLOWED_CLIENT_IDS
  const client = typeof payload.azp === 'string' ? payload.azp : typeof payload.appid === 'string' ? payload.appid : ''
  if (!client || !allowed.includes(client)) throw new Error('token was issued to an unrecognized client')

  return payload as EntraPayload
}
