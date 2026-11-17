-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Home for everything the maximal agent needs.
--
-- Deliberately a NEW schema rather than an extension of SUPERSTORE.PUBLIC.
-- PUBLIC is what SUPERSTORE_SALES_AGENT, the relay test fixtures and
-- AgentEmbedAnswerServiceTest.cls depend on, and its grants (including
-- SELECT ON FUTURE TABLES) are load-bearing. Leaving it frozen means a mistake
-- here cannot regress the working demo. SUPERSTORE.AGENTS also matches the
-- <DEMO_DB>.AGENTS convention already used across this account
-- (MARKS_AND_SPENCER_DEMO_DB.AGENTS, GSMA_DEMO_DB.AGENTS, and so on).

CREATE SCHEMA IF NOT EXISTS SUPERSTORE.AGENTS
  COMMENT = 'Assets for SUPERSTORE_360_AGENT: synthetic review corpus, search service, semantic view, generic tool UDFs, skills.';

-- Skill folders (SKILL.md plus scripts) are read from here by the skills tool.
-- DIRECTORY is enabled so LIST/directory-table reads work when debugging why a
-- skill did not load.
CREATE STAGE IF NOT EXISTS SUPERSTORE.AGENTS.SKILLS
  DIRECTORY = (ENABLE = TRUE)
  COMMENT = 'Agent skill folders (SKILL.md + scripts) for SUPERSTORE_360_AGENT';

-- Upload the skill folder. Paths are relative to this directory, which is where
-- run-all.sh runs snow from. AUTO_COMPRESS=FALSE is not optional: a gzipped
-- SKILL.md is not a readable skill, and the failure mode is the skill silently
-- never loading rather than an error.
PUT file://skills/review_analyst/SKILL.md
  @SUPERSTORE.AGENTS.SKILLS/review_analyst/
  OVERWRITE = TRUE AUTO_COMPRESS = FALSE;

PUT file://skills/review_analyst/quadrant.py
  @SUPERSTORE.AGENTS.SKILLS/review_analyst/
  OVERWRITE = TRUE AUTO_COMPRESS = FALSE;

LIST @SUPERSTORE.AGENTS.SKILLS;

SHOW TERSE OBJECTS IN SCHEMA SUPERSTORE.AGENTS;
