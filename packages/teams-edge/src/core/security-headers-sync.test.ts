// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { securityHeaders } from '@snowflake-agents-embed/cortex-server/http/security-headers'

describe('tab/public/_headers', () => {
  it('matches the shared security header set served by the Node edge', () => {
    const file = readFileSync(new URL('../../../tab/public/_headers', import.meta.url), 'utf8')
    const parsed: Record<string, string> = {}
    for (const line of file.split('\n').slice(1)) {
      const m = line.match(/^\s+([^:]+):\s*(.+)$/)
      if (m) parsed[m[1]] = m[2]
    }
    expect(parsed).toEqual(securityHeaders())
  })
})
