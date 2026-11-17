// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
const KEY = 'agents_thread_agents'

function read(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} }
}
function write(map: Record<string, string>) {
  localStorage.setItem(KEY, JSON.stringify(map))
}

export function getThreadAgent(threadId: number): string | undefined {
  return read()[String(threadId)]
}

export function getAllThreadAgents(): Record<string, string> {
  return read()
}
export function setThreadAgent(threadId: number, agentFqn: string): void {
  const m = read(); m[String(threadId)] = agentFqn; write(m)
}
export function removeThreadAgent(threadId: number): void {
  const m = read(); delete m[String(threadId)]; write(m)
}
