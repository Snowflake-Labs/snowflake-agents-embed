// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Self-hosted edge: the same core router as the Worker, on Node.
//
// Differences from the Worker that matter for security:
//   - the request URL is rebuilt from PUBLIC_ORIGIN, so the proxy's same-origin check never
//     trusts Host or X-Forwarded-Host
//   - the caller IP comes from the socket, or from X-Forwarded-For only for the configured
//     number of trusted proxy hops
//   - the bot Connector JWT is always verified here (requireBotVerify), like the VPC Worker

import { securityHeaders } from '@snowflake-agents-embed/cortex-server/http/security-headers'
import { readFile, realpath } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { filterUpstreamResponse } from '../core/filter-headers'
import { isApiPath, route, type EdgeEnv } from '../core/router'
import type { EdgeRuntime } from '../core/runtime'

export interface NodeEdgeConfig {
  /** Browser-facing origin, e.g. https://edge.example.com. No path. */
  publicOrigin: string
  /** Built tab (packages/tab/dist). */
  tabDistRoot: string
  /** How many reverse proxies in front of this process append to X-Forwarded-For. */
  trustedProxyHops: number
  env: EdgeEnv
  upstreamFetch?: (request: Request) => Promise<Response>
}

export interface NodeEdge {
  handle(request: Request, socketIp: string | null): Promise<Response>
}

const REQUEST_DROP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'cf-connecting-ip', 'forwarded', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
])
// fetch() has already decoded the body, so these would describe bytes we no longer send.
const RESPONSE_DROP = new Set([
  'content-encoding', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate',
])

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

export function clientIpFrom(xff: string | null, hops: number, socketIp: string | null): string | null {
  if (hops > 0 && xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean)
    if (parts.length >= hops) return parts[parts.length - hops]
  }
  return socketIp
}

export function rebuildRequest(request: Request, publicOrigin: string): Request {
  const src = new URL(request.url)
  const headers = new Headers()
  for (const [k, v] of request.headers) if (!REQUEST_DROP.has(k.toLowerCase())) headers.set(k, v)
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null
  const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers }
  if (hasBody) {
    init.body = request.body
    init.duplex = 'half'
  }
  return new Request(publicOrigin + src.pathname + src.search, init)
}

function cleanResponse(res: Response): Response {
  const filtered = filterUpstreamResponse(res)
  const headers = new Headers(filtered.headers)
  // fetch() has already decoded the body; these would describe bytes we no longer send.
  for (const name of RESPONSE_DROP) headers.delete(name)
  return new Response(filtered.body, { status: filtered.status, statusText: filtered.statusText, headers })
}

async function readInside(root: string, relPath: string): Promise<{ body: Buffer; ext: string } | null> {
  let decoded: string
  try { decoded = decodeURIComponent(relPath) } catch { return null }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const candidate = join(root, decoded)
  try {
    const real = await realpath(candidate)
    if (real !== root && !real.startsWith(root + sep)) return null
    return { body: await readFile(real), ext: extname(real).toLowerCase() }
  } catch {
    return null
  }
}

function staticResponse(file: { body: Buffer; ext: string }, method: string, immutable: boolean): Response {
  return new Response(method === 'HEAD' ? null : new Uint8Array(file.body), {
    headers: {
      'content-type': MIME[file.ext] ?? 'application/octet-stream',
      'content-length': String(file.body.length),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...securityHeaders({ connectSelfOnly: true }),
    },
  })
}

const notFoundJson = () => Response.json({ error: 'Not found' }, { status: 404 })

export async function createNodeEdge(config: NodeEdgeConfig): Promise<NodeEdge> {
  const root = await realpath(config.tabDistRoot)
  const ips = new WeakMap<Request, string | null>()
  const upstream = config.upstreamFetch ?? ((r: Request) => fetch(r))
  const rt: EdgeRuntime = {
    upstreamFetch: upstream,
    clientIp: (r) => ips.get(r) ?? null,
    requireBotVerify: true,
  }

  return {
    async handle(original, socketIp) {
      const url = new URL(original.url)
      if (url.pathname === '/healthz') return new Response('ok', { headers: { 'cache-control': 'no-store' } })

      const ip = clientIpFrom(original.headers.get('x-forwarded-for'), config.trustedProxyHops, socketIp)
      const request = rebuildRequest(original, config.publicOrigin)
      ips.set(request, ip)

      const routed = await route(request, config.env, rt)
      if (routed) return cleanResponse(routed)

      // An unknown edge path must not fall through to the SPA shell.
      if (isApiPath(url.pathname) || url.pathname.startsWith('/token')) return notFoundJson()

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
      }

      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const file = await readInside(root, rel)
      if (file) {
        return staticResponse(file, request.method, rel.startsWith('assets/'))
      }
      const shell = await readInside(root, 'index.html')
      if (!shell) return new Response('Tab build missing', { status: 500 })
      return staticResponse(shell, request.method, false)
    },
  }
}
