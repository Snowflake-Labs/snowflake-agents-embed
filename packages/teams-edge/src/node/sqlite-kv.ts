// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// KvLike over a local SQLite file, for the self-hosted Node edge (single replica).
//
// The values are already sealed with BOT_LINK_SECRET by bot-link.ts; this layer adds file
// hygiene so the store is no easier to read than the secret it protects:
//   - refuses to run as root, and refuses a data dir or DB file that is group/world
//     accessible or owned by another user (it never repairs permissions silently)
//   - creates the dir 0700 and the file 0600
//   - locking_mode=EXCLUSIVE, so a second replica on the same volume fails at startup
//     instead of silently splitting the link store

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import type { KvLike } from '../core/bot-link'

// Vite's resolver does not know node:sqlite yet, so load it at runtime.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType }

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000

export interface SqliteKvOptions {
  /** Directory that holds (or will hold) the database. */
  dir: string
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number
  /** Milliseconds to wait for the file lock before failing at startup. */
  lockTimeoutMs?: number
}

export interface SqliteKv extends KvLike {
  /** Deletes expired rows and returns how many were removed. */
  sweep(): number
  close(): void
}

function assertPrivate(path: string, what: string, uid: number | undefined): void {
  const st = statSync(path)
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`${what} ${path} is owned by uid ${st.uid}, not the running user (${uid})`)
  }
  if ((st.mode & 0o077) !== 0) {
    const mode = (st.mode & 0o777).toString(8).padStart(3, '0')
    throw new Error(`${what} ${path} has mode ${mode}; it must not be group or world accessible (chmod ${what === 'Data directory' ? '700' : '600'})`)
  }
}

export function openSqliteKv(opts: SqliteKvOptions): SqliteKv {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid === 0) throw new Error('Refusing to run the bot-link store as root')
  const now = opts.now ?? Date.now

  if (!existsSync(opts.dir)) mkdirSync(opts.dir, { recursive: true, mode: 0o700 })
  assertPrivate(opts.dir, 'Data directory', uid)

  const file = join(opts.dir, 'bot-links.sqlite')
  if (existsSync(file)) {
    assertPrivate(file, 'Database file', uid)
  } else {
    // Create it 0600 before SQLite does; the -wal/-shm files copy the main file's mode.
    closeSync(openSync(file, 'a', 0o600))
    chmodSync(file, 0o600)
  }

  const db = new DatabaseSync(file)
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.lockTimeoutMs ?? 1000))}`)
    // locking_mode must be set before the journal mode so WAL runs without shared memory.
    db.exec('PRAGMA locking_mode = EXCLUSIVE')
    db.exec('PRAGMA journal_mode = WAL')
    // Taking a write lock now makes a second process fail here, not on its first request.
    db.exec('BEGIN EXCLUSIVE')
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER) WITHOUT ROWID')
    db.exec('COMMIT')
  } catch (err) {
    try { db.close() } catch { /* already unusable */ }
    const msg = (err as Error).message
    if (/locked|busy/i.test(msg)) {
      throw new Error(`Bot-link database ${file} is locked by another process. Run a single edge replica per data volume.`)
    }
    throw err
  }

  const nowS = () => Math.floor(now() / 1000)
  const getStmt = db.prepare('SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)')
  const putStmt = db.prepare(
    'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
  )
  const delStmt = db.prepare('DELETE FROM kv WHERE key = ?')
  const sweepStmt = db.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?')

  const sweep = (): number => Number(sweepStmt.run(nowS()).changes)
  sweep()
  const timer = setInterval(() => {
    try { sweep() } catch (err) { console.error('bot-link sweep failed:', (err as Error).message) }
  }, SWEEP_INTERVAL_MS)
  timer.unref()

  return {
    async get(key) {
      const row = getStmt.get(key, nowS()) as { value: string } | undefined
      return row ? row.value : null
    },
    async put(key, value, o) {
      const ttl = o?.expirationTtl
      putStmt.run(key, value, ttl && ttl > 0 ? nowS() + Math.ceil(ttl) : null)
    },
    async delete(key) {
      delStmt.run(key)
    },
    sweep,
    close() {
      clearInterval(timer)
      db.close()
    },
  }
}
