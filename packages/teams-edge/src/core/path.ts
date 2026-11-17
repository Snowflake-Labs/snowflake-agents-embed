// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Decode, lowercase, collapse slashes, strip a trailing slash. A decode failure
 * (invalid % sequence, or still-encoded after three rounds) returns null so the
 * caller can 400 rather than route an ambiguous path.
 */
export function canonicalizePath(pathname: string): string | null {
  try {
    let p = pathname
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(p)
      if (next === p) break
      p = next
      if (i === 2 && next !== decodeURIComponent(next)) return null
    }
    p = p.toLowerCase().replace(/\/+/g, '/')
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
    return p
  } catch {
    return null
  }
}

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

/** The edge serves /token/exchange itself; nothing under /api/token may reach SPCS. */
export function isDeniedTokenApiPath(pathname: string): boolean {
  return pathname === '/api/token' || pathname.startsWith('/api/token/')
}
