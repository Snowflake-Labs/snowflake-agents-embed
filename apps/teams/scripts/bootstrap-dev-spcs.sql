-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Bootstrap for the standalone Teams SPCS service (install-teams.md Path A).
-- Idempotent (IF NOT EXISTS throughout) — safe to re-run.
--
-- This is NOT the Native App setup.sql — no APPLICATION ROLE, no AGENTS_TEAMS_APP,
-- no manifest.yml. Account objects only. CREATE SERVICE is
-- apps/teams/scripts/create-dev-service.sql (SYSADMIN). deploy-spcs.sh later
-- rolls AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS. Image path is IMAGE_REPO, not
-- NA_IMAGE_REPO (that repo is Path B / native-app-release.sh only).
--
-- Run as a role with CREATE DATABASE / COMPUTE POOL / INTEGRATION on account
-- (ACCOUNTADMIN for the one-time section). CREATE SERVICE itself as SYSADMIN —
-- Snowflake does not allow ACCOUNTADMIN to own a service (ingress RBAC
-- misbehaves under that owner).
--
-- Operator order (see docs/install-teams.md Path A):
--   1. This file through the ACCOUNTADMIN section
--   2. Create the Entra apps (wizard tabs 1-6) and fill apps/teams/.env
--   3. bash apps/teams/scripts/fill-dev-secrets.sh
--      snow sql --silent --enable-templating none -f temp/alter-teams-secrets.sql
--   4. bash apps/teams/scripts/push-dev-image.sh
--   5. snow sql -f apps/teams/scripts/create-dev-service.sql (replace TAB_BASE_HOST)
--   6. bash apps/teams/scripts/deploy-spcs.sh
--   7. bash apps/teams/scripts/deploy-tab.sh
--
-- Private connectivity (optional, NETWORK_MODE=hybrid|privatelink in .env): see
-- docs/install-teams.md "Private connectivity". Before step 5, apply the
-- COMPUTE_POOL network rule on CORTEX_TEAMS_OAUTH (the Native App wizard's
-- Network tab generates the same SQL), and in create-dev-service.sql set
-- SNOWFLAKE_HOST_MODE to internal and uncomment its capabilities block. Keep
-- SNOWFLAKE_ACCOUNT_NAME below in the org-account form even then: the
-- .privatelink host does not resolve inside SPCS.

-- ── One-time account objects (ACCOUNTADMIN) ─────────────────────────────────
CREATE DATABASE IF NOT EXISTS AGENTS_TEAMS_APP_DB;
CREATE SCHEMA IF NOT EXISTS AGENTS_TEAMS_APP_DB.PUBLIC;
CREATE SCHEMA IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG;
CREATE IMAGE REPOSITORY IF NOT EXISTS AGENTS_TEAMS_APP_DB.PUBLIC.IMAGE_REPO;
CREATE COMPUTE POOL IF NOT EXISTS AGENTS_TEAMS_APP_POOL
  MIN_NODES = 1
  MAX_NODES = 1
  INSTANCE_FAMILY = CPU_X64_XS
  AUTO_RESUME = TRUE
  AUTO_SUSPEND_SECS = 3600;

-- Egress: Entra / Bot Framework plus this account's Cortex host forms.
EXECUTE IMMEDIATE $$
DECLARE
  hyphen_host STRING;
  underscore_host STRING;
  locator_host STRING;
  region STRING;
  cloud STRING;
  region_id STRING;
