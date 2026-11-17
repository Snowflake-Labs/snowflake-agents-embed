// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { mkdtempSync, rmSync, statSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqliteKv, type SqliteKv } from './sqlite-kv'

let base: string
let dir: string
const open: SqliteKv[] = []

function mk(opts: { now?: () => number; lockTimeoutMs?: number } = {}): SqliteKv {
  const kv = openSqliteKv({ dir, lockTimeoutMs: 50, ...opts })
  open.push(kv)
  return kv
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'edge-kv-'))
  dir = join(base, 'data')
})
afterEach(() => {
  for (const kv of open.splice(0)) { try { kv.close() } catch { /* closed */ } }
  rmSync(base, { recursive: true, force: true })
})

describe('sqlite kv', () => {
  it('stores, overwrites and deletes', async () => {
    const kv = mk()
    expect(await kv.get('a')).toBeNull()
    await kv.put('a', '1')
    await kv.put('a', '2')
    expect(await kv.get('a')).toBe('2')
    await kv.delete('a')
    expect(await kv.get('a')).toBeNull()
  })

  it('expires by TTL on read and removes rows on sweep', async () => {
    let t = 1_000_000
    const kv = mk({ now: () => t })
    await kv.put('short', 's', { expirationTtl: 60 })
    await kv.put('forever', 'f')
    t += 59_000
    expect(await kv.get('short')).toBe('s')
    t += 2_000
    expect(await kv.get('short')).toBeNull()
    expect(await kv.get('forever')).toBe('f')
    expect(kv.sweep()).toBe(1)
    expect(kv.sweep()).toBe(0)
  })

  it('keeps data across a reopen', async () => {
    const kv = mk()
    await kv.put('k', 'v')
    kv.close()
    expect(await mk().get('k')).toBe('v')
  })

  it('creates the dir 0700 and the file 0600', () => {
    mk()
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'bot-links.sqlite')).mode & 0o777).toBe(0o600)
  })

  it('refuses a second opener while the first holds the lock', () => {
    mk()
    expect(() => openSqliteKv({ dir, lockTimeoutMs: 50 })).toThrow(/locked by another process/)
  })

  it('refuses a group or world accessible dir', () => {
    mk().close()
    chmodSync(dir, 0o750)
    expect(() => openSqliteKv({ dir })).toThrow(/Data directory .* mode 750/)
  })

  it('refuses a group or world readable database file', () => {
    mk().close()
    chmodSync(join(dir, 'bot-links.sqlite'), 0o644)
    expect(() => openSqliteKv({ dir })).toThrow(/Database file .* mode 644/)
  })

  it('rejects a file that is not a database', () => {
    mk().close()
    writeFileSync(join(dir, 'bot-links.sqlite'), 'not sqlite, long enough to fail the header check....')
    expect(() => openSqliteKv({ dir })).toThrow()
  })
})
