// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { ApiError } from '../api/apiError.js'
import { translateError } from './translateError.js'

export interface ClassifiedError {
  /** transient -> "try again", permanent -> "contact your admin". */
  tone: 'transient' | 'permanent'
  message: string
  /** The original message, always kept around (behind a details disclosure in the UI)
   * rather than discarded - useful for support even when the headline is generic. */
  raw: string
}

function toneForStatus(status: number): ClassifiedError['tone'] {
  if (status === 401 || status === 403) return 'permanent'
  // 429/408/425 clear on their own; the rest of 4xx is a caller/config problem.
  if (status === 429 || status === 408 || status === 425) return 'transient'
  if (status >= 400 && status < 500) return 'permanent'
  return 'transient'
}

// Shared by HistoryList and SearchView, which both surface a raw backend/network string with
// no classification today ("INTERNAL_ERROR: statement timed out after 30s", "Failed to load
// history") - a viewer has no idea whether to wait, retry, or escalate. Named generically
// (not History/Search-specific) since useTeamsAuth's Entra-code classification is the same
// shape of problem; kept separate for now since the codes it maps are Entra-specific.
//
// Tone lives here; the sentence comes from translateError so the two helpers cannot drift.
export function classifyError(err: unknown, fallback: string): ClassifiedError {
  const raw = err instanceof Error ? err.message : fallback
  const status = err instanceof ApiError ? err.status : undefined
  const code = err instanceof ApiError ? err.code : undefined

  if (status !== undefined) {
    return { tone: toneForStatus(status), message: translateError({ status, code, message: raw }), raw }
  }
  return { tone: 'transient', message: translateError({ message: raw }), raw }
}
