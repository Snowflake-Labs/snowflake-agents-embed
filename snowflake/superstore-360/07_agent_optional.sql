-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Add the optional / preview tool types, but only the ones this account accepts.
--
-- Reads SUPERSTORE.AGENTS.CAPABILITY_PROBE (written by 00) and applies:
--   web_search           -> a web_search tool
--   code_execution       -> a Python sandbox tool
--   skills_stage_source  -> the review_analyst skill, which NEEDS code_execution
--   mcp_servers          -> a native MCP server this script creates, wrapping
--                           Review_Search and Superstore_Analyst
--
-- The critical mechanic: ALTER AGENT ... SET SPECIFICATION REPLACES THE ENTIRE
-- SPEC. Any key left out is deleted, so this cannot append - it has to read the
-- current spec back with DESCRIBE AGENT, merge into it, and write the whole
-- document. Getting that wrong silently strips the six tools that 06 just created.
--
-- Idempotent: a tool whose name is already present is skipped, so running this
-- twice (or with --only 07) does not duplicate entries.

EXECUTE IMMEDIATE $$
DECLARE
  spec      VARIANT;
  tools     ARRAY;
  tres      OBJECT;
  names     ARRAY;
  applied   ARRAY := [];
  skipped   ARRAY := [];
  can       BOOLEAN;
