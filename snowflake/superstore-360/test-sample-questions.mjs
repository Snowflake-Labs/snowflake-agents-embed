#!/usr/bin/env node
// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Drive the agent's OWN sample_questions live and judge three things per turn:
 * did it answer, how long did it take, and is the answer defensible.
 *
 * Why a separate script from capture-events.mjs: that one asks questions I wrote
 * to force specific SSE events, with a tool-call budget as the pass criterion.
 * This one asks the questions the PRODUCT puts in front of a user as starter
 * prompts, and grades latency and content. A starter prompt that errors or takes
 * two minutes is a worse bug than a missing event type, because it is the first
 * thing every new user clicks.
 *
 * Questions are read from the live spec, not hardcoded, so editing 06_agent.sql
 * cannot leave this test measuring prompts the agent no longer offers.
 *
 *   node test-sample-questions.mjs
 *   node test-sample-questions.mjs --parallel        # faster, noisier latency
 *   node test-sample-questions.mjs --only 3
 *   node test-sample-questions.mjs --agent DB.SCHEMA.AGENT
 *
 * Timings are wall clock from this machine, so they include network egress to
 * the account region — treat them as an upper bound on what a user in-region
 * sees, and compare runs rather than absolute numbers.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

function readEnv() {
  const env = {}
  try {
    const envFile = process.env.ENV_FILE || join(ROOT, 'apps', 'teams', '.env')
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m) env[m[1]] = m[2].trim()
    }
  } catch { /* no .env */ }
  return { ...process.env, ...env }
}

const env = readEnv()
const args = process.argv.slice(2)
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const has = (n) => args.includes(n)

