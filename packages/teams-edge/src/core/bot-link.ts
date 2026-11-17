// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Per-user identity for the Teams bot, held at the edge.
//
// The bot has no Teams SSO token, so a user links once through the tab (see token/link.ts).
// The edge then keeps an encrypted Entra refresh token in KV and injects a fresh Snowflake
// token on each bot turn. The SPCS server never sees oid/tid or a refresh token.

import { EncryptJWT, createRemoteJWKSet, jwtDecrypt, jwtVerify } from 'jose'
import { refreshSnowflakeToken, type OboEnv } from './obo'

export const LINK_CODE_TTL_S = 600
export const LINK_TTL_S = 60 * 60 * 24 * 90
const ACCESS_SKEW_S = 120

const LINK_ISSUER = 'agents-embed-teams-link'
const CODE_ISSUER = 'agents-embed-teams-link-code'
const BOT_ISSUER = 'https://api.botframework.com'
const BOT_JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys'

export interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface BotLinkEnv extends Partial<OboEnv> {
  BOT_LINKS?: KvLike
  BOT_LINK_SECRET?: string
  BOT_APP_ID?: string
}

export interface LinkRecord {
  /** Entra refresh token. */
  rt: string
  /** Cached Snowflake access token. */
  at: string
  /** Access-token expiry, epoch seconds. */
  atExp: number
}

const MIN_SECRET_BYTES = 32

async function keyHkdf(secret: string): Promise<Uint8Array> {
  const enc = new TextEncoder()
  if (enc.encode(secret).byteLength < MIN_SECRET_BYTES) {
    throw new Error('BOT_LINK_SECRET must be at least 32 bytes')
  }
  const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('agents-embed-teams-bot-link'), info: enc.encode('bot-link/v1') },
    ikm,
    256,
  )
  return new Uint8Array(bits)
}

// TODO(2027-01-10): remove SHA-256 fallback
async function keyLegacy(secret: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
}

export const linkKey = (tid: string, oid: string) => `link:${tid}:${oid}`
export const jtiKey = (jti: string) => `jti:${jti}`

// ---- sign-in codes (stateless, identity-bound) ----

