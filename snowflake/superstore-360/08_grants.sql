-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Grants for the Teams host role.
--
-- AGENTS_TEAMS_USER is the role the Teams deployment signs users in as. The role and
-- statement lists are arrays so another host role can be added by appending a name,
-- and every host role then gets identical access.
--
-- Three things here are less obvious than they look:
--
--  * SELECT ON SEMANTIC VIEW is not sufficient. Agents also need SELECT on the
--    tables the view reads - SUPERSTORE.PUBLIC.ORDERS_V / RETURNS_V / PEOPLE_V and
--    SUPERSTORE.AGENTS.PRODUCTS / PRODUCT_REVIEWS. The PUBLIC ones are already
--    covered by the existing bootstrap grants; the AGENTS ones are granted below.
--
--  * A missing MCP grant fails SILENTLY. The server reference is skipped, the run
--    still succeeds, and nothing is annotated - so a demo just quietly has no
--    mcp_servers capability. Never infer that grant is present from a turn
--    that worked.
--
--  * Cortex Agents resolve permissions from the querying user's DEFAULT role, not
--    the currently active one, and that default role needs a default warehouse
--    with USAGE. This script grants the role; whether each identity's DEFAULT_ROLE
--    points at it is checked in 09.

EXECUTE IMMEDIATE $$
DECLARE
  roles ARRAY := ['AGENTS_TEAMS_USER'];
  -- Every statement carries a {role} placeholder, substituted per role. Kept as
  -- one list so a new grant is added once rather than twice.
  stmts ARRAY := [
    -- Cortex entitlement and compute.
    'GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE {role}',
    'GRANT USAGE ON WAREHOUSE XSMALL TO ROLE {role}',

    -- Reaching the agent at all.
    'GRANT USAGE ON DATABASE SUPERSTORE TO ROLE {role}',
    'GRANT USAGE ON SCHEMA SUPERSTORE.AGENTS TO ROLE {role}',
    'GRANT USAGE ON AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT TO ROLE {role}',

    -- Analyst: the semantic view, plus the tables behind it.
    'GRANT SELECT ON SEMANTIC VIEW SUPERSTORE.AGENTS.SUPERSTORE_360 TO ROLE {role}',
    'GRANT SELECT ON ALL TABLES IN SCHEMA SUPERSTORE.AGENTS TO ROLE {role}',
    'GRANT SELECT ON FUTURE TABLES IN SCHEMA SUPERSTORE.AGENTS TO ROLE {role}',
    'GRANT SELECT ON ALL VIEWS IN SCHEMA SUPERSTORE.AGENTS TO ROLE {role}',
    'GRANT SELECT ON FUTURE VIEWS IN SCHEMA SUPERSTORE.AGENTS TO ROLE {role}',
    -- The semantic view reads the *_V views in PUBLIC. Granted here for every
    -- host role so a host bootstrap never has to repeat Superstore grants.
    'GRANT USAGE ON SCHEMA SUPERSTORE.PUBLIC TO ROLE {role}',
    'GRANT SELECT ON ALL VIEWS IN SCHEMA SUPERSTORE.PUBLIC TO ROLE {role}',

    -- Cortex Search.
    'GRANT USAGE ON CORTEX SEARCH SERVICE SUPERSTORE.AGENTS.PRODUCT_REVIEWS_SEARCH TO ROLE {role}',

    -- The three generic tools. Argument types are required in the grant target.
    'GRANT USAGE ON FUNCTION SUPERSTORE.AGENTS.FORECAST_SALES(VARCHAR, NUMBER) TO ROLE {role}',
    'GRANT USAGE ON FUNCTION SUPERSTORE.AGENTS.CUSTOMER_HEALTH_SCORE(VARCHAR) TO ROLE {role}',
    'GRANT USAGE ON FUNCTION SUPERSTORE.AGENTS.SUMMARISE_PRODUCT_REVIEWS(VARCHAR) TO ROLE {role}',

    -- Skills are read from this stage by the code-execution sandbox.
    'GRANT READ ON STAGE SUPERSTORE.AGENTS.SKILLS TO ROLE {role}',

    -- Native MCP server (07_agent_optional.sql creates it, wrapping the search
    -- service and semantic view granted above). Plain MCP SERVER, not EXTERNAL
    -- MCP SERVER - a Snowflake-managed server (CREATE MCP SERVER) and a
    -- connector to a remote one (CREATE EXTERNAL MCP SERVER) are separate
    -- object types with separate grant targets; using the wrong one fails with
    -- "Agent Server ... does not exist or not authorized", which reads like a
    -- missing object rather than the wrong keyword. No external database or
    -- API integration grant is needed here - that's the point of the native
    -- kind over an external one.
    'GRANT USAGE ON MCP SERVER SUPERSTORE.AGENTS.SUPERSTORE_DEMO_MCP TO ROLE {role}'
  ];
  rl      VARCHAR;
  sql     VARCHAR;
  okc     INT := 0;
  failed  ARRAY := [];
BEGIN
  FOR r IN 0 TO ARRAY_SIZE(:roles) - 1 DO
    rl := GET(:roles, :r)::VARCHAR;
    FOR i IN 0 TO ARRAY_SIZE(:stmts) - 1 DO
      sql := REPLACE(GET(:stmts, :i)::VARCHAR, '{role}', :rl);
      BEGIN
        EXECUTE IMMEDIATE :sql;
        okc := okc + 1;
      EXCEPTION
        -- Collect rather than abort. One unavailable object (a dropped MCP server,
        -- say) should not leave the role half-granted, and the summary makes
        -- the gap visible instead of hiding it behind a stack trace.
        WHEN OTHER THEN
          failed := ARRAY_APPEND(:failed, (:rl || ': ' || :sql || ' -> ' || SQLERRM)::VARIANT);
      END;
    END FOR;
  END FOR;

  RETURN 'granted ' || okc || ' of ' || (ARRAY_SIZE(:roles) * ARRAY_SIZE(:stmts))
         || IFF(ARRAY_SIZE(:failed) > 0,
                ' | FAILURES: ' || ARRAY_TO_STRING(:failed, ' || '),
                ' | no failures');
END;
$$;

SHOW GRANTS TO ROLE AGENTS_TEAMS_USER;
SELECT "privilege", "granted_on", "name"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "name" ILIKE '%SUPERSTORE.AGENTS%'
ORDER BY "granted_on", "name";
