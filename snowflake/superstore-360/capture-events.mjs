#!/usr/bin/env node
// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Capture the real SSE event inventory that SUPERSTORE_360_AGENT produces.
 *
 * Purpose: packages/chat-core/src/api/sseParser.ts parses a set of event types
 * that no previously configured agent could emit — response.chart,
 * response.table, response.text.annotation, cortex_search tool_use. This drives
 * questions designed to trigger each one and records what actually comes back, so
 * the client-side gap analysis in README.md rests on observed payloads rather than
 * on the docs.
 *
 * Hits the public Cortex Agents :run endpoint directly with a PAT, bypassing our
 * relay and server, so a failure here is Cortex's and not ours. Read-only: no
 * threads are created, nothing is written.
 *
 *   node capture-events.mjs
 *   node capture-events.mjs --agent DB.SCHEMA.AGENT
 *   node capture-events.mjs --only hybrid
 *
 * Full transcripts land in temp/superstore-360-events.json (temp/ is gitignored).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

function readEnv() {
  const env = {}
  try {
    const envFile = process.env.ENV_FILE || join(ROOT, 'apps', 'teams', '.env')
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      // Later assignments win: .env has duplicate DEFAULT_AGENT_FQN keys and the
      // last one is the live value.
      if (m) env[m[1]] = m[2].trim()
    }
  } catch { /* no .env */ }
  return { ...process.env, ...env }
}

const env = readEnv()
const args = process.argv.slice(2)
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

