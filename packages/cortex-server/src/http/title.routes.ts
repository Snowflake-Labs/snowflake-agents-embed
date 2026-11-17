// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono'
import { snowflakeBase, snowflakeHeaders } from '../snowflake/credential.js'
import { fetchWithTimeout } from '../snowflake/fetch-timeout.js'
import { isCredentialFailure } from '../host/credentialResolver.js'
import type { CortexRouteDeps } from './deps.js'

// Small, fast model for title generation. Overridable via env for accounts
// where a different model is enabled.
const TITLE_MODEL = process.env.TITLE_MODEL ?? 'llama3.1-8b'

// Pull assistant text out of a single Cortex inference:complete SSE data line.
// The endpoint is OpenAI-shaped: {choices:[{delta:{content}}]}, but tolerate the
// legacy {choices:[{messages}]} and a couple of flat fallbacks.
function extractDelta(json: any): string {
  const choice = json?.choices?.[0]
  return (
    choice?.delta?.content ??
    choice?.messages ??
    choice?.text ??
    json?.content ??
    ''
  )
}

const WRAPPING_QUOTES = /^["'`]+|["'`]+$/g
const WHITESPACE_RUN = /\s+/g

function cleanTitle(raw: string): string {
  return raw
    .trim()
    .replace(WRAPPING_QUOTES, '') // strip wrapping quotes/backticks
    .replace(WHITESPACE_RUN, ' ')
    .slice(0, 60)
    .trim()
}

export function registerTitleRoutes(app: Hono, deps: CortexRouteDeps) {
  // Generate a concise title for a new thread from its first user message.
  // Mirrors the Intelligence app's generateTitle behaviour. Always returns 200;
  // on any upstream failure it yields { title: "" } so the client silently skips
  // (the thread just stays unnamed until the next attempt).
  app.post('/api/generate-title', async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    const body = await c.req.json().catch(() => ({} as any))
    const firstMessage: string = (body.firstMessage ?? '').toString().slice(0, 2000)
    if (!firstMessage.trim()) return c.json({ title: '' })

    const url = `${snowflakeBase(deps.config.snowflakeAccount)}/api/v2/cortex/inference:complete`
    const prompt =
      'Generate a concise 3-6 word title (no surrounding quotes, no trailing punctuation) ' +
      `for a conversation that starts with this message:\n\n${firstMessage}`

    try {
      const upstream = await fetchWithTimeout(url, {
        method: 'POST',
        headers: snowflakeHeaders(cred, 'text/event-stream'),
        body: JSON.stringify({
          model: TITLE_MODEL,
          messages: [{ role: 'user', content: prompt }],
        }),
      })

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => '')
        console.error(`Cortex complete ${upstream.status} for title: ${detail.slice(0, 300)}`)
        return c.json({ title: '' })
      }

      // Aggregate the SSE stream into the full completion text. Titles are short
      // enough that buffering the whole response is fine here.
      const raw = await upstream.text()
      let title = ''
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try { title += extractDelta(JSON.parse(data)) } catch { /* skip non-JSON keepalive */ }
      }

      return c.json({ title: cleanTitle(title) })
    } catch (err) {
      console.error('Title generation failed:', err)
      return c.json({ title: '' })
    }
  })
}
