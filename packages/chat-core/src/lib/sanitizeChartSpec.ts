// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
const STRIP_KEYS = new Set(['signals', 'expr', 'signal', 'on'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksLikeUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^(https?:|data:|\/\/)/i.test(value.trim())
}

function sanitizeUsermeta(value: unknown): unknown {
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    // Vega's embedOptions can flip renderer/mode or point at a remote loader.
    if (key === 'embedOptions') continue
    out[key] = walk(child)
  }
  return out
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk)
  if (!isPlainObject(value)) return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (STRIP_KEYS.has(key)) continue
    if (key === 'usermeta') {
      out[key] = sanitizeUsermeta(child)
      continue
    }
    if (key === 'url' && looksLikeUrl(child)) continue
    if (key === 'background' && looksLikeUrl(child)) continue
    if (key === 'data' && isPlainObject(child) && looksLikeUrl(child.url)) {
      const { url: _drop, ...rest } = child
      out[key] = walk(rest)
      continue
    }
    out[key] = walk(child)
  }
  return out
}

/** Strip Vega escalation / remote-load fields from an agent-supplied chart spec. */
export function sanitizeChartSpec(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null
  return walk(raw) as Record<string, unknown>
}

export const denyAllVegaLoader = {
  load: () => Promise.reject(new Error('remote loads disabled')),
  sanitize: () => Promise.reject(new Error('remote loads disabled')),
}

/** Shared vega-embed options. `ast: true` uses vega-interpreter so charts work
 * under `script-src 'self'` (no `'unsafe-eval'`), which Teams CSP requires. */
export const VEGA_EMBED_OPTIONS = {
  actions: false,
  renderer: 'svg' as const,
  mode: 'vega-lite' as const,
  ast: true,
  loader: denyAllVegaLoader as never,
}