const ACCOUNT = (env.SNOWFLAKE_ACCOUNT || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  .replace(/^([^.]+)$/, '$1.snowflakecomputing.com')
  .replace(/^([^.]*)_/, (m) => m.replace(/_/g, '-'))
const PAT = env.SNOWFLAKE_PAT
const AGENT = argOf('--agent') || 'SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT'
const ONLY = argOf('--only')

if (!ACCOUNT || !PAT) {
  console.error('Need SNOWFLAKE_ACCOUNT and SNOWFLAKE_PAT in .env')
  process.exit(2)
}

const [DB, SCHEMA, NAME] = AGENT.split('.')
const URL = `https://${ACCOUNT}/api/v2/databases/${DB}/schemas/${SCHEMA}/agents/${encodeURIComponent(NAME)}:run`

/**
 * Each case names the tool/event it is meant to provoke. `expect` lists event
 * types or tool types that must appear for the case to count as proving its
 * point — absence is reported, not silently tolerated, because a plausible
 * text-only answer is exactly what a broken tool looks like.
 */
const CASES = [
  {
    id: 'hybrid',
    why: 'Analyst + Search + chart in one turn — the headline case',
    question:
      'Which product sub-categories have the highest total sales but the worst average review ratings? ' +
      'Show the top five as a chart, then explain what customers actually complain about in the worst one.',
    expect: ['response.chart', 'response.table', 'response.text.annotation',
             'tool:cortex_search', 'tool:system_execute_sql'],
    maxTools: 10,
  },
  {
    id: 'analyst_chart',
    why: 'cortex_analyst_text_to_sql + data_to_chart, no search',
    question: 'Chart total sales and profit by region for 2023.',
    expect: ['response.chart', 'response.table', 'tool:system_execute_sql'],
    maxTools: 7,
  },
  {
    id: 'search_citations',
    why: 'cortex_search alone, and whether citations arrive as annotations',
    question: 'What do customers say about our bookcases? Quote a few specific reviews.',
    expect: ['tool:cortex_search', 'response.text.annotation'],
    maxTools: 4,
  },
  {
    id: 'generic_forecast',
    why: 'generic tool (function) returning an OBJECT',
    question: 'What is the projected sales trend for the North region over the next six months?',
    expect: ['tool:forecast_sales'],
    maxTools: 7,
  },
  {
    id: 'generic_health',
    why: 'generic tool needing a lookup first — tests tool chaining',
    question: 'How healthy is customer SP-20920, and have they written any bad reviews?',
    expect: ['tool:customer_health_score'],
    maxTools: 7,
  },
  {
    id: 'code_execution',
    why: 'code_execution sandbox',
    question:
      'Using the sales and average review rating per sub-category, compute the Pearson ' +
      'correlation between them in Python and tell me the coefficient.',
    // `bash`, not `code_execution`: the tool is CONFIGURED as code_execution but the
    // sandbox surfaces in the stream under the sandbox tool names. Same split as
    // cortex_analyst_text_to_sql -> system_execute_sql.
    expect: ['tool:bash'],
    maxTools: 8,
  },
  {
    id: 'skill',
    why: 'the review_analyst skill (loads via code execution)',
    question:
      'Build the sales-versus-sentiment quadrant for our sub-categories and tell me which ' +
      'ones are in the "Fix first" quadrant.',
    expect: ['tool:server_skill'],
    maxTools: 12,
  },
  {
    id: 'web_search',
    why: 'web_search tool',
    question:
      'Search the web for recent trends in the European office furniture market, and say how ' +
      'that compares with our own furniture sales trend.',
    expect: ['tool:web_search'],
    maxTools: 7,
  },
]

async function run(testCase) {
  const body = {
    messages: [{ role: 'user', content: [{ type: 'text', text: testCase.question }] }],
    stream: true,
  }

  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAT}`,
      'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    return { ok: false, status: res.status, error: text.slice(0, 800), events: [], eventTypes: {}, toolTypes: {} }
  }

  // Minimal SSE reader: accumulate, split on blank line, keep `event:`/`data:`.
  const events = []
  const eventTypes = {}
  const toolTypes = {}
  let buffer = ''
  const decoder = new TextDecoder()

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      let name, data
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim()
        else if (line.startsWith('data:')) data = (data ?? '') + line.slice(5).trim()
      }
      if (!name) continue
      eventTypes[name] = (eventTypes[name] ?? 0) + 1
      let parsed
      try { parsed = data ? JSON.parse(data) : undefined } catch { parsed = data }
      if (name === 'response.tool_use' && parsed) {
        const t = parsed.type ?? parsed.tool_type
        // Tool name matters as much as type: three tools share type `generic`, so
        // type alone cannot tell us which one the orchestrator picked.
        const key = t === 'generic' ? (parsed.name ?? 'generic') : t
        if (key) toolTypes[key] = (toolTypes[key] ?? 0) + 1
      }
      // Deltas dominate the stream and carry nothing structural; keep one sample.
      const isDelta = name.endsWith('.delta')
      if (!isDelta || (eventTypes[name] === 1)) events.push({ event: name, data: parsed })
    }
  }

  return { ok: true, status: res.status, events, eventTypes, toolTypes }
}

const out = { agent: AGENT, account: ACCOUNT, capturedAt: new Date().toISOString(), cases: [] }
let failures = 0

for (const c of CASES) {
  if (ONLY && c.id !== ONLY) continue
  process.stdout.write(`\n── ${c.id} — ${c.why}\n   Q: ${c.question.slice(0, 100)}...\n`)
  let r
  try {
    r = await run(c)
  } catch (e) {
    r = { ok: false, error: String(e), eventTypes: {}, toolTypes: {}, events: [] }
  }

  if (!r.ok) {
    console.log(`   ✗ HTTP ${r.status ?? '?'}: ${String(r.error).slice(0, 300)}`)
    failures++
    out.cases.push({ ...c, result: r })
    continue
  }

  const seen = new Set([
    ...Object.keys(r.eventTypes),
    ...Object.keys(r.toolTypes).map((t) => `tool:${t}`),
  ])
  const missing = c.expect.filter((e) => !seen.has(e))

  // Tool-call count is a first-class result, not a curiosity. A broken tool
  // contract shows up here — the orchestrator retries, reimplements the tool in
  // SQL, and eventually gives up — while still returning fluent prose that reads
  // like success. Counting calls is how that stays visible.
  const toolCalls = r.eventTypes['response.tool_use'] ?? 0
  const overBudget = c.maxTools !== undefined && toolCalls > c.maxTools

  // Named-argument mismatches on `generic` tools are silent in the prose but loud
  // in the tool_result payloads, so surface them explicitly.
  const namedArgErrors = r.events.filter((e) =>
    e.event === 'response.tool_result' &&
    JSON.stringify(e.data ?? '').includes('do not match any signature')).length

  console.log(`   events: ${Object.entries(r.eventTypes).map(([k, v]) => `${k}×${v}`).join(', ')}`)
  console.log(`   tools : ${Object.keys(r.toolTypes).join(', ') || '(none)'}`)
  console.log(`   calls : ${toolCalls}${c.maxTools !== undefined ? ` (budget ${c.maxTools})` : ''}`)

  let bad = false
  if (missing.length) { console.log(`   ⚠ expected but absent: ${missing.join(', ')}`); bad = true }
  if (overBudget) { console.log(`   ⚠ over tool-call budget: ${toolCalls} > ${c.maxTools}`); bad = true }
  if (namedArgErrors) { console.log(`   ✗ ${namedArgErrors} named-argument failure(s) — generic tool contract is broken`); bad = true }
  if (bad) failures++
  else console.log('   ✓ expected events present, within tool budget, no contract errors')

  out.cases.push({ id: c.id, why: c.why, question: c.question, expect: c.expect,
                   missing, toolCalls, maxTools: c.maxTools, namedArgErrors, result: r })
}

// Union across cases: the inventory the clients actually have to handle.
const allEvents = {}
const allTools = {}
for (const c of out.cases) {
  for (const [k, v] of Object.entries(c.result?.eventTypes ?? {})) allEvents[k] = (allEvents[k] ?? 0) + v
  for (const [k, v] of Object.entries(c.result?.toolTypes ?? {})) allTools[k] = (allTools[k] ?? 0) + v
}
out.summary = { eventTypes: allEvents, toolTypes: allTools, failures }

mkdirSync(join(ROOT, 'temp'), { recursive: true })
const path = join(ROOT, 'temp', 'superstore-360-events.json')
writeFileSync(path, JSON.stringify(out, null, 2))

console.log('\n════ event types observed across all cases ════')
for (const [k, v] of Object.entries(allEvents).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`)
console.log('\n════ tools invoked ════')
for (const [k, v] of Object.entries(allTools).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`)
console.log(`\nfull transcripts -> ${path}`)
console.log(failures ? `\n${failures} case(s) incomplete — see warnings above` : '\nall cases produced their expected events')
process.exit(failures ? 1 : 0)
