// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Cloudflare Worker entry: the shared edge router, then the tab's static assets.
//
// wrangler.jsonc sets run_worker_first for /api and /token/*, so the SPA fallback never
// answers an edge route. Other paths reach this Worker only when no asset matches.
//
// SPCS_UPSTREAM picks how the proxy reaches SPCS:
//   public (default) — global fetch to the public ingress in SPCS_BASE
//   vpc              — the SPCS_VPC Workers VPC binding (cloudflared in the customer VPC),
//                      with SPCS_BASE set to the privatelink_ingress_url origin. The binding
//                      routes by service, so SPCS_BASE only sets the Host header and SNI.
// Anything else, or vpc without the binding, fails closed: no request is proxied.

import { route, type EdgeEnv } from '../core/router'
import { defaultRuntime, type EdgeRuntime } from '../core/runtime'

export interface WorkerEnv extends EdgeEnv {
  ASSETS: Fetcher
  SPCS_UPSTREAM?: string
  SPCS_VPC?: Fetcher
}

export function workerRuntime(env: WorkerEnv): EdgeRuntime {
  const mode = env.SPCS_UPSTREAM || 'public'
  if (mode === 'public') return defaultRuntime
  if (mode === 'vpc') {
    const vpc = env.SPCS_VPC
    if (!vpc) throw new Error('SPCS_UPSTREAM=vpc but the SPCS_VPC binding is missing')
    return {
      upstreamFetch: (request) => vpc.fetch(request),
      clientIp: defaultRuntime.clientIp,
      // The private ingress has no public hop of its own, so the edge must verify the bot.
      requireBotVerify: true,
    }
  }
  throw new Error(`Unknown SPCS_UPSTREAM "${mode}"`)
}

export default {
  async fetch(request, env) {
    let rt: EdgeRuntime
    try {
      rt = workerRuntime(env)
    } catch (err) {
      console.error('Edge misconfigured:', (err as Error).message)
      return Response.json({ error: 'Edge misconfigured' }, { status: 500 })
    }
    return (await route(request, env, rt)) ?? env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<WorkerEnv>
