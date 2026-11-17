// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as dotenvConfig } from 'dotenv'

export interface LoadDotEnvOptions {
  /** App directory relative to the repo root, e.g. 'apps/teams'. */
  appDir: string
  /** Repo root override. Tests only - defaults to the root derived from this file. */
  repoRoot?: string
}

/**
 * Load `<repo root>/<appDir>/.env` for local development.
 *
 * In SPCS the values arrive as injected container environment variables and no
 * .env file exists, so a missing file is not an error. Existing environment
 * variables always win - dotenv does not override them.
 *
 * A leftover root `.env` is never loaded; it only triggers a warning so a
 * pre-split install fails loudly instead of silently reading the wrong file.
 */
export function loadDotEnv({ appDir, repoRoot }: LoadDotEnvOptions): void {
  // src/config -> src -> packages/cortex-server -> packages -> repo root. This
  // module is always consumed as source (the package has no build step), so the
  // root is derived from here rather than from a host's dist/.
  const root = repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const appEnv = resolve(root, appDir, '.env')
  if (existsSync(appEnv)) {
    dotenvConfig({ path: appEnv })
    return
  }
  if (existsSync(resolve(root, '.env'))) {
    console.warn(
      `[env] Found a repo-root .env but no ${appDir}/.env. Per-app env files replaced the root ` +
        `.env; copy ${appDir}/.env.example to ${appDir}/.env and fill it in.`,
    )
  }
}
