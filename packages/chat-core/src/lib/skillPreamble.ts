// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { AgentSkillInfo } from '../api/agents.js'

// Sent as query text, not the documented `instructions` field - see ChatContainer.sendMessage's
// comment on why context preambles go on the query. There is no per-run "attach skill" field in
// agent:run, so a skill the user picked in the SkillPicker is nudged in here instead.
//
// Deliberately just a name reference, not the skill's full SKILL.md body: the agent already has
// the real skill spec server-side (it's a static, agent-level property) and resolves + executes
// it itself once it judges the request relevant - see the Cortex Agents Skills docs. Fetching and
// re-injecting the instructions ourselves would mean depending on an undocumented internal API
// (see git history for why that was tried and reverted); this just gives the orchestrator's own
// documented skill-evaluation enough of a hint to pick the right one.
export function buildSkillPreamble(skills?: AgentSkillInfo[]): string {
  if (!skills?.length) return ''
  return skills.map((s) => `Use the "${s.name}" skill to help with this request.`).join('\n')
}
