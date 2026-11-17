// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// What differs between edge hosts (Cloudflare Worker, self-hosted Node), injected into the
// shared handlers. Everything else, including every security check, lives in the core.

export interface EdgeRuntime {
  /**
   * Sends a request to the SPCS ingress, and only there. Entra, JWKS and OBO calls always
   * use the global fetch, so a private upstream (Workers VPC) never carries them.
   */
  upstreamFetch(request: Request): Promise<Response>
  /** The caller's IP for rate limits and X-Agents-Client-Ip, or null if unknown. */
  clientIp(request: Request): string | null
  /**
   * Verify the Bot Connector JWT at the edge even when bot links are off. Set for a
   * private ingress, where the edge is the only public hop in front of the PAT.
   */
  requireBotVerify: boolean
}

// Cloudflare's public path: global fetch and the CF-set client IP header.
export const defaultRuntime: EdgeRuntime = {
  upstreamFetch: (request) => fetch(request),
  clientIp: (request) => request.headers.get('CF-Connecting-IP'),
  requireBotVerify: true,
}
