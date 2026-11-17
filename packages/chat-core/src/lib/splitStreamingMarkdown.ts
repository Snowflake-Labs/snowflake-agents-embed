// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Split a growing streamed markdown document at the last complete block boundary
 * so a stable prefix can stay memoized while only the live tail is re-parsed.
 *
 * Boundary is the last `\n\n` that is not inside a fenced code block. If none
 * exists (or the whole document is one open fence), the prefix is empty and the
 * tail is the full text.
 */
export function splitStreamingMarkdown(text: string): { prefix: string; tail: string } {
  let inFence = false
  let lastBoundary = -1
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('```', i) && (i === 0 || text[i - 1] === '\n')) {
      inFence = !inFence
      i += 2
      continue
    }
    if (!inFence && text.startsWith('\n\n', i)) {
      lastBoundary = i + 2
      i += 1
    }
  }
  if (lastBoundary <= 0 || lastBoundary >= text.length) {
    return { prefix: '', tail: text }
  }
  return { prefix: text.slice(0, lastBoundary), tail: text.slice(lastBoundary) }
}
