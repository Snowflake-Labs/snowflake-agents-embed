// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/** Headers that may be forwarded from SPCS to the browser. Everything else is dropped. */
export const RESPONSE_ALLOW = new Set([
  'content-type',
  'cache-control',
  'content-length',
  'x-accel-buffering',
  'retry-after',
  'x-request-id',
])

export function filterResponseHeaders(headers: Headers): Headers {
  const out = new Headers()
  for (const [k, v] of headers) {
    if (RESPONSE_ALLOW.has(k.toLowerCase())) out.append(k, v)
  }
  return out
}

export function filterUpstreamResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: filterResponseHeaders(response.headers),
  })
}