BEGIN
  -- Current live spec. RESULT_SCAN on the DESCRIBE is the only way to get at it
  -- from scripting; the column name is lower-case and so must be quoted.
  DESCRIBE AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT;
  SELECT PARSE_JSON("agent_spec") INTO :spec
  FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

  tools := COALESCE(:spec:tools::ARRAY, []);
  tres  := COALESCE(:spec:tool_resources::OBJECT, {});

  SELECT COALESCE(ARRAY_AGG(f.value:tool_spec:name::VARCHAR), [])
    INTO :names
  FROM TABLE(FLATTEN(input => :tools)) f;

  -- ---------------- web_search ----------------
  SELECT COALESCE(MAX(SUPPORTED), FALSE) INTO :can
  FROM SUPERSTORE.AGENTS.CAPABILITY_PROBE WHERE FEATURE = 'web_search';

  IF (:can AND NOT ARRAY_CONTAINS('web_search'::VARIANT, :names)) THEN
    tools := ARRAY_APPEND(:tools, {
      'tool_spec': {
        'type': 'web_search',
        'name': 'web_search',
        'description': 'Search the public web. Use only for context the Superstore data cannot supply, such as an industry benchmark or a supplier being in the news. Never use it for figures about our own sales, products or customers.'
      }}::VARIANT);
    tres    := OBJECT_INSERT(:tres, 'web_search', {'max_results': 5}::VARIANT, TRUE);
    applied := ARRAY_APPEND(:applied, 'web_search'::VARIANT);
  ELSE
    skipped := ARRAY_APPEND(:skipped, 'web_search'::VARIANT);
  END IF;

  -- ---------------- code_execution ----------------
  SELECT COALESCE(MAX(SUPPORTED), FALSE) INTO :can
  FROM SUPERSTORE.AGENTS.CAPABILITY_PROBE WHERE FEATURE = 'code_execution';

  IF (:can AND NOT ARRAY_CONTAINS('code_execution'::VARIANT, :names)) THEN
    tools := ARRAY_APPEND(:tools, {
      'tool_spec': {
        'type': 'code_execution',
        'name': 'code_execution',
        'description': 'Run Python over data already retrieved, for statistics, correlations, clustering or reshaping that SQL handles awkwardly. Do not use it to fetch data - the Analyst tool does that.'
      }}::VARIANT);
    -- always_allow, not always_ask: an interactive permission prompt mid-turn
    -- would block the Teams client, which has only a fallback UI
    -- for permission_decision.
    tres    := OBJECT_INSERT(:tres, 'code_execution',
                 {'permission_policy': {'type': 'always_allow'}}::VARIANT, TRUE);
    applied := ARRAY_APPEND(:applied, 'code_execution'::VARIANT);
  ELSE
    skipped := ARRAY_APPEND(:skipped, 'code_execution'::VARIANT);
  END IF;

  -- ---------------- skills ----------------
  -- Skills execute through the code-execution capability, so requiring both is
  -- not belt-and-braces: a skill without code execution is inert.
  LET can_skills BOOLEAN := (
    SELECT COALESCE(MAX(IFF(FEATURE = 'skills_stage_source', SUPPORTED, NULL)), FALSE)
       AND COALESCE(MAX(IFF(FEATURE = 'code_execution',      SUPPORTED, NULL)), FALSE)
    FROM SUPERSTORE.AGENTS.CAPABILITY_PROBE
  );

  IF (:can_skills) THEN
    -- No "description" key: this account's parser rejects it with "unrecognized
    -- field description". The description lives in SKILL.md frontmatter.
    spec    := OBJECT_INSERT(:spec, 'skills', [
                 {'name': 'review_analyst',
                  'source': {'type': 'STAGE',
                             'path': '@SUPERSTORE.AGENTS.SKILLS/review_analyst'}}
               ]::VARIANT, TRUE);
    applied := ARRAY_APPEND(:applied, 'skills:review_analyst'::VARIANT);
  ELSE
    skipped := ARRAY_APPEND(:skipped, 'skills:review_analyst'::VARIANT);
  END IF;

  -- ---------------- native MCP server ----------------
  -- A Snowflake-managed MCP server (CREATE MCP SERVER, not CREATE EXTERNAL MCP
  -- SERVER) wrapping two objects this schema already owns - Review_Search and
  -- the Superstore_Analyst semantic view. No external database, API
  -- integration, or per-user OAuth to provision: USAGE on the server is
  -- enough on its own, since the search-service/semantic-view grants
  -- 08_grants.sql already applies cover what it wraps.
  --
  -- Creation is attempted unconditionally (not gated on the capability check
  -- below) because it is a different object type than the agent-spec field;
  -- an account could support one without the other. Note this reference is
  -- SILENTLY SKIPPED at run time if the caller's role lacks USAGE on the
  -- server - the run succeeds and nothing is annotated. 08_grants.sql grants
  -- it; 09_verify.sql asserts the grant and the server's tool count.
  LET mcp_created BOOLEAN := TRUE;
  BEGIN
    EXECUTE IMMEDIATE
      'CREATE OR REPLACE MCP SERVER SUPERSTORE.AGENTS.SUPERSTORE_DEMO_MCP FROM SPECIFICATION '''
      || 'tools: [{name: "product_review_search", type: "CORTEX_SEARCH_SERVICE_QUERY", '
      || 'identifier: "SUPERSTORE.AGENTS.PRODUCT_REVIEWS_SEARCH", title: "Product Review Search", '
      || 'description: "Search the Superstore product review corpus."}, '
      || '{name: "superstore_analyst", type: "CORTEX_ANALYST_MESSAGE", '
      || 'identifier: "SUPERSTORE.AGENTS.SUPERSTORE_360", title: "Superstore Analyst", '
      || 'description: "Ask analytical questions against Superstore sales, returns and review data."}]'
      || '''';
  EXCEPTION
    WHEN OTHER THEN
      mcp_created := FALSE;
  END;

  -- __NONEXISTENT_MCP__ is the placeholder 00 probes with - see the note there.
  -- A failure that only mentions it means mcp_servers itself is fine and this
  -- account's parser just couldn't resolve that made-up name, which is exactly
  -- the "supported" case.
  SELECT COALESCE(MAX(SUPPORTED OR ERROR_MESSAGE ILIKE '%__NONEXISTENT_MCP__%'), FALSE) INTO :can
  FROM SUPERSTORE.AGENTS.CAPABILITY_PROBE WHERE FEATURE = 'mcp_servers';

  IF (:mcp_created AND :can) THEN
    spec    := OBJECT_INSERT(:spec, 'mcp_servers', [
                 {'server_spec': {'name': 'SUPERSTORE.AGENTS.SUPERSTORE_DEMO_MCP'}}
               ]::VARIANT, TRUE);
    applied := ARRAY_APPEND(:applied, 'mcp_servers:SUPERSTORE_DEMO_MCP'::VARIANT);
  ELSEIF (:can) THEN
    skipped := ARRAY_APPEND(:skipped, 'mcp_servers:SUPERSTORE_DEMO_MCP (server object could not be created)'::VARIANT);
  ELSE
    skipped := ARRAY_APPEND(:skipped, 'mcp_servers:SUPERSTORE_DEMO_MCP (field not accepted)'::VARIANT);
  END IF;

  -- ---------------- write the WHOLE spec back ----------------
  spec := OBJECT_INSERT(:spec, 'tools',          :tools::VARIANT, TRUE);
  spec := OBJECT_INSERT(:spec, 'tool_resources', :tres::VARIANT,  TRUE);

  -- Two non-obvious requirements in this one statement:
  --
  -- 1. The "=" is mandatory. CREATE AGENT is "FROM SPECIFICATION <spec>" with no
  --    equals sign; ALTER is "SET SPECIFICATION = <spec>". Omitting it gives a
  --    syntax error pointing at the start of the spec, which reads as though the
  --    spec were malformed rather than the statement.
  --
  -- 2. The spec MUST be dollar-quoted, not passed as a single-quoted literal.
  --    Snowflake interprets backslash escapes inside single-quoted strings, so
  --    TO_JSON's \" and \n arrive at the parser as a bare quote and a real
  --    newline - which silently corrupts the JSON. The symptom is a bafflingly
  --    selective "agent spec is invalid": instructions.response round-trips fine
  --    while instructions.system and instructions.orchestration fail, purely
  --    because only the latter two happen to contain double quotes.
  --
  -- The delimiter is built with CHR(36) because writing it literally here would
  -- terminate the block this code lives in.
  LET dq VARCHAR := CHR(36) || CHR(36);
  EXECUTE IMMEDIATE
    'ALTER AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT '
    || 'MODIFY LIVE VERSION SET SPECIFICATION = '
    || :dq || TO_JSON(:spec) || :dq;

  RETURN 'applied: ' || ARRAY_TO_STRING(:applied, ', ')
         || IFF(ARRAY_SIZE(:skipped) > 0,
                ' | skipped: ' || ARRAY_TO_STRING(:skipped, ', '),
                ' | skipped: none');
END;
$$;

-- Snapshot the spec as an immutable version, so there is something to roll back
-- to and something the relay can pin while the live spec is being edited.
-- Wrapped because COMMIT fails if the live version is unchanged since the last
-- one, which is exactly what happens on a re-run.
--
-- COMMIT alone is not enough: DESCRIBE AGENT (and therefore every unversioned
-- caller, including 09_verify.sql and both hosts' relays) resolves to the
-- DEFAULT version, not the newly committed one or LIVE. Skipping the
-- SET DEFAULT_VERSION step below leaves the commit invisible - everything
-- keeps serving whatever was DEFAULT before this run, silently.
EXECUTE IMMEDIATE $$
BEGIN
  ALTER AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT
    COMMIT COMMENT = 'superstore-360 full tool surface';
  ALTER AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT
    SET DEFAULT_VERSION = 'LAST';
  RETURN 'committed a new version and promoted it to DEFAULT';
EXCEPTION
  WHEN OTHER THEN
    RETURN 'no new version committed (spec unchanged since last commit): ' || SQLERRM;
END;
$$;

-- Final tool inventory, which is the thing to eyeball: every tool 06 created must
-- still be here. If the count dropped, the merge above replaced rather than
-- extended and needs fixing before anything else is trusted.
DESCRIBE AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT;

SELECT
  f.value:tool_spec:type::VARCHAR AS TOOL_TYPE,
  f.value:tool_spec:name::VARCHAR AS TOOL_NAME
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) d,
LATERAL FLATTEN(input => PARSE_JSON(d."agent_spec"):tools) f
ORDER BY TOOL_TYPE, TOOL_NAME;

-- Skills and MCP servers are top-level spec keys, not tools, so they need their
-- own look.
DESCRIBE AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT;

SELECT
  PARSE_JSON(d."agent_spec"):skills      AS SKILLS,
  PARSE_JSON(d."agent_spec"):mcp_servers AS MCP_SERVERS,
  d."versions"                           AS VERSIONS
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) d;
