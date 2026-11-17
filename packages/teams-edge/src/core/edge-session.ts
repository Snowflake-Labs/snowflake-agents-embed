// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { EncryptJWT, jwtDecrypt } from 'jose'

export const EDGE_SESSION_HEADER = 'X-Edge-Session'
export const EDGE_SESSION_MAX_TTL_S = 3600
const TOKEN_SKEW_S = 30

const ISSUER = 'agents-embed-teams-edge'

export interface EdgeSessionClaims {
  tid: string
  oid: string
  /** The user's Snowflake OAuth token. Only ever readable by the edge: the session is encrypted. */
  snowflakeToken: string
}

const MIN_SECRET_BYTES = 32

/** HKDF-SHA256 with a purpose-specific info string, so the key is never reusable for another purpose. */
async function key(secret: string): Promise<Uint8Array> {
  const enc = new TextEncoder()
  if (enc.encode(secret).byteLength < MIN_SECRET_BYTES) {
    throw new Error('EDGE_SESSION_SECRET must be at least 32 bytes')
  }
  const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('agents-embed-teams-edge'), info: enc.encode('edge-session/v1') },
    ikm,
    256,
  )
  return new Uint8Array(bits)
}

/** Session lifetime: an hour, but never outliving the Snowflake token it carries. */
export function edgeSessionTtlS(tokenExpiresInS: number): number {
  return Math.max(1, Math.min(EDGE_SESSION_MAX_TTL_S, Math.floor(tokenExpiresInS) - TOKEN_SKEW_S))
}

/**
 * Encrypted (JWE, dir + A256GCM) rather than merely signed, so the browser can hold the
 * session as an opaque bearer handle while the Snowflake token inside stays server-side.
 */
export async function signEdgeSession(
  claims: EdgeSessionClaims,
  secret: string,
  ttlS: number = EDGE_SESSION_MAX_TTL_S,
): Promise<string> {
  return new EncryptJWT({ tid: claims.tid, oid: claims.oid, sft: claims.snowflakeToken })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlS}s`)
    .encrypt(await key(secret))
}

export async function openEdgeSession(token: string, secret: string): Promise<EdgeSessionClaims | null> {
  try {
    const { payload } = await jwtDecrypt(token, await key(secret), {
      issuer: ISSUER,
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    })
    if (typeof payload.sft !== 'string' || !payload.sft) return null
    return { tid: String(payload.tid ?? ''), oid: String(payload.oid ?? ''), snowflakeToken: payload.sft }
  } catch {
    return null
  }
}
