// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Conformance corpus for parseSseEvent. agent-run-sse.txt and agent-run-threaded-sse.txt
// are real captured streams off the public agent:run endpoint (see packages/relay/test/
// aggregate.test.ts, which replays the same two files against the aggregator). This test
// exists so that as Cortex's event vocabulary grows, an event type parseSseEvent doesn't
// recognize can never again silently fall through `default: return null` unnoticed — it
// must show up here as a new failure, forcing a decision: handle it, or add it to
// KNOWN_DEFERRED_EVENTS with a reason.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseSseEvent } from './agentRun.js'

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, '../../test/fixtures', name), 'utf-8')
}

// event -> why parseSseEvent intentionally returns null for it today. Phase 2 closed out the
// prior entries here (tool_result.status, suggested_queries, thinking, text) — nothing left
// deferred for now, but the mechanism stays so a future new event type fails loudly instead of
// silently hitting `default`.
const KNOWN_DEFERRED_EVENTS: Record<string, string> = {}

function parseFixture(raw: string): Array<{ event: string; data: string }> {
  const pairs: Array<{ event: string; data: string }> = []
  let currentEvent = ''
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) currentEvent = line.slice(6).trim()
    else if (line.startsWith('data:')) pairs.push({ event: currentEvent, data: line.slice(5).trim() })
  }
  return pairs
}

describe('parseSseEvent conformance against captured fixtures', () => {
  it('parses the synthetic response.map fixture as a map artifact', () => {
    const pairs = parseFixture(fixture('response-map-sse.txt'))
    const mapPairs = pairs.filter((p) => p.event === 'response.map')
    expect(mapPairs).toHaveLength(1)
    const result = parseSseEvent(mapPairs[0].event, mapPairs[0].data)
    expect(result).toMatchObject({
      kind: 'map',
      toolUseId: 'toolu_map_1',
      spec: { version: 1, title: 'Store Locations', layer: { type: 'latlon' } },
    })
    expect(result && result.kind === 'map' && result.spec.data?.values).toHaveLength(1)
  })

  it.each(['agent-run-sse.txt', 'agent-run-threaded-sse.txt', 'agent-run-citations-sse.txt'])(
    'handles or explicitly defers every event type in %s',
    (name) => {
      const pairs = parseFixture(fixture(name))
      expect(pairs.length).toBeGreaterThan(0)

      const unhandledUnknown = new Set<string>()
      for (const { event, data } of pairs) {
        if (event === 'done') continue // "[DONE]" is not JSON — parseSseEvent isn't called with it in practice
        const result = parseSseEvent(event, data)
        const unrecognized = result === null
          || result.kind === 'unknown'
          || result.kind === 'parse_failure'
        if (unrecognized && !(event in KNOWN_DEFERRED_EVENTS)) {
          unhandledUnknown.add(event)
        }
      }
      expect([...unhandledUnknown]).toEqual([])
    },
  )

  it('guards the guard: the corpus still contains every event type this test knows about', () => {
    // If a future fixture swap silently dropped one of these event types, the test above
    // would pass vacuously (nothing to check it against) instead of failing loudly.
    const HANDLED_EVENTS = [
      'response.status', 'response.thinking.delta', 'response.thinking', 'response.text.delta',
      'response.text', 'response.text.annotation', 'response.tool_use', 'response.tool_result',
      'response.tool_result.status', 'response.chart', 'response.table', 'response.suggested_queries',
      'response.warning', 'metadata', 'response',
    ]
    const expected = new Set([...HANDLED_EVENTS, ...Object.keys(KNOWN_DEFERRED_EVENTS)])
    const seen = new Set<string>()
    for (const name of ['agent-run-sse.txt', 'agent-run-threaded-sse.txt', 'agent-run-citations-sse.txt']) {
      for (const { event } of parseFixture(fixture(name))) seen.add(event)
    }
    for (const event of expected) {
      expect(seen.has(event), `expected event "${event}" to appear in the fixtures`).toBe(true)
    }
  })
})
