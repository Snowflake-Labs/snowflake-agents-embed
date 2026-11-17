// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { EdgeEnv } from '../core/router'
import type { KvLike } from '../core/bot-link'

export interface NodeConfig {
  publicOrigin: string
  tabDistRoot: string
  dataDir: string
  port: number
  host: string
  trustedProxyHops: number
  env: Omit<EdgeEnv, 'BOT_LINKS'>
}

type Source = Record<string, string | undefined>

const REQUIRED = ['SPCS_BASE', 'SPCS_PAT', 'EDGE_SESSION_SECRET', 'BOT_APP_ID', 'BOT_LINK_SECRET'] as const

export function loadNodeConfig(src: Source): NodeConfig {
  const missing = REQUIRED.filter((k) => !src[k])
  const raw = src.PUBLIC_ORIGIN
  if (!raw) missing.unshift('PUBLIC_ORIGIN' as never)
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(', ')}`)

  let origin: URL
  try { origin = new URL(raw as string) } catch { throw new Error('PUBLIC_ORIGIN must be an absolute URL') }
  const isLocal = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1'
  if (origin.protocol !== 'https:' && !(isLocal && origin.protocol === 'http:')) {
    throw new Error('PUBLIC_ORIGIN must be https (http is allowed only for localhost)')
  }
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username) {
    throw new Error('PUBLIC_ORIGIN must be an origin only, with no path, query or credentials')
  }

  const hops = Number(src.TRUSTED_PROXY_HOPS ?? '0')
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) throw new Error('TRUSTED_PROXY_HOPS must be an integer from 0 to 10')
  const port = Number(src.PORT ?? '8080')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1-65535')

  const e = src as Record<string, string>
  return {
    publicOrigin: origin.origin,
    tabDistRoot: src.TAB_DIST_ROOT || '/app/dist',
    dataDir: src.DATA_DIR || '/data',
    port,
    host: src.HOST || '0.0.0.0',
    trustedProxyHops: hops,
    env: {
      SPCS_BASE: e.SPCS_BASE,
      SPCS_PAT: e.SPCS_PAT,
      EDGE_SESSION_SECRET: e.EDGE_SESSION_SECRET,
      BOT_LINK_SECRET: e.BOT_LINK_SECRET,
      BOT_APP_ID: e.BOT_APP_ID,
      ALLOWED_ORIGIN: src.ALLOWED_ORIGIN,
      AZURE_TENANT_ID: e.AZURE_TENANT_ID,
      OBO_CLIENT_ID: e.OBO_CLIENT_ID,
      OBO_CLIENT_SECRET: e.OBO_CLIENT_SECRET,
      SNOWFLAKE_SCOPE: e.SNOWFLAKE_SCOPE,
      ENTRA_AUDIENCE_URI: src.ENTRA_AUDIENCE_URI,
      ENTRA_ALLOWED_CLIENT_IDS: src.ENTRA_ALLOWED_CLIENT_IDS,
      ENTRA_REQUIRED_SCOPE: src.ENTRA_REQUIRED_SCOPE,
    } as Omit<EdgeEnv, 'BOT_LINKS'>,
  }
}

export type { KvLike }
