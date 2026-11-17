// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDotEnv } from './load-env.js'

const KEY = 'LOAD_ENV_TEST_VALUE'

describe('loadDotEnv', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'load-env-'))
    mkdirSync(join(root, 'apps', 'teams'), { recursive: true })
    delete process.env[KEY]
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    delete process.env[KEY]
    vi.restoreAllMocks()
  })

  it('loads <appDir>/.env', () => {
    writeFileSync(join(root, 'apps', 'teams', '.env'), `${KEY}=from-app\n`)
    loadDotEnv({ appDir: 'apps/teams', repoRoot: root })
    expect(process.env[KEY]).toBe('from-app')
  })

  it('does not override variables that are already set', () => {
    process.env[KEY] = 'from-container'
    writeFileSync(join(root, 'apps', 'teams', '.env'), `${KEY}=from-app\n`)
    loadDotEnv({ appDir: 'apps/teams', repoRoot: root })
    expect(process.env[KEY]).toBe('from-container')
  })

  it('is a silent no-op when no .env exists (SPCS)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadDotEnv({ appDir: 'apps/teams', repoRoot: root })
    expect(process.env[KEY]).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns and does not load a leftover root .env', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(root, '.env'), `${KEY}=from-root\n`)
    loadDotEnv({ appDir: 'apps/teams', repoRoot: root })
    expect(process.env[KEY]).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('apps/teams/.env')
  })

  it('prefers the app .env over a root .env without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(root, '.env'), `${KEY}=from-root\n`)
    writeFileSync(join(root, 'apps', 'teams', '.env'), `${KEY}=from-app\n`)
    loadDotEnv({ appDir: 'apps/teams', repoRoot: root })
    expect(process.env[KEY]).toBe('from-app')
    expect(warn).not.toHaveBeenCalled()
  })
})
