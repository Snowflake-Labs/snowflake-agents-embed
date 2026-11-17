// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Path routing shared by every edge host. A null result means "not an edge route": the
// host serves the tab's static assets instead.

import { handleApi, type ApiEnv } from './api-proxy'
import { handleExchange, type ExchangeEnv } from './exchange'
import { handleLink, type LinkEnv } from './link'
import { canonicalizePath, isApiPath, isDeniedTokenApiPath } from './path'
import type { EdgeRuntime } from './runtime'

export type EdgeEnv = ApiEnv & ExchangeEnv & LinkEnv
export { canonicalizePath, isApiPath, isDeniedTokenApiPath } from './path'

type Handler = (request: Request, env: EdgeEnv, rt: EdgeRuntime) => Promise<Response>

const POST_ROUTES: Record<string, Handler> = {
  '/token/exchange': handleExchange,
  '/token/link': handleLink,
}

export function route(request: Request, env: EdgeEnv, rt: EdgeRuntime): Promise<Response> | null {
  const pathname = canonicalizePath(new URL(request.url).pathname)
  if (pathname === null) {
    return Promise.resolve(Response.json({ error: 'Bad request' }, { status: 400 }))
  }
  if (isDeniedTokenApiPath(pathname)) {
    return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
  }
  if (isApiPath(pathname)) return handleApi(request, env, rt)
  const handler = Object.hasOwn(POST_ROUTES, pathname) ? POST_ROUTES[pathname] : undefined
  if (!handler) return null
  if (request.method !== 'POST') {
    return Promise.resolve(
      Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } }),
    )
  }
  return handler(request, env, rt)
}
