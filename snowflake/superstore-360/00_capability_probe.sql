-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Which optional agent-spec features does THIS account actually accept?
--
-- The target account's spec parser is the only authoritative validator. CREATE
-- AGENT errors on unknown spec fields, and the public docs disagree with
-- themselves on the release stage of several tools (code_execution is described
-- with different availability on the manage page and on the tool page). So
-- rather than guess, create a throwaway
-- agent per feature, record whether it parsed, and drop it.
--
-- 07_agent_optional.sql reads CAPABILITY_PROBE and only applies what passed.
-- That is what stops one unavailable preview feature from failing the build.
--
-- Safe to re-run: each probe agent is CREATE OR REPLACE then DROP, under a name
-- that no other object uses.

CREATE SCHEMA IF NOT EXISTS SUPERSTORE.AGENTS;

-- The skills probe references a stage path, so the stage has to exist before the
-- probe runs or it fails for the wrong reason. 01_schema.sql creates this too;
-- both are IF NOT EXISTS, and 00 has to be able to run standalone.
CREATE STAGE IF NOT EXISTS SUPERSTORE.AGENTS.SKILLS
  DIRECTORY = (ENABLE = TRUE)
  COMMENT = 'Agent skill folders (SKILL.md + scripts) for SUPERSTORE_360_AGENT';

CREATE TABLE IF NOT EXISTS SUPERSTORE.AGENTS.CAPABILITY_PROBE (
  FEATURE        VARCHAR NOT NULL,
  SUPPORTED      BOOLEAN NOT NULL,
  ERROR_MESSAGE  VARCHAR,
  PROBED_AT      TIMESTAMP_LTZ NOT NULL
);

-- One anonymous block per feature would be repetitive, so drive it from a list.
-- Each spec is minimal: just enough to force the parser to look at the field
-- under test. A probe that needs a real object it cannot have would fail for
-- the wrong reason, so probes that reference an object (cortex_search_*,
-- mcp_servers) deliberately point at one that does not exist and rely on the
-- ERROR_MESSAGE interpretation notes below to tell "field rejected" apart from
-- "object not found."
EXECUTE IMMEDIATE $$
DECLARE
  probes ARRAY := [
    -- [ feature label, spec fragment appended inside the agent spec ]
    ['web_search',
     '"tools":[{"tool_spec":{"type":"web_search","name":"probe_web"}}],
      "tool_resources":{"probe_web":{"max_results":5}}'],

    ['cortex_search_max_results_1000',
     '"tools":[{"tool_spec":{"type":"cortex_search","name":"probe_search"}}],
      "tool_resources":{"probe_search":{"search_service":"SUPERSTORE.AGENTS.__NONEXISTENT__","max_results":1000}}'],

    ['code_execution',
     '"tools":[{"tool_spec":{"type":"code_execution","name":"code_execution"}}],
      "tool_resources":{"code_execution":{"permission_policy":{"type":"always_allow"}}}'],

    -- No "description" key here on purpose. The docs show one, but this account's
    -- parser rejects it with "unrecognized field description" -- the description
    -- lives in the skill folder's SKILL.md frontmatter, not in the agent spec.
    ['skills_stage_source',
     '"skills":[{"name":"probe_skill",
                 "source":{"type":"STAGE","path":"@SUPERSTORE.AGENTS.SKILLS/probe"}}]'],

    ['mcp_servers',
     '"mcp_servers":[{"server_spec":{"name":"SUPERSTORE.AGENTS.__NONEXISTENT_MCP__"}}]'],

    ['agent_toolset',
     '"tools":[{"tool_spec":{"type":"agent_toolset","name":"probe_toolset"}}],
      "tool_resources":{"probe_toolset":{"agent_name":"SUPERSTORE.PUBLIC.SUPERSTORE_SALES_AGENT"}}']
  ];
  feature   VARCHAR;
  fragment  VARCHAR;
  spec      VARCHAR;
  ok        BOOLEAN;
  err       VARCHAR;
BEGIN
  DELETE FROM SUPERSTORE.AGENTS.CAPABILITY_PROBE;

  FOR i IN 0 TO ARRAY_SIZE(:probes) - 1 DO
    feature  := GET(GET(:probes, :i), 0)::VARCHAR;
    fragment := GET(GET(:probes, :i), 1)::VARCHAR;
    spec     := '{"models":{"orchestration":"auto"},' || :fragment || '}';
    ok       := TRUE;
    err      := NULL;

    -- FROM SPECIFICATION accepts a plain single-quoted string literal, not just a
    -- dollar-quoted one. That is what makes this work: Snowflake has no custom
    -- dollar-quote tags (a $CAP$ tag is a syntax error), and a nested pair of
    -- dollar signs would terminate the block this loop lives inside. For the same
    -- reason, do not write that delimiter literally anywhere in this file's
    -- comments -- the parser ends the block on it even inside a comment.
    BEGIN
      EXECUTE IMMEDIATE
        'CREATE OR REPLACE AGENT SUPERSTORE.AGENTS.__CAPABILITY_PROBE__ '
        || 'FROM SPECIFICATION ''' || REPLACE(:spec, '''', '''''') || '''';
    EXCEPTION
      WHEN OTHER THEN
        ok  := FALSE;
        err := SQLERRM;
    END;

    INSERT INTO SUPERSTORE.AGENTS.CAPABILITY_PROBE
      (FEATURE, SUPPORTED, ERROR_MESSAGE, PROBED_AT)
      SELECT :feature, :ok, :err, CURRENT_TIMESTAMP();
  END FOR;

  DROP AGENT IF EXISTS SUPERSTORE.AGENTS.__CAPABILITY_PROBE__;
  RETURN 'probed ' || ARRAY_SIZE(:probes) || ' features';
END;
$$;

-- Note on interpreting cortex_search_max_results_1000: the probe points at a
-- deliberately nonexistent search service, so a failure mentioning the service
-- name means max_results:1000 itself was fine and only object resolution failed.
-- 07 treats that case as supported; read ERROR_MESSAGE before believing FALSE.
--
-- Note on interpreting mcp_servers: same technique, deliberately pointed at
-- SUPERSTORE.AGENTS.__NONEXISTENT_MCP__ rather than a real server, so this probe
-- has no dependency on an MCP server existing anywhere yet (07 creates the real
-- one this account will actually use, after 03/04 create what it wraps). A
-- failure mentioning __NONEXISTENT_MCP__ means the mcp_servers field parsed
-- fine and only object resolution failed; 07 treats that case as supported too.
SELECT FEATURE, SUPPORTED, LEFT(COALESCE(ERROR_MESSAGE, ''), 300) AS ERROR_MESSAGE
FROM SUPERSTORE.AGENTS.CAPABILITY_PROBE
ORDER BY FEATURE;
