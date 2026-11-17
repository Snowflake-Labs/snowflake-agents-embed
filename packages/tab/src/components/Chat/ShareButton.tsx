// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { buildDeepLink } from '../../lib/deep-link.js'

interface Props {
  question?: string
  answer: string
  title?: string
  threadId?: number
}

function buildShareText(title: string | undefined, question: string | undefined, answer: string, deepLink: string): string {
  const lines: string[] = []
  if (title) lines.push(`**${title}** (from Snowflake Agent for Teams (Unofficial))`)
  if (question) lines.push(`Q: ${question}`)
  lines.push(`A: ${answer.slice(0, 500)}${answer.length > 500 ? '…' : ''}`)
  lines.push(`[Open in Snowflake Agent for Teams (Unofficial) → ${deepLink}]`)
  return lines.join('\n')
}

export function ShareButton({ question, answer, title, threadId }: Props) {
  const appId = import.meta.env.VITE_TEAMS_APP_ID ?? ''
  const deepLink = buildDeepLink(appId, threadId)

  async function handleShare() {
    const text = buildShareText(title, question, answer, deepLink)
    const teamsUrl = `https://teams.microsoft.com/l/chat/0/0?users=&message=${encodeURIComponent(text)}`
    try {
      window.open(teamsUrl, '_blank')
    } catch {
      // Last resort: clipboard copy
      try {
        await navigator.clipboard.writeText(text)
      } catch { /* ignore */ }
    }
  }

  return (
    <button className="action-btn" onClick={handleShare} title="Share this answer">
      Share
    </button>
  )
}
