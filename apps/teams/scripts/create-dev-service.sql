-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Path A: create standalone AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS (SYSADMIN).
-- install-teams.md step 5. Run after bootstrap-dev-spcs.sql, secrets, and a
-- linux/amd64 :latest push to IMAGE_REPO. ACCOUNTADMIN must not own this service.
--
-- Replace REPLACE_WITH_TAB_BASE_HOST with TAB_BASE_HOST (no scheme), e.g.
-- teams.example.com (the edge Worker host). Then:
--   snow sql -f apps/teams/scripts/create-dev-service.sql
--
-- NETWORK_MODE=hybrid or privatelink (install-teams.md "Private connectivity") keep
-- SNOWFLAKE_HOST_MODE: account. The internal host only accepts the SPCS service token
-- (forwarded user tokens fail with 395090), so it is service-identity-only and opt-in
-- via SPCS_HOST_MODE=internal in apps/teams/.env, which deploy-spcs.sh applies on rolls.

-- First install only. This fails with "already exists" if the service exists, on purpose:
-- IF NOT EXISTS would silently keep the old image and spec. To roll an existing service,
-- use apps/teams/scripts/deploy-spcs.sh (re-pins the digest and syncs the CORS origin).

USE ROLE SYSADMIN;

CREATE SERVICE AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS
  IN COMPUTE POOL AGENTS_TEAMS_APP_POOL
  EXTERNAL_ACCESS_INTEGRATIONS = (AGENTS_TEAMS_EAI)
  MIN_INSTANCES = 1 MAX_INSTANCES = 1
  FROM SPECIFICATION $$
spec:
  containers:
    - name: agents-teams-app
      image: /agents_teams_app_db/public/image_repo/agents-teams-app:latest
      env:
        TEAMS_AUTH_MODE: production
        # account (default, all network modes) | internal (service identity only)
        SNOWFLAKE_HOST_MODE: account
        ARTIFACTS_INTEGRATION_ENABLED: "true"
        FF_FILE_UPLOAD: "true"
        FF_SKILLS: "true"
        FF_DEEP_RESEARCH: "true"
        FF_WEB_SEARCH: "true"
        FF_NATIVE_STREAM_FLAGS: "false"
      secrets:
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.BOT_APP_ID
          secretKeyRef: secret_string
          envVarName: BOT_APP_ID
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.BOT_APP_SECRET
          secretKeyRef: secret_string
          envVarName: BOT_APP_SECRET
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.OBO_CLIENT_ID
          secretKeyRef: secret_string
          envVarName: OBO_CLIENT_ID
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.OBO_CLIENT_SECRET
          secretKeyRef: secret_string
          envVarName: OBO_CLIENT_SECRET
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.DEFAULT_AGENT_FQN
          secretKeyRef: secret_string
          envVarName: DEFAULT_AGENT_FQN
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.TEAMS_APP_ID
          secretKeyRef: secret_string
          envVarName: TEAMS_APP_ID
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.AGENT_ALLOW_LIST
          secretKeyRef: secret_string
          envVarName: AGENT_ALLOW_LIST
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.AZURE_TENANT_ID
          secretKeyRef: secret_string
          envVarName: AZURE_TENANT_ID
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.SNOWFLAKE_SCOPE
          secretKeyRef: secret_string
          envVarName: SNOWFLAKE_SCOPE
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.APPS_API_HOST
          secretKeyRef: secret_string
          envVarName: APPS_API_HOST
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.ALLOWED_ORIGINS
          secretKeyRef: secret_string
          envVarName: ALLOWED_ORIGINS
        - snowflakeSecret:
            objectName: AGENTS_TEAMS_APP_DB.CONFIG.SNOWFLAKE_ACCOUNT_NAME
          secretKeyRef: secret_string
          envVarName: SNOWFLAKE_ACCOUNT
      resources:
        requests:
          cpu: "0.5"
          memory: 512Mi
        limits:
          cpu: "1"
          memory: 1Gi
      readinessProbe:
        port: 3000
        path: /healthz
  endpoints:
    - name: https
      port: 3000
      public: true
      corsSettings:
        Access-Control-Allow-Origin: ["https://REPLACE_WITH_TAB_BASE_HOST"]
        Access-Control-Allow-Methods: ["POST", "GET"]
        Access-Control-Allow-Headers: ["Authorization", "Content-Type", "X-User-Access-Token"]
# SNOWFLAKE_HOST_MODE: internal only (top-level, a sibling of spec:). Never add executeAsCaller:
# COMPUTE_POOL network rules do not cover caller's-rights tokens.
# capabilities:
#   securityContext:
#     enableCustomCredentials: true
$$;

GRANT SERVICE ROLE AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS!ALL_ENDPOINTS_USAGE
  TO ROLE AGENTS_TEAMS_USER;
GRANT SERVICE ROLE AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS!ALL_ENDPOINTS_USAGE
  TO USER AGENTS_TEAMS_SVC;
SHOW ENDPOINTS IN SERVICE AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS;
