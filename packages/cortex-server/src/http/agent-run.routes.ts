// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { buildAgentRunUrl, resolveAuthorizedAgent } from '../snowflake/agent-ref.js'
import { applyAttachments } from './attachments.js'
import { snowflakeHeaders } from '../snowflake/credential.js'
import {
  AGENT_RUN_PING_MS,
  fetchWithTimeoutStreaming,
} from '../snowflake/fetch-timeout.js'
import { isCredentialFailure } from '../host/credentialResolver.js'
import { logSafeError } from './log-safe-error.js'
import { redactedUpstreamError } from './upstream-error.js'
import type { CortexRouteDeps } from './deps.js'

const TRUNCATED_FRAME =
  'event: error\ndata: {"code":"upstream_stream_truncated","message":"The upstream stream ended unexpectedly."}\n\n'

const PING_FRAME = ':ping\n\n'

function redactErrorFrame(frame: string): string {
  if (!/^event:\s*error\s*$/m.test(frame)) return frame
  const raw = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('')
  let code = 'upstream_error'
  let message = 'Upstream error'
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown }
    if (typeof parsed?.code === 'string') code = parsed.code
    if (typeof parsed?.message === 'string') message = parsed.message
  } catch {
    /* keep defaults */
  }
  return `event: error\ndata: ${JSON.stringify({ code, message })}\n\n`
}

/**
 * Owns the pipe so a mid-stream upstream death can still emit a Cortex-shaped
 * `error` frame. Also injects SSE comment pings during silence so intermediaries
 * and the browser stall watchdog can tell "still thinking" from "connection gone".
 * Comment lines are ignored by the existing client parser.
 */
export function wrapUpstreamSse(
  upstream: ReadableStream<Uint8Array>,
  opts: { pingMs?: number; onClose?: () => void } = {},
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const pingMs = opts.pingMs ?? AGENT_RUN_PING_MS
  let buffer = ''
  let frameBuf = ''
  let sawTerminal = false
  let closed = false
  let pingTimer: ReturnType<typeof setInterval> | undefined

  const note = (text: string) => {
    buffer += text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('event:')) continue
      const name = line.slice(6).trim()
      if (name === 'response' || name === 'error') sawTerminal = true
    }
  }

  const flushFrames = (controller: ReadableStreamDefaultController<Uint8Array>, text: string, final = false) => {
    frameBuf += text
    while (true) {
      const idx = frameBuf.indexOf('\n\n')
      if (idx < 0) break
      const frame = frameBuf.slice(0, idx + 2)
      frameBuf = frameBuf.slice(idx + 2)
      const redacted = redactErrorFrame(frame)
      controller.enqueue(encoder.encode(redacted))
      note(redacted)
    }
    if (final && frameBuf) {
      const redacted = redactErrorFrame(frameBuf.endsWith('\n\n') ? frameBuf : `${frameBuf}\n\n`)
      controller.enqueue(encoder.encode(redacted))
      note(redacted)
      frameBuf = ''
    }
  }

  const cleanup = () => {
    if (closed) return
    closed = true
    if (pingTimer !== undefined) clearInterval(pingTimer)
    pingTimer = undefined
    opts.onClose?.()
  }

  const armPing = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (pingTimer !== undefined) clearInterval(pingTimer)
    pingTimer = setInterval(() => {
      try { controller.enqueue(encoder.encode(PING_FRAME)) } catch { /* stream already closed */ }
    }, pingMs)
  }

  return new ReadableStream({
    start(controller) {
      armPing(controller)
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (closed) return
            if (done) {
              flushFrames(controller, decoder.decode(), true)
              if (!sawTerminal) controller.enqueue(encoder.encode(TRUNCATED_FRAME))
              cleanup()
              controller.close()
              return
            }
            flushFrames(controller, decoder.decode(value, { stream: true }))
            armPing(controller)
          }
        } catch (err) {
          if (closed) return
          logSafeError('Upstream agent-run stream failed', err)
          try {
            if (!sawTerminal) controller.enqueue(encoder.encode(TRUNCATED_FRAME))
            cleanup()
            controller.close()
          } catch {
            cleanup()
          }
        }
      }
      void pump()
    },
    cancel() {
      cleanup()
      return reader.cancel()
    },
  })
}

const MAX_BODY_BYTES = 5_242_880

// Only these client keys reach Cortex :run. Everything else (including a stray
// `statement` or `origin_application`) is dropped rather than forwarded.
const FORWARDED_KEYS = [
  'messages',
  'thread_id',
  'parent_message_id',
  'tool_choice',
  'experimental',
  'deep_research',
] as const

export function registerAgentRunRoutes(app: Hono, deps: CortexRouteDeps) {
  // Enforced on the streamed byte count (and Content-Length) before the body is buffered.
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request body too large (max 5 MB)' }, 413),
  })

  app.post('/api/agent/run', limitBody, async (c) => {
    const cred = await deps.host.credentials.resolve(c)
    if (isCredentialFailure(cred)) return c.json({ error: cred.error }, cred.status)

    const rawBody = await c.req.text()
    let body: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(rawBody)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return c.json({ error: 'Invalid JSON' }, 400)
      }
      body = parsed as Record<string, unknown>
    } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    // Caller may supply agentFqn in the request body; fall back to the configured default.
    const requestedFqn: string = (body.agentFqn as string | undefined) ?? deps.config.defaultAgentFqn
    if (!requestedFqn) return c.json({ error: 'Agent not configured' }, 500)

    const authorized = resolveAuthorizedAgent(
      requestedFqn,
      deps.config.agentDiscovery,
      deps.config.agentAllowList,
    )
    if (!authorized.ok) return c.json({ error: authorized.error }, authorized.status)

    const url = buildAgentRunUrl(deps.config.snowflakeAccount, authorized.ref)

    const attached = applyAttachments(body, deps.config.featureFlags?.fileUpload === true)
    if (!attached.ok) return c.json({ error: attached.error }, attached.status)

    // Allow-list rather than strip-list: Cortex rejects unknown keys, and
    // `origin_application` in particular must NOT be sent to :run (400/390142);
    // it belongs only on the /threads endpoints.
    const cortexBody: Record<string, unknown> = {}
    for (const key of FORWARDED_KEYS) {
      if (key in attached.body) cortexBody[key] = attached.body[key]
    }

    // A longer bound than the SQL-API routes: agent runs can involve multiple
    // tool calls before the first byte streams back. The streaming helper then
    // keeps a 300s wall-clock bound armed across the body-read phase.
    const { response: upstream, dispose } = await fetchWithTimeoutStreaming(url, {
      method: 'POST',
      headers: snowflakeHeaders(cred, 'text/event-stream'),
      body: JSON.stringify({
        ...cortexBody,
        stream: true,
      }),
      signal: c.req.raw.signal,
    })

    if (!upstream.ok || !upstream.body) {
      dispose()
      return redactedUpstreamError(upstream)
    }

    return new Response(wrapUpstreamSse(upstream.body, { onClose: dispose }), {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // Tell any nginx-family proxy in front of us (the SPCS ingress included)
        // not to buffer the body - buffering turns a live stream into one late
        // dump, which is exactly the failure mode this whole design avoids.
        'X-Accel-Buffering': 'no',
      },
    })
  })
}