export async function mintLinkCode(tid: string, oid: string, secret: string): Promise<string> {
  return new EncryptJWT({ tid, oid })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(CODE_ISSUER)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${LINK_CODE_TTL_S}s`)
    .encrypt(await keyHkdf(secret))
}

export async function openLinkCode(
  code: string,
  secret: string,
): Promise<{ tid: string; oid: string; jti: string } | null> {
  for (const derive of [keyHkdf, keyLegacy]) {
    try {
      const { payload } = await jwtDecrypt(code, await derive(secret), {
        issuer: CODE_ISSUER,
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256GCM'],
      })
      if (!payload.jti || typeof payload.tid !== 'string' || typeof payload.oid !== 'string') return null
      return { tid: payload.tid, oid: payload.oid, jti: payload.jti }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Marks a code used. KV is eventually consistent and has no compare-and-set, so
 * cross-isolate consume is still best-effort; the code is also identity-bound and
 * expires in minutes. The in-isolate set closes a same-isolate get-then-put race.
 */
const inflightJtis = new Set<string>()

export async function consumeJti(kv: KvLike, jti: string): Promise<boolean> {
  if (inflightJtis.has(jti)) return false
  inflightJtis.add(jti)
  try {
    if (await kv.get(jtiKey(jti))) return false
    await kv.put(jtiKey(jti), '1', { expirationTtl: LINK_CODE_TTL_S + 60 })
    return true
  } finally {
    inflightJtis.delete(jti)
  }
}

// ---- stored link ----

export async function sealLink(record: LinkRecord, secret: string, tid: string, oid: string): Promise<string> {
  return new EncryptJWT({ rt: record.rt, at: record.at, atExp: record.atExp, tid, oid })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(LINK_ISSUER)
    .setIssuedAt()
    .encrypt(await keyHkdf(secret))
}

/** @deprecated SHA-256 key; only for dual-read tests until 2027-01-10. */
export async function sealLinkLegacy(record: LinkRecord, secret: string): Promise<string> {
  return new EncryptJWT({ rt: record.rt, at: record.at, atExp: record.atExp })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(LINK_ISSUER)
    .setIssuedAt()
    .encrypt(await keyLegacy(secret))
}

async function decryptLink(
  sealed: string,
  secret: string,
  derive: (s: string) => Promise<Uint8Array>,
): Promise<LinkRecord & { tid?: string; oid?: string } | null> {
  try {
    const { payload } = await jwtDecrypt(sealed, await derive(secret), {
      issuer: LINK_ISSUER,
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    })
    if (typeof payload.rt !== 'string' || typeof payload.at !== 'string' || typeof payload.atExp !== 'number') {
      return null
    }
    return {
      rt: payload.rt,
      at: payload.at,
      atExp: payload.atExp,
      tid: typeof payload.tid === 'string' ? payload.tid : undefined,
      oid: typeof payload.oid === 'string' ? payload.oid : undefined,
    }
  } catch {
    return null
  }
}

export async function openLink(
  sealed: string,
  secret: string,
  tid: string,
  oid: string,
): Promise<LinkRecord | null> {
  const hkdf = await decryptLink(sealed, secret, keyHkdf)
  if (hkdf) {
    if (hkdf.tid !== tid || hkdf.oid !== oid) return null
    return { rt: hkdf.rt, at: hkdf.at, atExp: hkdf.atExp }
  }
  const legacy = await decryptLink(sealed, secret, keyLegacy)
  if (!legacy) return null
  if (legacy.tid !== undefined || legacy.oid !== undefined) {
    if (legacy.tid !== tid || legacy.oid !== oid) return null
  }
  return { rt: legacy.rt, at: legacy.at, atExp: legacy.atExp }
}

export async function saveLink(kv: KvLike, tid: string, oid: string, record: LinkRecord, secret: string) {
  await kv.put(linkKey(tid, oid), await sealLink(record, secret, tid, oid), { expirationTtl: LINK_TTL_S })
}

export type LinkedToken = { linked: true; token: string } | { linked: false }

/**
 * Returns a valid Snowflake token for a linked user, refreshing (and rotating the stored
 * refresh token) when the cached one is near expiry. A permanent Entra rejection
 * (revoked, expired, password change) unlinks; a transient failure surfaces to the caller
 * so the user is not told to re-link because of an Entra blip.
 */
export async function getLinkedToken(
  kv: KvLike,
  tid: string,
  oid: string,
  secret: string,
  oboEnv: OboEnv,
  nowS = Math.floor(Date.now() / 1000),
): Promise<LinkedToken> {
  const sealed = await kv.get(linkKey(tid, oid))
  if (!sealed) return { linked: false }
  const record = await openLink(sealed, secret, tid, oid)
  if (!record) {
    await kv.delete(linkKey(tid, oid))
    return { linked: false }
  }
  // Re-seal with HKDF + tid/oid when the stored blob was minted with the legacy key.
  if (!(await decryptLink(sealed, secret, keyHkdf))) {
    await saveLink(kv, tid, oid, record, secret)
  }
  if (record.atExp - ACCESS_SKEW_S > nowS) return { linked: true, token: record.at }

  try {
    const result = await refreshSnowflakeToken(record.rt, oboEnv)
    await saveLink(
      kv,
      tid,
      oid,
      { rt: result.refreshToken ?? record.rt, at: result.snowflakeToken, atExp: nowS + result.expiresIn },
      secret,
    )
    return { linked: true, token: result.snowflakeToken }
  } catch (err: any) {
    if (err?.permanent) {
      await kv.delete(linkKey(tid, oid))
      return { linked: false }
    }
    throw err
  }
}

// ---- Bot Framework inbound JWT ----

let botJwks: ReturnType<typeof createRemoteJWKSet> | undefined

export interface BotIdentity {
  tid: string
  oid: string
}

// Reason only, never the token or headers: a silent 401 hid the iat bug for a whole install.
function rejectBot(reason: string): null {
  console.error(`bot request rejected: ${reason}`)
  return null
}

/**
 * Verifies the Bot Framework token before trusting `aadObjectId` from the body. The
 * container re-verifies the same token; this check exists so the edge never looks up (or
 * mints a code for) an identity an attacker merely claimed in the activity.
 */
export async function verifyBotRequest(
  authorization: string,
  appId: string,
  activity: any,
): Promise<BotIdentity | null> {
  try {
    botJwks ??= createRemoteJWKSet(new URL(BOT_JWKS_URL))
    const token = authorization.replace(/^Bearer\s+/i, '')
    const { payload } = await jwtVerify(token, botJwks, {
      issuer: BOT_ISSUER,
      audience: appId,
      // Bot Connector tokens carry exp/nbf but no iat, so maxTokenAge (which requires iat) rejects all of them.
      algorithms: ['RS256'],
    })
    const claimed = payload.serviceurl
    if (typeof claimed !== 'string' || !claimed) return rejectBot('token has no serviceurl claim')
    if (!activity?.serviceUrl || claimed !== activity.serviceUrl) return rejectBot('serviceurl claim does not match activity')
    const oid = activity?.from?.aadObjectId
    const tid = activity?.channelData?.tenant?.id
    if (typeof oid !== 'string' || !oid || typeof tid !== 'string' || !tid) {
      return rejectBot('activity has no from.aadObjectId or channelData.tenant.id')
    }
    return { tid, oid }
  } catch (err) {
    const e = err as { code?: unknown; name?: unknown }
    return rejectBot(`jwt verification failed: ${String(e?.code ?? e?.name ?? 'unknown')}`)
  }
}
