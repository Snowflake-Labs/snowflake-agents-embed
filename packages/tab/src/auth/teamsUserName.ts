// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Resolving the signed-in user's name in a Teams tab, for the empty-state greeting and
// the LLM date preamble.
//
// `context.user.displayName` is the obvious source but the Teams tab host frequently
// leaves it undefined — `userPrincipalName` / `loginHint` are the reliably-populated
// fields — so this walks a fallback chain instead of trusting any single one.
//
// Reading claims out of the Entra token without verifying it is fine *here* because the
// use is display-only: the edge (packages/teams-edge/src/core/exchange.ts) still verifies the same
// token's signature, issuer, and audience before any auth decision is made with it.

interface EntraClaims {
  name?: string
  given_name?: string
  preferred_username?: string
  upn?: string
}

export function decodeJwtPayload(token?: string): EntraClaims | undefined {
  const segment = token?.split('.')[1]
  if (!segment) return undefined
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    const claims = JSON.parse(json)
    return claims && typeof claims === 'object' ? (claims as EntraClaims) : undefined
  } catch {
    return undefined
  }
}

/** "jane.doe@example.com" -> "Jane Doe". Last resort — a UPN is all some tenants give. */
export function nameFromUpn(upn?: string): string | undefined {
  const local = upn?.trim().split('@')[0]
  if (!local) return undefined
  const words = local
    .split(/[._-]+/)
    .filter((part) => part.length > 0 && !/^\d+$/.test(part))
    .map((part) => part[0].toUpperCase() + part.slice(1))
  return words.length > 0 ? words.join(' ') : undefined
}

export function nameFromEntraToken(token?: string): string | undefined {
  const claims = decodeJwtPayload(token)
  if (!claims) return undefined
  return (
    claims.name?.trim() ||
    claims.given_name?.trim() ||
    nameFromUpn(claims.preferred_username ?? claims.upn)
  )
}

export interface UserNameSources {
  /** microsoftTeams.app.getContext().user.displayName */
  displayName?: string
  /** microsoftTeams.app.getContext().user.userPrincipalName */
  userPrincipalName?: string
  /** microsoftTeams.app.getContext().user.loginHint */
  loginHint?: string
  /** Name already derived from the Entra SSO token via nameFromEntraToken. */
  tokenName?: string
}

/**
 * Fullest name available, preferring host-provided over token-derived. The greeting trims
 * it to a first name itself (chat-core's firstNameOf), so full names are preferred here.
 */
export function resolveUserName(sources: UserNameSources): string | undefined {
  return (
    sources.displayName?.trim() ||
    sources.tokenName?.trim() ||
    nameFromUpn(sources.userPrincipalName ?? sources.loginHint)
  )
}
