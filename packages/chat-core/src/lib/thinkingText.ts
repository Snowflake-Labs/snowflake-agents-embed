// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Joins per-content_index thinking text, skipping empty entries. Unlike joinText() (which
// concatenates every index positionally, including blanks, because prose blocks are meant to
// butt up against each other), most content_index slots for thinking are legitimately empty —
// joining them naively would insert blank separators.
export function joinThinking(byIndex: Map<number, string>): string {
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => t)
    .filter((t) => t.length > 0)
    .join('\n\n')
}