const ACCOUNT = (env.SNOWFLAKE_ACCOUNT || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  .replace(/^([^.]+)$/, '$1.snowflakecomputing.com')
  .replace(/^([^.]*)_/, (m) => m.replace(/_/g, '-'))
const PAT = env.SNOWFLAKE_PAT
const AGENT = argOf('--agent') || 'SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT'
const CONN = argOf('-c') || argOf('--connection') || 'demo'
const ONLY = argOf('--only')
const PARALLEL = has('--parallel')

const EXPECTED_VQR_QUESTIONS = {
  'SUPERSTORE.PUBLIC.SUPERSTORE_SALES_AGENT': new Set([
    'What were the total sales and profit for each region?',
    'Which product categories generate the most revenue?',
    'How do customer segments compare in terms of sales and profitability?',
    'What is the return rate by region?',
    'Show me quarterly sales trends for 2023',
  ]),
  'SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT': new Set([
    'Which sub-categories have the highest sales but the worst review ratings, and are those the ones being returned?',
    'What were total sales and profit by region, and how did the trend move over 2023?',
    'Show me the top 10 products by revenue with their average review rating.',
    'Compare return rates and negative review rates across the three regions.',
    'Which delivery mode is associated with the worst customer sentiment?',
  ]),
}

// Latency thresholds. `slow` is a warning, `timeout` is a failure. The agent's own
// orchestration budget is 300s, so anything at or past that is the budget killing
// the turn rather than this script being impatient.
const SLOW_TOTAL_MS = 75_000
const SLOW_TTFT_MS = 25_000
const HARD_TIMEOUT_MS = 300_000

if (!ACCOUNT || !PAT) {
  console.error('Need SNOWFLAKE_ACCOUNT and SNOWFLAKE_PAT in .env')
  process.exit(2)
}

const [DB, SCHEMA, NAME] = AGENT.split('.')
const URL = `https://${ACCOUNT}/api/v2/databases/${DB}/schemas/${SCHEMA}/agents/${encodeURIComponent(NAME)}:run`

/** Pull sample_questions from the live spec so this can never drift from the agent. */
function liveSampleQuestions() {
  const out = execFileSync('snow', [
    'sql', '-c', CONN, '--format', 'json',
    '-q', `DESCRIBE AGENT ${AGENT};`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const spec = JSON.parse(JSON.parse(out)[0].agent_spec)
  const qs = spec?.instructions?.sample_questions ?? []
  return qs.map((q) => (typeof q === 'string' ? q : q.question)).filter(Boolean)
}

/**
 * Substrings that mean the turn failed even though prose came back. The loop-guard
 * sentence is the important one: the agent says it plainly, in fluent English, and
 * a human skim-reading the answer will not notice.
 */
const FAILURE_MARKERS = [
  'do not match any signature',
  'repeating the same action without making progress',
  'I was unable to',
  'I encountered an error',
  "I don't have access",
  'no named result sets found',
  'Unhandled exception',
  'SQL compilation error',
]

async function ask(question) {
  const t0 = Date.now()
  const timer = AbortSignal.timeout(HARD_TIMEOUT_MS)

  let res
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAT}`,
        'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
        stream: true,
      }),
      signal: timer,
    })
  } catch (e) {
    return { ok: false, error: `request failed: ${String(e)}`, ms: Date.now() - t0 }
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: (await res.text()).slice(0, 600), ms: Date.now() - t0 }
  }

  const eventTypes = {}
  const tools = {}
  const toolErrors = []
  const softErrors = []
  const verifiedQueryResults = []
  let text = ''
  let msFirstEvent = null
  let msFirstText = null
  let buffer = ''
  const decoder = new TextDecoder()

  try {
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
        msFirstEvent ??= Date.now() - t0
        eventTypes[name] = (eventTypes[name] ?? 0) + 1

        let p
        try { p = data ? JSON.parse(data) : undefined } catch { p = undefined }

        if (name === 'response.text.delta' && p?.text) {
          msFirstText ??= Date.now() - t0
          text += p.text
        }
        if (name === 'response.text' && p?.text) text ||= p.text
        if (name === 'response.tool_use' && p) {
          const t = p.type ?? p.tool_type
          const key = t === 'generic' ? (p.name ?? 'generic') : t
          if (key) tools[key] = (tools[key] ?? 0) + 1
        }
        if (name === 'response.tool_result' && p) {
          const s = JSON.stringify(p)
          const blocks = Array.isArray(p.content) ? p.content : []
          for (const block of blocks) {
            if (block?.json && typeof block.json.verified_query_used === 'boolean') {
              verifiedQueryResults.push(block.json.verified_query_used)
            }
          }
          if (/"?error"?\s*:/i.test(s) || s.includes('do not match any signature')) {
            // Cortex distinguishes the two, so this must too. A tool_result can
            // carry an error object AND `execution_status: "SQL was executed
            // despite N non-blocking validation error(s)"` - the query ran and the
            // agent got its data. Counting those as failures overstates the
            // problem and hides which retries actually cost something.
            if (s.includes('non-blocking')) softErrors.push(s.slice(0, 300))
            else toolErrors.push(s.slice(0, 300))
          }
        }
      }
    }
  } catch (e) {
    return { ok: false, error: `stream aborted after ${Date.now() - t0}ms: ${String(e)}`,
             ms: Date.now() - t0, eventTypes, tools, text }
  }

  return {
    ok: true,
    ms: Date.now() - t0,
    msFirstEvent,
    msFirstText,
    eventTypes,
    tools,
    toolErrors,
    softErrors,
    verifiedQueryResults,
    verifiedQueryUsed: verifiedQueryResults.includes(true),
    toolCalls: eventTypes['response.tool_use'] ?? 0,
    text,
  }
}

function grade(q, r) {
  const problems = []
  if (!r.ok) { problems.push(r.error); return problems }
  if (!r.text || r.text.trim().length < 40) problems.push(`answer is ${r.text?.length ?? 0} chars - effectively empty`)
  if (r.toolCalls === 0) problems.push('answered with zero tool calls - almost certainly invented, not measured')
  for (const m of FAILURE_MARKERS) {
    if (r.text?.includes(m)) problems.push(`answer admits failure: "${m}"`)
  }
  if (r.toolErrors?.length) problems.push(`${r.toolErrors.length} blocking tool_result error(s): ${r.toolErrors[0].slice(0, 160)}`)
  if (EXPECTED_VQR_QUESTIONS[AGENT]?.has(q) && !r.verifiedQueryUsed) {
    problems.push('expected an Analyst result with verified_query_used=true')
  }
  if (r.ms >= HARD_TIMEOUT_MS) problems.push(`hit hard timeout at ${(r.ms / 1000).toFixed(1)}s`)
  return problems
}