BEGIN
  hyphen_host := LOWER(CURRENT_ORGANIZATION_NAME()) || '-' || REPLACE(LOWER(CURRENT_ACCOUNT_NAME()), '_', '-') || '.snowflakecomputing.com:443';
  underscore_host := LOWER(CURRENT_ORGANIZATION_NAME()) || '-' || LOWER(CURRENT_ACCOUNT_NAME()) || '.snowflakecomputing.com:443';
  region := CURRENT_REGION();
  cloud := LOWER(SPLIT_PART(region, '_', 1));
  region_id := REPLACE(LOWER(SUBSTR(region, LENGTH(cloud) + 2)), '_', '-');
  locator_host := LOWER(CURRENT_ACCOUNT()) || '.' || region_id || '.' || cloud || '.snowflakecomputing.com:443';
  EXECUTE IMMEDIATE 'CREATE OR REPLACE NETWORK RULE AGENTS_TEAMS_APP_DB.PUBLIC.MSFT_EGRESS MODE = EGRESS TYPE = HOST_PORT ' ||
    'VALUE_LIST = (''login.microsoftonline.com'', ''smba.trafficmanager.net'', ''login.botframework.com'', ''' ||
    hyphen_host || ''', ''' || underscore_host || ''', ''' || locator_host || ''')';
  RETURN 'created network rule including ' || hyphen_host;
END;
$$;

CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS AGENTS_TEAMS_EAI
  ALLOWED_NETWORK_RULES = (AGENTS_TEAMS_APP_DB.PUBLIC.MSFT_EGRESS)
  ENABLED = TRUE;

-- Rebind to the (possibly replaced) network-rule object id. CREATE IF NOT EXISTS
-- leaves a leftover EAI on the previous id. A Path B leftover is owned by
-- AGENTS_TEAMS_APP — ACCOUNTADMIN has no ALTER until it owns the object
-- (003001 / MODIFY). COPY CURRENT GRANTS is rejected on app-owned objects
-- (093154). REVOKE drops outbound USAGE (including the Native App's); Path A
-- re-grants SYSADMIN below. If GRANT OWNERSHIP still fails, tear down Path B
-- (`snow app teardown --cascade`) and re-run — do not DROP while the app owns it.
GRANT OWNERSHIP ON INTEGRATION AGENTS_TEAMS_EAI TO ROLE ACCOUNTADMIN REVOKE CURRENT GRANTS;

ALTER EXTERNAL ACCESS INTEGRATION AGENTS_TEAMS_EAI
  SET ALLOWED_NETWORK_RULES = (AGENTS_TEAMS_APP_DB.PUBLIC.MSFT_EGRESS)
      ENABLED = TRUE;

CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.BOT_APP_ID
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.BOT_APP_SECRET
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.OBO_CLIENT_ID
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.OBO_CLIENT_SECRET
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.DEFAULT_AGENT_FQN
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.TEAMS_APP_ID
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.AGENT_ALLOW_LIST
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.AZURE_TENANT_ID
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.SNOWFLAKE_SCOPE
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.APPS_API_HOST
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.ALLOWED_ORIGINS
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS AGENTS_TEAMS_APP_DB.CONFIG.SNOWFLAKE_ACCOUNT_NAME
  TYPE = GENERIC_STRING SECRET_STRING = '';

-- Org-account form (not the locator). The locator silently routes over a private
-- 10.x address from SPCS — see packages/cortex-server snowflakeBase().
EXECUTE IMMEDIATE $$
DECLARE
  account_name STRING;
BEGIN
  account_name := LOWER(CURRENT_ORGANIZATION_NAME()) || '-' || REPLACE(LOWER(CURRENT_ACCOUNT_NAME()), '_', '-');
  EXECUTE IMMEDIATE 'ALTER SECRET AGENTS_TEAMS_APP_DB.CONFIG.SNOWFLAKE_ACCOUNT_NAME SET SECRET_STRING = ''' || account_name || '''';
  RETURN 'SNOWFLAKE_ACCOUNT_NAME=' || account_name;
END;
$$;

CREATE SECURITY INTEGRATION IF NOT EXISTS CORTEX_TEAMS_OAUTH
  TYPE = EXTERNAL_OAUTH
  ENABLED = TRUE
  EXTERNAL_OAUTH_TYPE = AZURE
  EXTERNAL_OAUTH_ISSUER = 'https://login.microsoftonline.com/PLACEHOLDER/v2.0'
  EXTERNAL_OAUTH_JWS_KEYS_URL = 'https://login.microsoftonline.com/PLACEHOLDER/discovery/v2.0/keys'
  EXTERNAL_OAUTH_AUDIENCE_LIST = ('api://PLACEHOLDER', 'PLACEHOLDER')
  EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM = ('upn')
  EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = 'login_name'
  -- Dev default. For a pinned role use scope session:role:<ROLE> and 'DISABLE' (fill-dev-secrets.sh
  -- does this when SNOWFLAKE_OAUTH_ROLE is set).
  EXTERNAL_OAUTH_ANY_ROLE_MODE = 'ENABLE';

CREATE ROLE IF NOT EXISTS AGENTS_TEAMS_USER;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE AGENTS_TEAMS_USER;
GRANT USAGE ON DATABASE AGENTS_TEAMS_APP_DB TO ROLE AGENTS_TEAMS_USER;
GRANT USAGE ON SCHEMA AGENTS_TEAMS_APP_DB.PUBLIC TO ROLE AGENTS_TEAMS_USER;
GRANT USAGE ON SCHEMA AGENTS_TEAMS_APP_DB.CONFIG TO ROLE AGENTS_TEAMS_USER;

CREATE USER IF NOT EXISTS AGENTS_TEAMS_SVC
  TYPE = SERVICE
  DEFAULT_ROLE = AGENTS_TEAMS_USER
  COMMENT = 'Dedicated service identity for the Teams edge SPCS_PAT — snowflake-agents-embed Path A';
GRANT ROLE AGENTS_TEAMS_USER TO USER AGENTS_TEAMS_SVC;

-- SYSADMIN grants for CREATE SERVICE (once)
GRANT USAGE ON DATABASE AGENTS_TEAMS_APP_DB TO ROLE SYSADMIN;
GRANT USAGE ON SCHEMA AGENTS_TEAMS_APP_DB.PUBLIC TO ROLE SYSADMIN;
GRANT USAGE ON SCHEMA AGENTS_TEAMS_APP_DB.CONFIG TO ROLE SYSADMIN;
GRANT READ ON IMAGE REPOSITORY AGENTS_TEAMS_APP_DB.PUBLIC.IMAGE_REPO TO ROLE SYSADMIN;
GRANT USAGE, MONITOR, OPERATE ON COMPUTE POOL AGENTS_TEAMS_APP_POOL TO ROLE SYSADMIN;
GRANT USAGE ON INTEGRATION AGENTS_TEAMS_EAI TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.BOT_APP_ID TO ROLE AGENTS_TEAMS_USER;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.BOT_APP_SECRET TO ROLE AGENTS_TEAMS_USER;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.OBO_CLIENT_ID TO ROLE AGENTS_TEAMS_USER;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.OBO_CLIENT_SECRET TO ROLE AGENTS_TEAMS_USER;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.DEFAULT_AGENT_FQN TO ROLE AGENTS_TEAMS_USER;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.TEAMS_APP_ID TO ROLE AGENTS_TEAMS_USER;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.AGENT_ALLOW_LIST TO ROLE AGENTS_TEAMS_USER;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.AZURE_TENANT_ID TO ROLE AGENTS_TEAMS_USER;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.SNOWFLAKE_SCOPE TO ROLE AGENTS_TEAMS_USER;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.APPS_API_HOST TO ROLE AGENTS_TEAMS_USER;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.ALLOWED_ORIGINS TO ROLE AGENTS_TEAMS_USER;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.SNOWFLAKE_ACCOUNT_NAME TO ROLE AGENTS_TEAMS_USER;
-- SYSADMIN creates the service, and CREATE SERVICE fails with "Secret ... does not exist or not
-- authorized" unless the creating role can READ every secret the spec references.
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.BOT_APP_ID TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.BOT_APP_SECRET TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.OBO_CLIENT_ID TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.OBO_CLIENT_SECRET TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.DEFAULT_AGENT_FQN TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.TEAMS_APP_ID TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.AGENT_ALLOW_LIST TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.AZURE_TENANT_ID TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.SNOWFLAKE_SCOPE TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.APPS_API_HOST TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.ALLOWED_ORIGINS TO ROLE SYSADMIN;
GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.SNOWFLAKE_ACCOUNT_NAME TO ROLE SYSADMIN;
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO ROLE SYSADMIN;
GRANT CREATE SERVICE ON SCHEMA AGENTS_TEAMS_APP_DB.PUBLIC TO ROLE SYSADMIN;

-- Mint a PAT for the edge SPCS_PAT (printed once). Skip if the user already has one.
-- ROLE_RESTRICTION is mandatory: without it the PAT carries every role the service user has,
-- and anyone who can reach the edge proxy acts as that user. Keep it set to a role that can
-- only use the ingress endpoint.
-- ALTER USER AGENTS_TEAMS_SVC ADD PROGRAMMATIC ACCESS TOKEN AGENTS_TEAMS_INGRESS_PAT
--   ROLE_RESTRICTION = 'AGENTS_TEAMS_USER' DAYS_TO_EXPIRY = 90;

-- Once the Entra apps exist, fill secrets from .env (do not leave SECRET_STRING empty
-- except AGENT_ALLOW_LIST, which may be []). Then ALTER CORTEX_TEAMS_OAUTH issuer /
-- JWKS / audience to the real tenant and Snowflake Entra app id.

-- ── Create the service (SYSADMIN — NOT ACCOUNTADMIN) ─────────────────────────
-- Use apps/teams/scripts/create-dev-service.sql instead of uncommenting below.
-- Push :latest to IMAGE_REPO first. Replace REPLACE_WITH_TAB_BASE_HOST with the
-- Edge hostname (no scheme) so CORS + ALLOWED_ORIGINS match TAB_BASE_HOST.

-- CREATE SERVICE IF NOT EXISTS AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS
--   IN COMPUTE POOL AGENTS_TEAMS_APP_POOL
--   EXTERNAL_ACCESS_INTEGRATIONS = (AGENTS_TEAMS_EAI)
--   MIN_INSTANCES = 1 MAX_INSTANCES = 1
--   FROM SPECIFICATION $$
-- spec:
--   containers:
--     - name: agents-teams-app
--       image: /agents_teams_app_db/public/image_repo/agents-teams-app:latest
--       env:
--         TEAMS_AUTH_MODE: production
--         ARTIFACTS_INTEGRATION_ENABLED: "true"
--         FF_FILE_UPLOAD: "true"
--         FF_SKILLS: "true"
--         FF_DEEP_RESEARCH: "true"
--         FF_WEB_SEARCH: "true"
--         FF_NATIVE_STREAM_FLAGS: "false"
--       secrets:
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.BOT_APP_ID
--           secretKeyRef: secret_string
--           envVarName: BOT_APP_ID
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.BOT_APP_SECRET
--           secretKeyRef: secret_string
--           envVarName: BOT_APP_SECRET
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.OBO_CLIENT_ID
--           secretKeyRef: secret_string
--           envVarName: OBO_CLIENT_ID
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.OBO_CLIENT_SECRET
--           secretKeyRef: secret_string
--           envVarName: OBO_CLIENT_SECRET
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.DEFAULT_AGENT_FQN
--           secretKeyRef: secret_string
--           envVarName: DEFAULT_AGENT_FQN
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.TEAMS_APP_ID
--           secretKeyRef: secret_string
--           envVarName: TEAMS_APP_ID
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.AGENT_ALLOW_LIST
--           secretKeyRef: secret_string
--           envVarName: AGENT_ALLOW_LIST
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.AZURE_TENANT_ID
--           secretKeyRef: secret_string
--           envVarName: AZURE_TENANT_ID
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.SNOWFLAKE_SCOPE
--           secretKeyRef: secret_string
--           envVarName: SNOWFLAKE_SCOPE
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.APPS_API_HOST
--           secretKeyRef: secret_string
--           envVarName: APPS_API_HOST
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.ALLOWED_ORIGINS
--           secretKeyRef: secret_string
--           envVarName: ALLOWED_ORIGINS
--         - snowflakeSecret:
--             objectName: AGENTS_TEAMS_APP_DB.CONFIG.SNOWFLAKE_ACCOUNT_NAME
--           secretKeyRef: secret_string
--           envVarName: SNOWFLAKE_ACCOUNT
--       resources:
--         requests:
--           cpu: "0.5"
--           memory: 512Mi
--         limits:
--           cpu: "1"
--           memory: 1Gi
--       readinessProbe:
--         port: 3000
--         path: /healthz
--   endpoints:
--     - name: https
--       port: 3000
--       public: true
--       corsSettings:
--         Access-Control-Allow-Origin: ["https://REPLACE_WITH_TAB_BASE_HOST"]
--         Access-Control-Allow-Methods: ["POST", "GET"]
--         Access-Control-Allow-Headers: ["Authorization", "Content-Type", "X-User-Access-Token"]
-- $$;

-- After the service exists:
-- GRANT SERVICE ROLE AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS!ALL_ENDPOINTS_USAGE
--   TO ROLE AGENTS_TEAMS_USER;
-- GRANT SERVICE ROLE AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS!ALL_ENDPOINTS_USAGE
--   TO USER AGENTS_TEAMS_SVC;
