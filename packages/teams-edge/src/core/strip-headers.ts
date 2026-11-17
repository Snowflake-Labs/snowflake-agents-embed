// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Request headers the edge may copy from the client onto the SPCS call.
 * Everything else is dropped; the proxy then attaches Authorization (PAT),
 * X-User-Access-Token, X-Bot-Auth and X-Agents-Client-Ip itself.
 */
export const REQUEST_ALLOW = new Set([
  'content-type',
  'accept',
  'accept-language',
  'x-request-id',
])

/** @deprecated Use REQUEST_ALLOW. Kept so older imports fail loudly in tests we update. */
export const STRIP_HEADERS = new Set([
  'cookie',
  'host',
  'x-forwarded-for',
  'x-agents-client-ip',
  'x-bot-auth',
  'x-edge-session',
  'forwarded',
])