const QUESTIONS = liveSampleQuestions()
if (!QUESTIONS.length) {
  console.error(`${AGENT} has no sample_questions - nothing to test`)
  process.exit(2)
}

const selected = QUESTIONS.map((q, i) => ({ n: i + 1, q }))
  .filter(({ n }) => !ONLY || String(n) === ONLY)

console.log(`agent   : ${AGENT}`)
console.log(`account : ${ACCOUNT}`)
console.log(`questions: ${selected.length} of ${QUESTIONS.length}${PARALLEL ? ' (parallel)' : ' (sequential)'}\n`)

async function runOne({ n, q }) {
  const r = await ask(q)
  const problems = grade(q, r)
  return { n, question: q, ...r, problems }
}

let results
if (PARALLEL) {
  results = await Promise.all(selected.map(runOne))
} else {
  results = []
  for (const s of selected) {
    process.stdout.write(`── Q${s.n}: ${s.q.slice(0, 78)}\n`)
    const r = await runOne(s)
    results.push(r)
    const secs = (r.ms / 1000).toFixed(1)
    const ttft = r.msFirstText ? `${(r.msFirstText / 1000).toFixed(1)}s` : 'never'
    console.log(`   ${r.problems.length ? '✗' : '✓'} ${secs}s total, first text ${ttft}, ` +
                `${r.toolCalls ?? 0} tool calls [${Object.keys(r.tools ?? {}).join(', ') || 'none'}]` +
                `${EXPECTED_VQR_QUESTIONS[AGENT]?.has(r.question) ? `, VQR ${r.verifiedQueryUsed ? 'used' : 'missing'}` : ''}`)
    if (r.ok && r.ms > SLOW_TOTAL_MS) console.log(`   ⚠ slow: ${secs}s > ${SLOW_TOTAL_MS / 1000}s`)
    if (r.ok && r.msFirstText > SLOW_TTFT_MS) console.log(`   ⚠ slow first token: ${ttft} > ${SLOW_TTFT_MS / 1000}s`)
    if (r.softErrors?.length) console.log(`   · ${r.softErrors.length} non-blocking validation warning(s) - query still ran`)
    for (const p of r.problems) console.log(`   ✗ ${p}`)
    if (r.text) console.log(`   → ${r.text.replace(/\s+/g, ' ').slice(0, 220)}...`)
    console.log()
  }
}

const okCount = results.filter((r) => !r.problems.length).length
const times = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b)
const pct = (p) => times.length ? times[Math.min(times.length - 1, Math.floor(times.length * p))] : 0

console.log('════ latency ════')
console.log(`  fastest ${(times[0] / 1000).toFixed(1)}s   median ${(pct(0.5) / 1000).toFixed(1)}s   ` +
            `p90 ${(pct(0.9) / 1000).toFixed(1)}s   slowest ${(times.at(-1) / 1000).toFixed(1)}s`)
console.log('\n════ per question ════')
for (const r of results) {
  console.log(`  Q${r.n}  ${String((r.ms / 1000).toFixed(1)).padStart(6)}s  ` +
              `ttft ${String(r.msFirstText ? (r.msFirstText / 1000).toFixed(1) : '-').padStart(5)}s  ` +
              `${String(r.toolCalls ?? 0).padStart(2)} calls  ` +
              `${String(r.toolErrors?.length ?? 0).padStart(2)} err  ` +
              `${r.problems.length ? 'FAIL' : 'ok  '}  ${r.question.slice(0, 60)}`)
}

mkdirSync(join(ROOT, 'temp'), { recursive: true })
const path = join(ROOT, 'temp', 'superstore-360-sample-questions.json')
writeFileSync(path, JSON.stringify({ agent: AGENT, account: ACCOUNT, results }, null, 2))
console.log(`\nfull answers -> ${path}`)
console.log(`${okCount}/${results.length} sample questions answered cleanly`)
process.exit(okCount === results.length ? 0 : 1)
