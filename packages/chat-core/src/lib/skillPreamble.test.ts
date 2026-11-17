// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { buildSkillPreamble } from './skillPreamble'
import type { AgentSkillInfo } from '../api/agents'

describe('buildSkillPreamble', () => {
  it('returns an empty string when no skills are given', () => {
    expect(buildSkillPreamble()).toBe('')
    expect(buildSkillPreamble([])).toBe('')
  })

  it('nudges the agent by name for a single skill', () => {
    const skills: AgentSkillInfo[] = [{ name: 'review_analyst', stagePath: '@DB.SCH.SKILLS/review_analyst' }]
    expect(buildSkillPreamble(skills)).toBe('Use the "review_analyst" skill to help with this request.')
  })

  it('joins multiple skills with one nudge per line', () => {
    const skills: AgentSkillInfo[] = [
      { name: 'review_analyst', stagePath: '@DB.SCH.SKILLS/review_analyst' },
      { name: 'forecaster', stagePath: '@DB.SCH.SKILLS/forecaster' },
    ]
    expect(buildSkillPreamble(skills)).toBe(
      'Use the "review_analyst" skill to help with this request.\n' +
      'Use the "forecaster" skill to help with this request.',
    )
  })
})
