// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react'
import * as microsoftTeams from '@microsoft/teams-js'
import { classifyAuthError } from '../auth/useTeamsAuth.js'

type Phase = 'working' | 'linked' | 'error'

export async function linkAccount(code: string): Promise<void> {
  const edgeBase = import.meta.env.VITE_EDGE_BASE ?? ''
  await microsoftTeams.app.initialize()
  const post = async (entraToken: string) => fetch(`${edgeBase}/token/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, entraToken }),
  })

  let res = await post(await microsoftTeams.authentication.getAuthToken())
  if (!res.ok) {
    let body = await res.json().catch(() => null)
    if (body?.code === 'ERR_JWT_EXPIRED') {
      res = await post(await microsoftTeams.authentication.getAuthToken({ silent: false }))
      if (!res.ok) body = await res.json().catch(() => null)
    }
    if (!res.ok) {
      // The edge's `error` is user-safe copy for code problems (expired, used, wrong user);
      // Entra codes go through the shared classifier instead.
      const message = typeof body?.reason === 'string' && typeof body?.error === 'string'
        ? body.error
        : classifyAuthError(body?.code ?? body?.error ?? 'failed')
      throw new Error(message)
    }
  }
}

/** Completes the one-time sign-in started from a bot chat (deep link `signin:<code>`). */
export function LinkScreen({ code }: { code: string }) {
  const [phase, setPhase] = useState<Phase>('working')
  const [message, setMessage] = useState('')
  // StrictMode double-invokes effects; a code is one-time, so only ever submit it once.
  const started = useRef(false)

  const run = useCallback(() => {
    setPhase('working')
    linkAccount(code).then(
      () => setPhase('linked'),
      (err: unknown) => {
        setMessage(err instanceof Error ? err.message : String(err))
        setPhase('error')
      },
    )
  }, [code])

  useEffect(() => {
    if (started.current) return
    started.current = true
    run()
  }, [run])

  return (
    <main style={{ padding: 32, maxWidth: 480, margin: '0 auto', fontFamily: 'inherit' }}>
      {phase === 'working' && <p>Linking your Snowflake account…</p>}
      {phase === 'linked' && (
        <>
          <h2>You're signed in</h2>
          <p>Go back to the chat and ask your question again.</p>
        </>
      )}
      {phase === 'error' && (
        <>
          <h2>Couldn't link your account</h2>
          <p role="alert">{message}</p>
          <p>Send the bot another message in chat to get a fresh sign-in link.</p>
        </>
      )}
    </main>
  )
}
