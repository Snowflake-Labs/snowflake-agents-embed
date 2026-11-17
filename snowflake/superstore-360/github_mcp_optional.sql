-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- OPTIONAL. Not part of the build: run-all.sh only picks up `[0-9][0-9]_*.sql`,
-- and this file deliberately has no numeric prefix so a normal build never
-- touches it and never fails over the placeholders below.
--
-- Reproduces the external-MCP + per-user-OAuth + 003001-warning flow against a
-- free, self-service GitHub OAuth App instead of a custom integration —
-- so anyone can run this. It attaches alongside 07_agent_optional.sql's native
-- SUPERSTORE_DEMO_MCP, not in place of it.
--
-- One-time manual prerequisite (free, ~5 minutes):
--   1. https://github.com/settings/developers -> New OAuth App.
--   2. Homepage URL: anything (e.g. https://github.com). Authorization
--      callback URL: https://identity.snowflake.com/oauth2/callback - this is
--      Snowflake's fixed callback for external MCP connectors, not a URL you
--      choose.
--   3. Generate a client secret. Note the client ID and secret.
--
-- Fill in the two placeholders below, then:
--   snow sql -c demo -f github_mcp_optional.sql

CREATE API INTEGRATION IF NOT EXISTS GITHUB_MCP_INTEGRATION
  API_PROVIDER = external_mcp
  API_ALLOWED_PREFIXES = ('https://api.githubcopilot.com/mcp')
  API_USER_AUTHENTICATION = (
    TYPE = OAUTH2
    OAUTH_CLIENT_ID = '<your GitHub OAuth App client ID>'
    OAUTH_CLIENT_SECRET = '<your GitHub OAuth App client secret>'
    OAUTH_AUTHORIZATION_ENDPOINT = 'https://github.com/login/oauth/authorize'
    OAUTH_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token'
  )
  ENABLED = TRUE;

CREATE EXTERNAL MCP SERVER IF NOT EXISTS SUPERSTORE.AGENTS.GITHUB_MCP
  WITH DISPLAY_NAME = 'GitHub'
       URL = 'https://api.githubcopilot.com/mcp'
       API_INTEGRATION = GITHUB_MCP_INTEGRATION;

-- Same two roles, same grant shape as 08_grants.sql - kept separate here so a
-- normal build (which never runs this file) never depends on GITHUB_MCP
-- existing.
GRANT USAGE ON EXTERNAL MCP SERVER SUPERSTORE.AGENTS.GITHUB_MCP TO ROLE AGENTS_TEAMS_USER;
GRANT USAGE ON EXTERNAL MCP SERVER SUPERSTORE.AGENTS.GITHUB_MCP TO ROLE AGENTS_TEAMS_USER;
GRANT USAGE ON INTEGRATION GITHUB_MCP_INTEGRATION TO ROLE AGENTS_TEAMS_USER;
GRANT USAGE ON INTEGRATION GITHUB_MCP_INTEGRATION TO ROLE AGENTS_TEAMS_USER;

-- Append GITHUB_MCP to whatever mcp_servers array the agent already has,
-- rather than replacing it - SET SPECIFICATION replaces the whole spec, so
-- this reads the live spec back first, same mechanic as 07_agent_optional.sql.
EXECUTE IMMEDIATE $$
DECLARE
  spec  VARIANT;
  mcps  ARRAY;
  names ARRAY;
BEGIN
  DESCRIBE AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT;
  SELECT PARSE_JSON("agent_spec") INTO :spec
  FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

  mcps := COALESCE(:spec:mcp_servers::ARRAY, []);

  SELECT COALESCE(ARRAY_AGG(f.value:server_spec:name::VARCHAR), []) INTO :names
  FROM TABLE(FLATTEN(input => :mcps)) f;

  IF (NOT ARRAY_CONTAINS('SUPERSTORE.AGENTS.GITHUB_MCP'::VARIANT, :names)) THEN
    mcps := ARRAY_APPEND(:mcps, {'server_spec': {'name': 'SUPERSTORE.AGENTS.GITHUB_MCP'}}::VARIANT);
  END IF;

  spec := OBJECT_INSERT(:spec, 'mcp_servers', :mcps::VARIANT, TRUE);

  LET dq VARCHAR := CHR(36) || CHR(36);
  EXECUTE IMMEDIATE
    'ALTER AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT '
    || 'MODIFY LIVE VERSION SET SPECIFICATION = '
    || :dq || TO_JSON(:spec) || :dq;

  RETURN 'mcp_servers count: ' || ARRAY_SIZE(:mcps);
END;
$$;

-- Snapshot a version, same reasoning as 07_agent_optional.sql: something to
-- roll back to, and something the relay can pin while the live spec is edited.
-- Also promotes it to DEFAULT - COMMIT alone leaves the change invisible to
-- DESCRIBE AGENT and every unversioned caller, which resolve to DEFAULT, not
-- the newly committed version or LIVE.
EXECUTE IMMEDIATE $$
BEGIN
  ALTER AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT
    COMMIT COMMENT = 'attach GITHUB_MCP for external-OAuth demo/testing';
  ALTER AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT
    SET DEFAULT_VERSION = 'LAST';
  RETURN 'committed a new version and promoted it to DEFAULT';
EXCEPTION
  WHEN OTHER THEN
    RETURN 'no new version committed (spec unchanged since last commit): ' || SQLERRM;
END;
$$;

-- Eyeball: both servers should be present, and the OAuth warning should now
-- reproduce on a turn where the agent tries to use a GitHub-flavored question
-- before the user has connected. See README.md's "response.warning" gap for
-- what to check on the client side.
DESCRIBE AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT;

SELECT PARSE_JSON(d."agent_spec"):mcp_servers AS MCP_SERVERS
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) d;
