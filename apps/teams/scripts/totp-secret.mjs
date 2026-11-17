// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Resolves the dev account's Authenticator TOTP seed WITHOUT keeping it in apps/teams/.env
// (a seed next to the password defeats MFA). Order: $TEAMS_TOTP_SECRET (one-off override),
// macOS Keychain item "snowflake-agents-embed-teams-totp", then a 0600 file at
// ~/.config/snowflake-agents-embed/teams-totp-secret.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const KEYCHAIN_SERVICE = 'snowflake-agents-embed-teams-totp'
export const SECRET_FILE = join(homedir(), '.config', 'snowflake-agents-embed', 'teams-totp-secret')

export function readTotpSecret(env = process.env) {
  if (env.TEAMS_TOTP_SECRET) return env.TEAMS_TOTP_SECRET
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (out) return out
    } catch { /* not in keychain */ }
  }
  try {
    if (statSync(SECRET_FILE).mode & 0o077) {
      throw new Error(`${SECRET_FILE} must be chmod 600`)
    }
    return readFileSync(SECRET_FILE, 'utf8').trim()
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  return undefined
}
