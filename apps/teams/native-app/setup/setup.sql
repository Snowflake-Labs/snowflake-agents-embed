-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Setup script for the Snowflake Agents for Teams (Unofficial) Native App.
--
-- Runs inside the CONSUMER's account at install/upgrade time. Previously this file's
-- content was written by hand and never exercised through a real `snow app run` / CREATE
-- APPLICATION - it referenced a hardcoded `agents_teams_app_db.public.*` namespace (the
-- provider's own ad hoc database) and created an image repository, neither of which makes
-- sense for an app installed in a different consumer's account: a Native App's own schema
-- objects need no database qualifier, and its container images are pulled from the
-- PROVIDER's registry via the application package, never from an image repository the
-- consumer would have to create themselves.

CREATE APPLICATION ROLE IF NOT EXISTS APP_PUBLIC;
CREATE APPLICATION ROLE IF NOT EXISTS APP_ADMIN;
CREATE SCHEMA IF NOT EXISTS CONFIG;
GRANT USAGE ON SCHEMA CONFIG TO APPLICATION ROLE APP_PUBLIC;
GRANT USAGE ON SCHEMA CONFIG TO APPLICATION ROLE APP_ADMIN;

-- Standard reference-registration callback: every `references:` entry in manifest.yml
-- with object_type SECRET points here. Snowsight/the setup wizard call this (via
-- SYSTEM$SET_REFERENCE etc.) when the consumer supplies or updates a reference; it is
-- boilerplate, not app-specific logic.
CREATE OR REPLACE PROCEDURE CONFIG.REGISTER_SINGLE_REFERENCE(
  ref_name STRING, operation STRING, ref_or_alias STRING)
  RETURNS STRING
  LANGUAGE SQL
  AS $$
    BEGIN
      CASE (operation)
        WHEN 'ADD' THEN
          SELECT SYSTEM$SET_REFERENCE(:ref_name, :ref_or_alias);
        WHEN 'REMOVE' THEN
          SELECT SYSTEM$REMOVE_REFERENCE(:ref_name, :ref_or_alias);
        WHEN 'CLEAR' THEN
          SELECT SYSTEM$REMOVE_ALL_REFERENCES(:ref_name);
        ELSE
          RETURN 'unknown operation: ' || operation;
      END CASE;
      RETURN 'Success';
    END;
  $$;

GRANT USAGE ON PROCEDURE CONFIG.REGISTER_SINGLE_REFERENCE(STRING, STRING, STRING)
  TO APPLICATION ROLE APP_PUBLIC;

-- Companion callback the manifest also requires for every SECRET reference. All of ours
-- are GENERIC_STRING values. Snowflake validates payload.type against
-- GENERIC_STRING | OAUTH2 | PASSWORD; an empty payload is rejected as
-- "valid JSON that did not match the expected format for a secret."
CREATE OR REPLACE PROCEDURE CONFIG.GET_CONFIGURATION(ref_name STRING)
  RETURNS STRING
  LANGUAGE SQL
  AS $$
    BEGIN
      RETURN '{"type": "CONFIGURATION", "payload": {"type": "GENERIC_STRING"}}';
    END;
  $$;

GRANT USAGE ON PROCEDURE CONFIG.GET_CONFIGURATION(STRING)
  TO APPLICATION ROLE APP_PUBLIC;

-- Secrets for bot/OBO credentials and app config, populated by the setup wizard
-- (streamlit/setup_wizard.py). Values are never committed here.
CREATE SECRET IF NOT EXISTS CONFIG.BOT_APP_ID
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS CONFIG.BOT_APP_SECRET
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS CONFIG.OBO_CLIENT_ID
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS CONFIG.OBO_CLIENT_SECRET
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS CONFIG.DEFAULT_AGENT_FQN
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS CONFIG.TEAMS_APP_ID
  TYPE = GENERIC_STRING SECRET_STRING = '';
-- Agent allow-list JSON: [{"fqn":"DB.SCH.AGENT","displayName":"My Agent"}, ...]
-- Leave empty to fall back to DEFAULT_AGENT_FQN.
CREATE SECRET IF NOT EXISTS CONFIG.AGENT_ALLOW_LIST
  TYPE = GENERIC_STRING SECRET_STRING = '';

-- Previously plain-text `${{ env.X }}` template literals in services/service_spec.yml -
-- none of which is a mechanism this app's spec (a plain SPECIFICATION_FILE, not a
-- SPECIFICATION_TEMPLATE_FILE) actually supports. Consumer-supplied like the rest.
CREATE SECRET IF NOT EXISTS CONFIG.AZURE_TENANT_ID
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS CONFIG.SNOWFLAKE_SCOPE
  TYPE = GENERIC_STRING SECRET_STRING = '';
