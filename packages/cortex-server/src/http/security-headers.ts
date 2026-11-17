// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// X-Frame-Options is deliberately absent: the tab is framed by Teams, so framing is
// restricted with CSP frame-ancestors instead.
export const TEAMS_FRAME_ANCESTORS =
  'frame-ancestors https://teams.microsoft.com https://*.teams.microsoft.com https://outlook.office.com https://*.office.com https://*.cloud.microsoft'

const TAB_CSP = [
  TEAMS_FRAME_ANCESTORS,
  "script-src 'self'",
  "connect-src 'self' https://login.microsoftonline.com https://*.microsoftonline.com https://teams.microsoft.com https://*.teams.microsoft.com https://*.office.com",
  "object-src 'none'",
].join('; ')

export function securityHeaders(_opts: { connectSelfOnly?: boolean } = {}): Record<string, string> {
  return {
    'Content-Security-Policy': TAB_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  }
}
