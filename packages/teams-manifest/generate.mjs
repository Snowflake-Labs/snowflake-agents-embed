#!/usr/bin/env node
// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Substitute apps/teams/.env values into manifest.template.json and write manifest.json.
// Generated file is gitignored.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const root = join(dir, '..', '..')

function readEnv() {
  const path = join(root, 'apps', 'teams', '.env')
  if (!existsSync(path)) {
    fail('No apps/teams/.env found. Copy apps/teams/.env.example and fill it in.')
  }
  const env = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

function requireEnv(env, key) {
  const value = env[key]
  if (!value) fail(`${key} is not set — see apps/teams/.env.example`)
  return value
}

const env = readEnv()
const teamsAppId = requireEnv(env, 'TEAMS_APP_ID')
const botAppId = requireEnv(env, 'BOT_APP_ID')
const tabBaseHost = (env.TAB_BASE_HOST || env.TAB_BASE_URL || '')
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '')
if (!tabBaseHost) fail('TAB_BASE_HOST (or TAB_BASE_URL) is not set — see apps/teams/.env.example')
const networkMode = env.NETWORK_MODE || 'public'
if (!['public', 'hybrid', 'privatelink'].includes(networkMode)) {
  fail(`NETWORK_MODE must be public, hybrid or privatelink (got "${networkMode}")`)
}
// In privatelink the SPCS ingress is private, so Teams clients cannot reach it and it is not
// a valid domain. The tab only ever calls its own edge origin.
const spcsIngressHost = networkMode === 'privatelink'
  ? ''
  : requireEnv(env, 'SPCS_INGRESS_HOST').replace(/^https?:\/\//, '').replace(/\/+$/, '')
// The App ID URI belongs to the app registration that owns the OBO flow, so derive it from
// OBO_CLIENT_ID — the same default set-edge-secrets.sh and the token validators use. Falling
// back to BOT_APP_ID is only safe when both are the same registration.
const oboClientId = env.OBO_CLIENT_ID || ''
let entraAudienceUri = env.ENTRA_AUDIENCE_URI
if (!entraAudienceUri) {
  if (!oboClientId) {
    fail('Set ENTRA_AUDIENCE_URI, or OBO_CLIENT_ID so it can be derived (api://<TAB_BASE_HOST>/<OBO_CLIENT_ID>).')
  }
  if (oboClientId !== botAppId) {
    fail(
      'BOT_APP_ID and OBO_CLIENT_ID differ, so the Entra audience URI is ambiguous.\n' +
      'Set ENTRA_AUDIENCE_URI explicitly (it must match the Application ID URI of the OBO app registration\n' +
      'and what set-edge-secrets.sh puts on the edge Worker).',
    )
  }
  entraAudienceUri = `api://${tabBaseHost}/${oboClientId}`
}

const template = readFileSync(join(dir, 'manifest.template.json'), 'utf8')
const rendered = template
  .replaceAll('${TEAMS_APP_ID}', teamsAppId)
  .replaceAll('${BOT_APP_ID}', botAppId)
  .replaceAll('${TAB_BASE_HOST}', tabBaseHost)
  .replaceAll('${SPCS_INGRESS_HOST}', spcsIngressHost)
  .replaceAll('${ENTRA_AUDIENCE_URI}', entraAudienceUri)

const manifest = JSON.parse(rendered)
manifest.validDomains = manifest.validDomains.filter(Boolean)

const out = join(dir, 'manifest.json')
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')
console.log(`Wrote ${out}`)