CREATE SECRET IF NOT EXISTS CONFIG.APPS_API_HOST
  TYPE = GENERIC_STRING SECRET_STRING = '';
-- Production server boot requires ALLOWED_ORIGINS (packages/server parseConfig).
-- CREATE_SERVER_SERVICE / ROLL_SERVER_SERVICE write this from the CDN origin.
CREATE SECRET IF NOT EXISTS CONFIG.ALLOWED_ORIGINS
  TYPE = GENERIC_STRING SECRET_STRING = '';

-- Not consumer-supplied: computed here, same as the egress network rule below, so
-- services/service_spec.yml never has to hardcode a provider's account name.
CREATE SECRET IF NOT EXISTS CONFIG.SNOWFLAKE_ACCOUNT_NAME
  TYPE = GENERIC_STRING SECRET_STRING = '';

-- ALTER SECRET ... SET SECRET_STRING takes a literal, not an expression, so the value is
-- built as a string and executed as dynamic DDL - same technique as the network rule below.
EXECUTE IMMEDIATE $$
DECLARE
  account_name STRING;
BEGIN
  -- Hyphenated org-account. Locator form resolves in SPCS but routes over 10.x
  -- (390422). EAI must list this host (CREATE OR REPLACE NETWORK RULE below).
  account_name := LOWER(CURRENT_ORGANIZATION_NAME()) || '-' || REPLACE(LOWER(CURRENT_ACCOUNT_NAME()), '_', '-');
  EXECUTE IMMEDIATE 'ALTER SECRET CONFIG.SNOWFLAKE_ACCOUNT_NAME SET SECRET_STRING = ''' || account_name || '''';
  RETURN 'set SNOWFLAKE_ACCOUNT_NAME to ' || account_name;
END;
$$;

GRANT READ ON SECRET CONFIG.BOT_APP_ID TO APPLICATION ROLE APP_ADMIN;
GRANT READ ON SECRET CONFIG.BOT_APP_SECRET TO APPLICATION ROLE APP_ADMIN;
GRANT READ ON SECRET CONFIG.OBO_CLIENT_ID TO APPLICATION ROLE APP_ADMIN;
GRANT READ ON SECRET CONFIG.OBO_CLIENT_SECRET TO APPLICATION ROLE APP_ADMIN;
GRANT READ ON SECRET CONFIG.DEFAULT_AGENT_FQN TO APPLICATION ROLE APP_ADMIN;
GRANT READ ON SECRET CONFIG.TEAMS_APP_ID TO APPLICATION ROLE APP_ADMIN;
GRANT READ ON SECRET CONFIG.AGENT_ALLOW_LIST TO APPLICATION ROLE APP_ADMIN;
GRANT READ ON SECRET CONFIG.AZURE_TENANT_ID TO APPLICATION ROLE APP_ADMIN;
GRANT READ ON SECRET CONFIG.SNOWFLAKE_SCOPE TO APPLICATION ROLE APP_ADMIN;
GRANT READ ON SECRET CONFIG.APPS_API_HOST TO APPLICATION ROLE APP_ADMIN;
GRANT READ ON SECRET CONFIG.ALLOWED_ORIGINS TO APPLICATION ROLE APP_ADMIN;
GRANT READ ON SECRET CONFIG.SNOWFLAKE_ACCOUNT_NAME TO APPLICATION ROLE APP_ADMIN;

-- Security integration: EXTERNAL_OAUTH_ANY_ROLE_MODE = 'ENABLE' is required for session:role-any
-- (the install default). Preferred: pin a role with scope session:role:<ROLE> and call
-- CONFIG.SET_ANY_ROLE_MODE('DISABLE') - see docs/teams/install.md "Security settings".
-- The user mapping claim is 'upn' ONLY. 'email' and 'preferred_username' are user-editable in
-- Entra, so mapping them to login_name lets one account sign in as another (nOAuth class).
-- After creation the consumer should also run (role-any otherwise reaches every granted role):
--   ALTER SECURITY INTEGRATION CORTEX_TEAMS_OAUTH SET
--     EXTERNAL_OAUTH_BLOCKED_ROLES_LIST = ('ACCOUNTADMIN', 'SECURITYADMIN', 'ORGADMIN');
--
-- Unlike CREATE COMPUTE POOL / BIND SERVICE ENDPOINT / CREATE EXTERNAL ACCESS
-- INTEGRATION (all auto-granted to the app non-interactively from the manifest's
-- `privileges` block - confirmed via real `snow app run` calls), a plain security
-- integration needs the broader CREATE INTEGRATION account privilege, and manifest
-- declarations of that (tried both `CREATE INTEGRATION` - rejected outright as an
-- invalid privilege name - and `CREATE SECURITY INTEGRATION` - accepted by validation
-- but never actually auto-granted at run time) don't get it auto-granted. So this
-- can't run unconditionally in setup.sql without breaking every fresh install: it's
-- wrapped so a missing privilege is a no-op, and CONFIG.CREATE_OAUTH_INTEGRATION()
-- (APP_ADMIN only) is the real creation path, callable only after the consumer runs
-- this temporary, install-time grant and should revoke it immediately afterward:
--   GRANT CREATE INTEGRATION ON ACCOUNT TO APPLICATION AGENTS_TEAMS_APP;
--   -- after CONFIG.CREATE_OAUTH_INTEGRATION() succeeds:
--   REVOKE CREATE INTEGRATION ON ACCOUNT FROM APPLICATION AGENTS_TEAMS_APP;
EXECUTE IMMEDIATE $$
BEGIN
  CREATE SECURITY INTEGRATION IF NOT EXISTS CORTEX_TEAMS_OAUTH
    TYPE = EXTERNAL_OAUTH
    ENABLED = TRUE
    EXTERNAL_OAUTH_TYPE = AZURE
    EXTERNAL_OAUTH_ISSUER = 'https://login.microsoftonline.com/PLACEHOLDER/v2.0'
    EXTERNAL_OAUTH_JWS_KEYS_URL = 'https://login.microsoftonline.com/PLACEHOLDER/discovery/v2.0/keys'
    EXTERNAL_OAUTH_AUDIENCE_LIST = ('api://PLACEHOLDER', 'PLACEHOLDER')
    EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM = ('upn')
    EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = 'login_name'
    EXTERNAL_OAUTH_ANY_ROLE_MODE = 'ENABLE'
    EXTERNAL_OAUTH_BLOCKED_ROLES_LIST = ('ACCOUNTADMIN','ORGADMIN','SECURITYADMIN','SYSADMIN');
  RETURN 'security integration created at install time';
EXCEPTION
  WHEN STATEMENT_ERROR THEN
    RETURN 'CREATE INTEGRATION not yet granted - run CONFIG.CREATE_OAUTH_INTEGRATION() after granting it';
END;
$$;

-- After creating each Entra/Teams SSO user (one per Azure AD identity that will use the app),
-- the consumer attaches a network policy so the account-level VPN policy does not block calls
-- made on behalf of that user from the SPCS container. Do NOT use an allow-all policy: the
-- user's Snowflake OAuth token can be replayed from anywhere the policy allows (the tab no
-- longer holds it, but a leaked copy is still only as safe as the network policy), so allow-all
-- is not acceptable. Allow only the egress
-- ranges that actually call Snowflake (SPCS egress, plus Cloudflare if the edge Worker calls it).
-- This is a per-user account object outside the app's own namespace, so it stays a
-- documented consumer step rather than something this script can create:
--   CREATE NETWORK POLICY AGENTS_TEAMS_USER_POLICY ALLOWED_IP_LIST = ('<EGRESS_CIDRS>');
--   ALTER USER "<upn>@<tenant>.onmicrosoft.com" SET NETWORK_POLICY = AGENTS_TEAMS_USER_POLICY;

-- External Access Integration for egress to Entra JWKS, OBO endpoint, Bot Framework, AND
-- the consumer's own Cortex host - the OBO-exchanged Snowflake token is only useful if the
-- container can actually reach Snowflake with it. This account's app has worked without it
-- so far only because it inherited USAGE on the pre-existing ad hoc AGENTS_TEAMS_EAI (whose
-- own network rule already listed a Cortex host, from the original ad hoc setup) - a fresh
-- consumer install with no such ad hoc leftover would have no egress to Snowflake at all.
-- Built dynamically because the account host isn't known until install time.
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
  EXECUTE IMMEDIATE 'CREATE OR REPLACE NETWORK RULE CONFIG.MSFT_EGRESS MODE = EGRESS TYPE = HOST_PORT ' ||
    'VALUE_LIST = (''login.microsoftonline.com'', ''smba.trafficmanager.net'', ''login.botframework.com'', ''' ||
    hyphen_host || ''', ''' || underscore_host || ''', ''' || locator_host || ''')';
  -- Manifest v2: the EAI is not usable until the consumer approves this spec.
  -- HOST_PORTS must match the network-rule VALUE_LIST exactly.
  -- https://docs.snowflake.com/en/developer-guide/native-apps/requesting-app-specs-eai
  EXECUTE IMMEDIATE 'ALTER APPLICATION SET SPECIFICATION cortex_and_entra_egress TYPE = EXTERNAL_ACCESS ' ||
    'LABEL = ''Cortex and Entra egress'' ' ||
    'DESCRIPTION = ''Reach Entra, Bot Framework, and the consumer Snowflake hostname.'' ' ||
    'HOST_PORTS = (''login.microsoftonline.com'', ''smba.trafficmanager.net'', ''login.botframework.com'', ''' ||
    hyphen_host || ''', ''' || underscore_host || ''', ''' || locator_host || ''')';
  RETURN 'created network rule and app spec including ' || hyphen_host;
END;
$$;

CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS AGENTS_TEAMS_EAI
  ALLOWED_NETWORK_RULES = (CONFIG.MSFT_EGRESS)
  ENABLED = TRUE;

-- Rebind needed: CREATE OR REPLACE NETWORK RULE above mints a new
-- object id; IF NOT EXISTS leaves the EAI on the previous id (underscore Cortex host
-- only). Rebind so the hyphenated host the container calls is actually allowlisted.
ALTER EXTERNAL ACCESS INTEGRATION AGENTS_TEAMS_EAI
  SET ALLOWED_NETWORK_RULES = (CONFIG.MSFT_EGRESS)
      ENABLED = TRUE;

-- No GRANT USAGE ON INTEGRATION ... TO APPLICATION ROLE here: the setup script's owning
-- role created AGENTS_TEAMS_EAI via the CREATE EXTERNAL ACCESS INTEGRATION privilege the
-- manifest requested, but that privilege isn't granted WITH GRANT OPTION, so the setup
-- script can't re-grant USAGE on the resulting object - confirmed via a real `snow app
-- run` ("Grant not executed: Insufficient privileges"). Not needed anyway: the service attaches to the integration via
-- `externalAccessIntegrations` in service_spec.yml / CREATE SERVICE, which runs in the
-- same owner's-rights context that already owns the integration.

-- Compute pool the server's SPCS service runs on - moved here from the setup wizard's
-- implicit assumption that a pool named COWORK_COMPUTE_POOL already exists, so a consumer
-- install needs no pre-created infrastructure beyond granting install privileges. Requires
-- CREATE COMPUTE POOL, granted via manifest.yml privileges.
CREATE COMPUTE POOL IF NOT EXISTS AGENTS_TEAMS_APP_POOL
  MIN_NODES = 1
  MAX_NODES = 1
  INSTANCE_FAMILY = CPU_X64_XS
  AUTO_RESUME = TRUE
  AUTO_SUSPEND_SECS = 3600;

-- CLI-driven equivalents of the wizard's buttons (streamlit/setup_wizard.py) - see
-- Each takes its shape for a reason: owner's-rights boundary, dollar-quote collision,
-- FROM SPECIFICATION bind-parameter mangling, consumer role visibility.
CREATE OR REPLACE PROCEDURE CONFIG.SET_SECRET(secret_name STRING, secret_value STRING)
  RETURNS STRING
  LANGUAGE SQL
  EXECUTE AS OWNER
  AS $$
    BEGIN
      CASE (secret_name)
        WHEN 'BOT_APP_ID' THEN
          ALTER SECRET CONFIG.BOT_APP_ID SET SECRET_STRING = :secret_value;
        WHEN 'BOT_APP_SECRET' THEN
          ALTER SECRET CONFIG.BOT_APP_SECRET SET SECRET_STRING = :secret_value;
        WHEN 'OBO_CLIENT_ID' THEN
          ALTER SECRET CONFIG.OBO_CLIENT_ID SET SECRET_STRING = :secret_value;
        WHEN 'OBO_CLIENT_SECRET' THEN
          ALTER SECRET CONFIG.OBO_CLIENT_SECRET SET SECRET_STRING = :secret_value;
        WHEN 'DEFAULT_AGENT_FQN' THEN
          ALTER SECRET CONFIG.DEFAULT_AGENT_FQN SET SECRET_STRING = :secret_value;
        WHEN 'TEAMS_APP_ID' THEN
          ALTER SECRET CONFIG.TEAMS_APP_ID SET SECRET_STRING = :secret_value;
        WHEN 'AGENT_ALLOW_LIST' THEN
          ALTER SECRET CONFIG.AGENT_ALLOW_LIST SET SECRET_STRING = :secret_value;
        WHEN 'AZURE_TENANT_ID' THEN
          ALTER SECRET CONFIG.AZURE_TENANT_ID SET SECRET_STRING = :secret_value;
        WHEN 'SNOWFLAKE_SCOPE' THEN
          ALTER SECRET CONFIG.SNOWFLAKE_SCOPE SET SECRET_STRING = :secret_value;
        WHEN 'APPS_API_HOST' THEN
          ALTER SECRET CONFIG.APPS_API_HOST SET SECRET_STRING = :secret_value;
        WHEN 'ALLOWED_ORIGINS' THEN
          ALTER SECRET CONFIG.ALLOWED_ORIGINS SET SECRET_STRING = :secret_value;
        ELSE
          RETURN 'unknown secret: ' || secret_name;
      END CASE;
      RETURN 'set ' || secret_name;
    END;
  $$;

GRANT USAGE ON PROCEDURE CONFIG.SET_SECRET(STRING, STRING) TO APPLICATION ROLE APP_ADMIN;

-- Real creation path for CORTEX_TEAMS_OAUTH when the install-time attempt above
-- couldn't run (CREATE INTEGRATION wasn't yet granted to the application). APP_ADMIN
-- only. Call after the temporary account grant, then revoke it:
--   GRANT CREATE INTEGRATION ON ACCOUNT TO APPLICATION AGENTS_TEAMS_APP;
--   CALL CONFIG.CREATE_OAUTH_INTEGRATION();
--   REVOKE CREATE INTEGRATION ON ACCOUNT FROM APPLICATION AGENTS_TEAMS_APP;
CREATE OR REPLACE PROCEDURE CONFIG.CREATE_OAUTH_INTEGRATION()
  RETURNS STRING
  LANGUAGE SQL
  EXECUTE AS OWNER
  AS $$
    BEGIN
      CREATE SECURITY INTEGRATION IF NOT EXISTS CORTEX_TEAMS_OAUTH
        TYPE = EXTERNAL_OAUTH
        ENABLED = TRUE
        EXTERNAL_OAUTH_TYPE = AZURE
        EXTERNAL_OAUTH_ISSUER = 'https://login.microsoftonline.com/PLACEHOLDER/v2.0'
        EXTERNAL_OAUTH_JWS_KEYS_URL = 'https://login.microsoftonline.com/PLACEHOLDER/discovery/v2.0/keys'
        EXTERNAL_OAUTH_AUDIENCE_LIST = ('api://PLACEHOLDER', 'PLACEHOLDER')
        EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM = ('upn')
        EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = 'login_name'
        EXTERNAL_OAUTH_ANY_ROLE_MODE = 'ENABLE'
        EXTERNAL_OAUTH_BLOCKED_ROLES_LIST = ('ACCOUNTADMIN','ORGADMIN','SECURITYADMIN','SYSADMIN');
      RETURN 'created';
    END;
  $$;

GRANT USAGE ON PROCEDURE CONFIG.CREATE_OAUTH_INTEGRATION() TO APPLICATION ROLE APP_ADMIN;

-- ALTER ... SET requires literals, not expressions. Arguments are validated against
-- a GUID / api://GUID allow-list so concatenation cannot be extended by the caller.
CREATE OR REPLACE PROCEDURE CONFIG.CONFIGURE_OAUTH(
  tenant_id STRING, audience STRING, audience_uuid STRING)
  RETURNS STRING
  LANGUAGE SQL
  EXECUTE AS OWNER
  AS $$
    DECLARE
      issuer STRING;
      jwks STRING;
      guid_re STRING DEFAULT '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    BEGIN
      IF (NOT REGEXP_LIKE(:tenant_id, guid_re)) THEN
        RETURN 'refuse: tenant_id must be a GUID';
      END IF;
      IF (NOT REGEXP_LIKE(:audience, '^(api://)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) THEN
        RETURN 'refuse: audience must be a GUID or api://<guid>';
      END IF;
      IF (NOT REGEXP_LIKE(:audience_uuid, guid_re)) THEN
        RETURN 'refuse: audience_uuid must be a GUID';
      END IF;
      issuer := 'https://login.microsoftonline.com/' || :tenant_id || '/v2.0';
      jwks := 'https://login.microsoftonline.com/' || :tenant_id || '/discovery/v2.0/keys';
      EXECUTE IMMEDIATE
        'ALTER SECURITY INTEGRATION CORTEX_TEAMS_OAUTH SET ' ||
        'EXTERNAL_OAUTH_ISSUER = ''' || issuer || ''' ' ||
        'EXTERNAL_OAUTH_JWS_KEYS_URL = ''' || jwks || ''' ' ||
        'EXTERNAL_OAUTH_AUDIENCE_LIST = (''' || :audience || ''', ''' || :audience_uuid || ''') ' ||
        'EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM = (''upn'')';
      -- ANY_ROLE_MODE is deliberately left untouched here so re-running this procedure does
      -- not undo a hardened (DISABLE) setting; see CONFIG.SET_ANY_ROLE_MODE.
      RETURN 'configured';
    END;
  $$;

GRANT USAGE ON PROCEDURE CONFIG.CONFIGURE_OAUTH(STRING, STRING, STRING) TO APPLICATION ROLE APP_ADMIN;

-- Preferred hardening (security review F2): pin the OBO scope to one role
-- (SNOWFLAKE_SCOPE = api://<resource-app>/session:role:<ROLE>) and turn any-role mode off, so a
-- leaked user token can only ever act as that role instead of any role the user holds.
-- Fresh installs default to ENABLE because the default scope is session:role-any; switch the
-- scope secret to session:role:<ROLE> and the edge SNOWFLAKE_SCOPE secret first (or at the same time),
-- otherwise role-any tokens are rejected. Only the two literal values are accepted.
CREATE OR REPLACE PROCEDURE CONFIG.SET_ANY_ROLE_MODE(mode STRING)
  RETURNS STRING
  LANGUAGE SQL
  EXECUTE AS OWNER
  AS $$
    BEGIN
      IF (UPPER(:mode) = 'DISABLE') THEN
        ALTER SECURITY INTEGRATION CORTEX_TEAMS_OAUTH SET EXTERNAL_OAUTH_ANY_ROLE_MODE = 'DISABLE';
      ELSEIF (UPPER(:mode) = 'ENABLE') THEN
        ALTER SECURITY INTEGRATION CORTEX_TEAMS_OAUTH SET EXTERNAL_OAUTH_ANY_ROLE_MODE = 'ENABLE';
      ELSE
        RETURN 'refuse: mode must be ENABLE or DISABLE';
      END IF;
      RETURN 'any-role mode ' || UPPER(:mode);
    END;
  $$;

GRANT USAGE ON PROCEDURE CONFIG.SET_ANY_ROLE_MODE(STRING) TO APPLICATION ROLE APP_ADMIN;

-- Non-secret app settings that the service procedures below must read back. This is a
-- table, not a secret, because an owner's-rights procedure cannot read a secret's value.
-- IF NOT EXISTS keeps the consumer's choices across upgrades.
CREATE TABLE IF NOT EXISTS CONFIG.APP_SETTINGS (key STRING NOT NULL, value STRING);

-- Network mode, picked on the wizard's Network tab; applied by the next Create Service or
-- Roll service:
--   public      - services/service_spec.yml. The container reaches the public account
--                 host through the SPCS egress NAT. This is the default.
--   hybrid      - services/service_spec_private.yml. The container uses the SPCS-injected
--                 internal SNOWFLAKE_HOST with enableCustomCredentials. The public ingress
--                 and the Cloudflare edge are unchanged.
--   privatelink - the same spec as hybrid. The edge reaches privatelink_ingress_url
--                 instead of the public ingress.
-- hybrid and privatelink need ACCOUNTADMIN to apply the COMPUTE_POOL network rule the
-- wizard generates first; until then every forwarded user token fails with 390422.
-- Only the three literal values are accepted.
CREATE OR REPLACE PROCEDURE CONFIG.SET_NETWORK_MODE(mode STRING)
  RETURNS STRING
  LANGUAGE SQL
  EXECUTE AS OWNER
  AS $$
    DECLARE
      m STRING;
    BEGIN
      m := LOWER(TRIM(:mode));
      IF (:m NOT IN ('public', 'hybrid', 'privatelink')) THEN
        RETURN 'refuse: mode must be public, hybrid or privatelink';
      END IF;
      MERGE INTO CONFIG.APP_SETTINGS t
        USING (SELECT 'NETWORK_MODE' AS key, :m AS value) s
        ON t.key = s.key
        WHEN MATCHED THEN UPDATE SET t.value = s.value
        WHEN NOT MATCHED THEN INSERT (key, value) VALUES (s.key, s.value);
      RETURN 'network mode ' || :m;
    END;
  $$;

GRANT USAGE ON PROCEDURE CONFIG.SET_NETWORK_MODE(STRING) TO APPLICATION ROLE APP_ADMIN;

CREATE OR REPLACE PROCEDURE CONFIG.GET_NETWORK_MODE()
  RETURNS STRING
  LANGUAGE SQL
  EXECUTE AS OWNER
  AS $$
    DECLARE
      m STRING;
    BEGIN
      SELECT COALESCE(MAX(value), 'public') INTO :m
        FROM CONFIG.APP_SETTINGS WHERE key = 'NETWORK_MODE';
      RETURN :m;
    END;
  $$;

GRANT USAGE ON PROCEDURE CONFIG.GET_NETWORK_MODE() TO APPLICATION ROLE APP_ADMIN;

CREATE OR REPLACE PROCEDURE CONFIG.CREATE_SERVER_SERVICE(cdn_origin STRING)
  RETURNS STRING
  LANGUAGE PYTHON
  RUNTIME_VERSION = '3.11'
  PACKAGES = ('snowflake-snowpark-python')
  HANDLER = 'run'
  EXECUTE AS OWNER
  AS
$$
import json
import re

ORIGIN_RE = re.compile(r"^https://[A-Za-z0-9.-]+(?::\d+)?$")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(?::\d+)?$")

def _cdn_origin(cdn_origin):
    if not cdn_origin or not str(cdn_origin).strip():
        raise ValueError("cdn_origin is required")
    value = str(cdn_origin).strip()
    if HOST_RE.match(value):
        value = "https://" + value
    if not ORIGIN_RE.match(value):
        raise ValueError("invalid cdn_origin: " + value)
    return value

# Kept in sync with ROLL_SERVER_SERVICE; see CONFIG.SET_NETWORK_MODE.
SPEC_FILES = {
    "public": "/services/service_spec.yml",
    "hybrid": "/services/service_spec_private.yml",
    "privatelink": "/services/service_spec_private.yml",
}

def _network_mode(session):
    rows = session.sql(
        "SELECT value FROM CONFIG.APP_SETTINGS WHERE key = 'NETWORK_MODE'"
    ).collect()
    mode = (rows[0][0] if rows else None) or "public"
    if mode not in SPEC_FILES:
        raise ValueError("invalid NETWORK_MODE in CONFIG.APP_SETTINGS: " + mode)
    return mode

def run(session, cdn_origin):
    origin = _cdn_origin(cdn_origin)
    mode = _network_mode(session)
    session.sql(
        "ALTER SECRET CONFIG.ALLOWED_ORIGINS SET SECRET_STRING = '"
        + origin.replace("'", "''") + "'"
    ).collect()
    # USING values must be alphanumeric or valid JSON; a raw https:// URL is neither.
    using = "USING (cdn_origin => '" + json.dumps([origin]) + "')"
    session.sql("DROP SERVICE IF EXISTS CONFIG.AGENTS_TEAMS").collect()
    session.sql(
        "CREATE SERVICE CONFIG.AGENTS_TEAMS "
        "IN COMPUTE POOL AGENTS_TEAMS_APP_POOL "
        "FROM SPECIFICATION_TEMPLATE_FILE = '" + SPEC_FILES[mode] + "' "
        + using + " "
        "EXTERNAL_ACCESS_INTEGRATIONS = (AGENTS_TEAMS_EAI) MIN_INSTANCES = 1"
    ).collect()
    return "service created (network mode " + mode + ")"
$$;

GRANT USAGE ON PROCEDURE CONFIG.CREATE_SERVER_SERVICE(STRING) TO APPLICATION ROLE APP_ADMIN;

CREATE OR REPLACE PROCEDURE CONFIG.GET_SERVER_STATUS()
  RETURNS STRING
  LANGUAGE PYTHON
  RUNTIME_VERSION = '3.11'
  PACKAGES = ('snowflake-snowpark-python')
  HANDLER = 'run'
  EXECUTE AS OWNER
  AS
$$
def run(session):
    status = session.sql("CALL SYSTEM$GET_SERVICE_STATUS('CONFIG.AGENTS_TEAMS')").collect()[0][0]
    endpoints = session.sql("SHOW ENDPOINTS IN SERVICE CONFIG.AGENTS_TEAMS").collect()
    row = next((r.as_dict() for r in endpoints if r["name"] == "https"), {})
    out = f"status={status} endpoint={row.get('ingress_url')}"
    # Only on accounts with PrivateLink; the private edge's SPCS_BASE. Copy it verbatim -
    # it can differ from the app-service-privatelink-url wildcard.
    private = row.get("privatelink_ingress_url")
    if private:
        out += f" privatelink={private}"
    return out
$$;

GRANT USAGE ON PROCEDURE CONFIG.GET_SERVER_STATUS() TO APPLICATION ROLE APP_PUBLIC;

-- Rolls an already-running service in place, preserving its ingress hostname.
-- CREATE_SERVER_SERVICE's `IF NOT EXISTS` cannot be reused for this once the service
-- exists. The service is created only when it does not exist. Any other ALTER failure
-- is re-raised and the service is left untouched: dropping and recreating it changes the
-- ingress hostname, which breaks the edge SPCS_BASE secret and the manifest validDomains.
CREATE OR REPLACE PROCEDURE CONFIG.ROLL_SERVER_SERVICE(cdn_origin STRING)
  RETURNS STRING
  LANGUAGE PYTHON
  RUNTIME_VERSION = '3.11'
  PACKAGES = ('snowflake-snowpark-python')
  HANDLER = 'run'
  EXECUTE AS OWNER
  AS
$$
import json
import re

ORIGIN_RE = re.compile(r"^https://[A-Za-z0-9.-]+(?::\d+)?$")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(?::\d+)?$")

def _cdn_origin(cdn_origin):
    if not cdn_origin or not str(cdn_origin).strip():
        raise ValueError("cdn_origin is required")
    value = str(cdn_origin).strip()
    if HOST_RE.match(value):
        value = "https://" + value
    if not ORIGIN_RE.match(value):
        raise ValueError("invalid cdn_origin: " + value)
    return value

def _service_missing(session):
    rows = session.sql("SHOW SERVICES LIKE 'AGENTS_TEAMS' IN SCHEMA CONFIG").collect()
    return len(rows) == 0

# Kept in sync with CREATE_SERVER_SERVICE. Reading the stored mode on every roll means a
# roll never silently reverts a hybrid/privatelink service to the public spec.
SPEC_FILES = {
    "public": "/services/service_spec.yml",
    "hybrid": "/services/service_spec_private.yml",
    "privatelink": "/services/service_spec_private.yml",
}

def _network_mode(session):
    rows = session.sql(
        "SELECT value FROM CONFIG.APP_SETTINGS WHERE key = 'NETWORK_MODE'"
    ).collect()
    mode = (rows[0][0] if rows else None) or "public"
    if mode not in SPEC_FILES:
        raise ValueError("invalid NETWORK_MODE in CONFIG.APP_SETTINGS: " + mode)
    return mode

def run(session, cdn_origin):
    origin = _cdn_origin(cdn_origin)
    mode = _network_mode(session)
    spec = "FROM SPECIFICATION_TEMPLATE_FILE = '" + SPEC_FILES[mode] + "' "
    session.sql(
        "ALTER SECRET CONFIG.ALLOWED_ORIGINS SET SECRET_STRING = '"
        + origin.replace("'", "''") + "'"
    ).collect()
    using = "USING (cdn_origin => '" + json.dumps([origin]) + "')"
    if _service_missing(session):
        session.sql(
            "CREATE SERVICE CONFIG.AGENTS_TEAMS "
            "IN COMPUTE POOL AGENTS_TEAMS_APP_POOL "
            + spec + using + " "
            "EXTERNAL_ACCESS_INTEGRATIONS = (AGENTS_TEAMS_EAI) MIN_INSTANCES = 1"
        ).collect()
        return ("service created (network mode " + mode + ") - re-run set-edge-secrets.sh "
                "and the manifest step with the new ingress host")
    try:
        session.sql("ALTER SERVICE CONFIG.AGENTS_TEAMS " + spec + using).collect()
    except Exception as e:
        code = getattr(e, "sql_error_code", None)
        raise RuntimeError(
            "ALTER SERVICE failed (sql error code: " + str(code) + "); the service was left "
            "unchanged. Check the spec and image tag, or drop and recreate it manually if an "
            "in-place roll is impossible (this changes the ingress host)."
        )
    return "rolled in place (network mode " + mode + ")"
$$;

GRANT USAGE ON PROCEDURE CONFIG.ROLL_SERVER_SERVICE(STRING) TO APPLICATION ROLE APP_ADMIN;

-- Re-grants the service's freshly-minted ALL_ENDPOINTS_USAGE service role after every
-- create/recreate; it can't be a one-time install-time grant.
CREATE OR REPLACE PROCEDURE CONFIG.GRANT_ENDPOINT_ACCESS()
  RETURNS STRING
  LANGUAGE SQL
  EXECUTE AS OWNER
  AS $$
    BEGIN
      GRANT SERVICE ROLE CONFIG.AGENTS_TEAMS!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE APP_PUBLIC;
      GRANT MONITOR ON SERVICE CONFIG.AGENTS_TEAMS TO APPLICATION ROLE APP_ADMIN;
      RETURN 'granted';
    END;
  $$;

GRANT USAGE ON PROCEDURE CONFIG.GRANT_ENDPOINT_ACCESS() TO APPLICATION ROLE APP_ADMIN;

-- Deliberately NOT done here: CREATE SERVICE itself, run instead via
-- CONFIG.CREATE_SERVER_SERVICE above or the wizard's "Create Service" button
-- (Tab 9b in streamlit/setup_wizard.py) - both need the CDN origin substituted first.

-- Setup wizard UI. Files are staged at /streamlit by snowflake.yml artifacts.
-- APP_ADMIN only: the wizard writes secrets. Snowsight: Catalog → Apps →
-- AGENTS_TEAMS_APP → SETUP_WIZARD.
CREATE OR REPLACE STREAMLIT CONFIG.SETUP_WIZARD
  FROM '/streamlit'
  MAIN_FILE = '/setup_wizard.py';

GRANT USAGE ON STREAMLIT CONFIG.SETUP_WIZARD TO APPLICATION ROLE APP_ADMIN;
