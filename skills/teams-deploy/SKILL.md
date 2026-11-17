---
name: teams-deploy
version: "1.0"
description: >
  Deploys and troubleshoots Snowflake Agents for Teams (Unofficial) (Native App SPCS
  or standalone SPCS, Cloudflare Worker or self-hosted Node edge, Teams tab + bot, production Entra OBO). Use when the
  user asks to install, deploy, sideload, or debug the Teams integration,
  /token/exchange, SPCS ingress, or AADSTS/390xxx chat failures.
user-invocable: true
allowed-tools:
  - read
  - bash
  - grep
  - glob
---

# Teams deploy and troubleshoot

Hands-on operator for production Entra/OBO Teams installs, on either SPCS path:

- **Path A: standalone SPCS**, no Native App (section 3b). This is the main body of `docs/install-teams.md`.
- **Path B: Native App** (sections 3 and 4 below).

Canonical docs (do not invent a second runbook):

- [docs/install-guide.md](../../docs/install-guide.md)
- [docs/install-teams.md](../../docs/install-teams.md)
- [docs/authentication-patterns.md](../../docs/authentication-patterns.md)

If a step fails, open [references/failures.md](references/failures.md) and run the matching probe. Script-time errors (I1-I4, I14-I17: bad `.env` values, Docker down, workers.dev subdomain or Worker name, missing PAT, placeholder ingress host) are in its **Setup script errors** section.

## Hard rules

- Confirm with the user before: image push, `./scripts/native-app-release.sh`, `CREATE_SERVER_SERVICE`, `set-edge-secrets.sh` (`wrangler secret bulk`), `deploy-tab.sh` (`wrangler deploy`), `snow app teardown`.
- Read `apps/teams/.env` to check which keys exist. **Never print** PATs, client secrets, or wrangler secret values.
- Do **not** run local e2e, token-refresh or tenant-setup helpers; they are not part of the repo.
- Do **not** tell the user to edit `packages/server` (egress host and `:run` body are already in the image).
- Do **not** edit `ACCOUNT_VPN_POLICY_SE` or allowlist private `10.x` IPs.
- Before any state-changing Snowflake SQL (or `CONFIG.*` call), run `SELECT CURRENT_ACCOUNT_NAME()` and confirm with the user that it is the account hosting the SPCS ingress. The PAT in `SPCS_PAT` must come from that same account. Several accounts may be configured in `snow`; running fixes against the wrong one wastes a service roll.
- Never copy bearer tokens from HARs, request headers, or `wrangler tail` output into chat, docs, or screenshots.
- Verify by response body, not HTTP status alone. The chat UI can load (`200`) while the banner or the agent's reply shows the real failure.
- These three values are not interchangeable:
  - `VITE_SPCS_BASE` — **empty** in production ([packages/tab/.env.production](../../packages/tab/.env.production))
  - Edge Worker `SPCS_BASE` — SPCS ingress from wizard tab 9 (9c) / `GET_SERVER_STATUS`; in `NETWORK_MODE=privatelink` the `privatelink_ingress_url` instead
  - Azure Bot messaging endpoint — `https://<TAB_BASE_HOST>/api/bot/messages`

`snow -c <conn>` goes **after** the subcommand (`snow sql -c demo`, never `snow -c demo sql`). Scripts under `apps/teams/scripts/` are not executable; invoke with `bash`.

## 1. Detect intent

- **Fresh install** — no `AGENTS_TEAMS_APP`, or the user said install/deploy from scratch.
- **Already failing** — skip to [references/failures.md](references/failures.md) unless they also want a full redeploy.

Ask which path: **Path B** (Native App: *provider* builds it from this repo, *consumer* installs a published listing) or **Path A** (standalone SPCS service `AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS`, no Native App). If the account already has `AGENTS_TEAMS_APP`, Path A is blocked until it is removed (its app-owned `AGENTS_TEAMS_EAI` collides with the bootstrap). Path A skips sections 3 and 4 and uses 3b instead.

## 2. Preflight

From the repo root:

```bash
test -f apps/teams/.env || cp apps/teams/.env.example apps/teams/.env
npm install
command -v snow && command -v docker
docker info >/dev/null 2>&1 || echo "Docker daemon is down: open -a Docker"
snow sql -q "SELECT CURRENT_USER(), CURRENT_ACCOUNT()"
cd packages/teams-edge && npx wrangler whoami
```

Required `apps/teams/.env` keys (presence only; do not echo values):

`SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PAT`, `AZURE_TENANT_ID`, `BOT_APP_ID`, `BOT_APP_SECRET`, `OBO_CLIENT_ID`, `OBO_CLIENT_SECRET`, `SNOWFLAKE_SCOPE`, `SNOWFLAKE_ENTRA_APP_ID`, `TEAMS_APP_ID`, `DEFAULT_AGENT_FQN`, `APPS_API_HOST`, `SPCS_INGRESS_HOST`, `CLOUDFLARE_API_TOKEN`, and `TAB_BASE_HOST` or `TAB_BASE_URL`. `.env.example` groups these as Required, Optional and Auto; the dev, e2e and Node-edge keys are in `.env.dev.example`, `.env.test.example` and `.env.node-edge.example`.

Also required for Path A: `SNOWFLAKE_ENTRA_APP_ID` (the Snowflake OAuth resource app) and `DEFAULT_AGENT_FQN`. `set-bot-endpoint.sh` needs an Azure Bot Service in `AZURE_TENANT_ID`; without one it reports no botServices. `bash apps/teams/scripts/create-bot.sh` (dry run first; `--apply` after the user confirms, it creates Azure resources) creates the resource group, bot and Teams channel idempotently. The personal tab works without it, but adding the app to a channel fails with `BulkMembershipRequest`.

Also check (presence/shape only, never echo values): `TEAMS_USERNAME` is a single `user@domain` (no repeated `TEAMS_USERNAME=`), `APPS_API_HOST` is set (needed by `fill-dev-secrets.sh`), and `SPCS_INGRESS_HOST` contains no `<placeholder>` and matches `SHOW ENDPOINTS IN SERVICE AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS`. `NETWORK_MODE` is `public` (default), `hybrid` or `privatelink`; in privatelink `SPCS_INGRESS_HOST` is not used and `SPCS_BASE` must be `https://<privatelink_ingress_url>`.

Check `SNOWFLAKE_SCOPE` shape without printing the id: it must be `api://<snowflake-resource-app-id>/session:role-any` (lowercase `session`). It must **not** use `OBO_CLIENT_ID` or `BOT_APP_ID`, and must **not** be `SESSION:ROLE-ANY`.

Also need a persisted Cortex agent (`DATABASE.SCHEMA.AGENT_NAME`) and a PAT user whose **user-level** network policy allows SPCS egress and Cloudflare egress ranges (<https://www.cloudflare.com/ips-v4>). The PAT must be minted in the same Snowflake account that hosts the SPCS ingress, with `ROLE_RESTRICTION`. In `hybrid`/`privatelink` (wizard tab 8) the design moves the SPCS → Cortex hop to a `COMPUTE_POOL` rule policy `AGENTS_TEAMS_POOL_POLICY` and, in `privatelink`, adds a private-endpoint policy `AGENTS_TEAMS_PL_INGRESS_POLICY` on the PAT user. Tested 2026-10-09 on AWS: the `internal` host mode failed with `395090` (use `account`, keep the T8 policy) and the endpoint policy did not stop the PAT working from the internet, so keep the Cloudflare-range policy too. See [docs/install-teams.md § 7](../../docs/install-teams.md#7-private-connectivity-optional).

If Entra IDs are missing, pause: the user completes wizard tabs 1–6 in Snowsight (or Azure by hand). Do not provision a tenant from this skill.

## 3. Native App

### Provider

```sql
CREATE DATABASE IF NOT EXISTS AGENTS_TEAMS_APP_DB;
CREATE SCHEMA IF NOT EXISTS AGENTS_TEAMS_APP_DB.PUBLIC;
CREATE IMAGE REPOSITORY IF NOT EXISTS AGENTS_TEAMS_APP_DB.PUBLIC.NA_IMAGE_REPO;
SHOW IMAGE REPOSITORIES IN SCHEMA AGENTS_TEAMS_APP_DB.PUBLIC;
```

Use `repository_url` for `NA_IMAGE_REPO` (not `IMAGE_REPO`). After the user confirms:

```bash
snow spcs image-registry login
docker build --platform linux/amd64 -f apps/teams/Dockerfile -t agents-teams-app:latest .
docker tag agents-teams-app:latest <na_image_repo_url>/agents-teams-app:latest
docker push <na_image_repo_url>/agents-teams-app:latest
./scripts/native-app-release.sh teams v1
```

Manifest image path: `/agents_teams_app_db/public/na_image_repo/agents-teams-app:latest`. Always `--platform linux/amd64`.

### Consumer

Skip the image push and `native-app-release.sh`. User installs the listing in Snowsight (Data Products → Apps), then you run the same grants.

### Grants (both paths)

Object name in SQL is `AGENTS_TEAMS_APP` (uppercase). Do **not** `GRANT CREATE INTEGRATION ON ACCOUNT`.

```sql
GRANT CREATE COMPUTE POOL ON ACCOUNT TO APPLICATION AGENTS_TEAMS_APP;
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO APPLICATION AGENTS_TEAMS_APP;
GRANT CREATE EXTERNAL ACCESS INTEGRATION ON ACCOUNT TO APPLICATION AGENTS_TEAMS_APP;
GRANT CREATE SECURITY INTEGRATION ON ACCOUNT TO APPLICATION AGENTS_TEAMS_APP;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION AGENTS_TEAMS_APP;

CREATE ROLE IF NOT EXISTS AGENTS_TEAMS_USER;
GRANT APPLICATION ROLE AGENTS_TEAMS_APP.APP_ADMIN TO ROLE ACCOUNTADMIN;
GRANT APPLICATION ROLE AGENTS_TEAMS_APP.APP_PUBLIC TO ROLE AGENTS_TEAMS_USER;
GRANT APPLICATION ROLE AGENTS_TEAMS_APP.APP_PUBLIC TO USER "<pat-user>";
```

The edge Worker's `SPCS_PAT` user must hold `APP_PUBLIC`, or every `/api/*` call is `403 Insufficient privileges` at the ingress. The tab's requests show it (and a PAT call against the ingress); the edge probe cannot.

## 3b. Path A: standalone SPCS

Full detail: [docs/install-teams.md § 2](../../docs/install-teams.md#2-install-standalone-spcs). Run in order; confirm before each state-changing step and run `SELECT CURRENT_ACCOUNT_NAME()` first.

1. `snow sql -f apps/teams/scripts/bootstrap-dev-spcs.sql` (ACCOUNTADMIN): database, `IMAGE_REPO`, compute pool, EAI, empty secrets, placeholder `CORTEX_TEAMS_OAUTH`, roles, `AGENTS_TEAMS_SVC`, and `READ` on all 12 CONFIG secrets for SYSADMIN (step 4 needs it; see failures.md I21).
2. `bash apps/teams/scripts/fill-dev-secrets.sh` (needs `DEFAULT_AGENT_FQN`, `SNOWFLAKE_ENTRA_APP_ID`, `APPS_API_HOST`). It only writes `temp/alter-teams-secrets.sql`, which holds secrets. After the user applies it (`snow sql --silent --enable-templating none -f …`), delete the file.
3. `bash apps/teams/scripts/push-dev-image.sh` (pushes to `IMAGE_REPO`, not `NA_IMAGE_REPO`; Docker must be up).
4. Render `apps/teams/scripts/create-dev-service.sql` with `REPLACE_WITH_TAB_BASE_HOST` replaced by `TAB_BASE_HOST` (no scheme) and run it as **SYSADMIN**. The service must be owned by SYSADMIN. For `hybrid`/`privatelink` keep `SNOWFLAKE_HOST_MODE: account`: `internal` (the file's header, the `capabilities` block and the `COMPUTE_POOL` rule SQL) is experimental and returned `395090` in testing (PL8). If you do try `internal`, apply the `COMPUTE_POOL` rule first or every user call fails with `390422`.
5. Copy `ingress_url` from `SHOW ENDPOINTS IN SERVICE AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS` into `SPCS_INGRESS_HOST` (no scheme) and `SPCS_BASE` (`https://…`). In privatelink, `SPCS_BASE` is `https://<privatelink_ingress_url>` and `SPCS_INGRESS_HOST` is not used.
6. `bash apps/teams/scripts/set-svc-network-policy.sh --apply` (`public`/`hybrid`; confirm first, it attaches `AGENTS_TEAMS_INGRESS_POLICY` with the Cloudflare ranges to the PAT user). Skipping it gives `390422` on every Worker call, and `smoke-test.sh` now fails without it.
7. `bash apps/teams/scripts/set-edge-secrets.sh`, then `bash apps/teams/scripts/deploy-tab.sh` (section 5).
8. Entra token version and `upn` claim (4a), per-user grants (4b), then section 6 (Teams app) and the bot test in section 7.

`deploy-tab.sh` runs `wrangler deploy`, which updates the production Worker in place even from a feature branch. There is no alias lag; re-probe right away.

## 4. Wizard / CONFIG (Path B)

If `apps/teams/.env` already has Entra + bot + OBO + Snowflake resource app ids, skip Azure tabs 1–6 and run tab 7 as `ACCOUNTADMIN` (same SQL as [docs/install-teams.md § 2](../../docs/install-teams.md)):

```sql
CREATE SECURITY INTEGRATION IF NOT EXISTS CORTEX_TEAMS_OAUTH
  TYPE = EXTERNAL_OAUTH ENABLED = TRUE EXTERNAL_OAUTH_TYPE = AZURE
  EXTERNAL_OAUTH_ISSUER = 'https://login.microsoftonline.com/<AZURE_TENANT_ID>/v2.0'
  EXTERNAL_OAUTH_JWS_KEYS_URL = 'https://login.microsoftonline.com/<AZURE_TENANT_ID>/discovery/v2.0/keys'
  EXTERNAL_OAUTH_AUDIENCE_LIST = ('api://<snowflake-resource-app-id>', '<snowflake-resource-app-id>')
  EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM = ('upn')
  EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = 'login_name'
  EXTERNAL_OAUTH_ANY_ROLE_MODE = 'ENABLE';

GRANT MODIFY ON INTEGRATION CORTEX_TEAMS_OAUTH TO APPLICATION AGENTS_TEAMS_APP;

CALL AGENTS_TEAMS_APP.CONFIG.CONFIGURE_OAUTH(
  '<AZURE_TENANT_ID>',
  'api://<snowflake-resource-app-id>',
  '<snowflake-resource-app-id>'
);
```

Then `CONFIG.SET_SECRET` for `BOT_APP_ID`, `BOT_APP_SECRET`, `OBO_CLIENT_ID`, `OBO_CLIENT_SECRET`, `DEFAULT_AGENT_FQN`, `TEAMS_APP_ID`, `AGENT_ALLOW_LIST` (`[]` if unused), `AZURE_TENANT_ID`, `SNOWFLAKE_SCOPE`, `APPS_API_HOST` (`apps-api.c1.<region>.<cloud>.app.snowflake.com`). Audience on `CORTEX_TEAMS_OAUTH` is the **Snowflake OAuth resource** app, not the Teams bot. The mapping claim is `upn` only: `email` and `preferred_username` are user-editable, so accepting them would let a user impersonate another login.

Tab 8 (Network) sets `NETWORK_MODE` via `CONFIG.SET_NETWORK_MODE` (`CONFIG.GET_NETWORK_MODE` reads it). `public` needs no SQL and is the default. `hybrid` and `privatelink` are partly validated (the Worker + cloudflared path works on AWS; the `COMPUTE_POOL`/`internal` part does not, see Private connectivity below): 8a Detect reads `CURRENT_REGION()` and `SYSTEM$GET_PRIVATELINK_CONFIG()`, and the tab generates ACCOUNTADMIN SQL (database `AGENTS_TEAMS_NETWORK`: pool rule/policy on `CORTEX_TEAMS_OAUTH`, plus in privatelink the endpoint-ID policy on the PAT user). The pool rule only matters in `internal` host mode, which is experimental; in `account` mode keep the T8 policy. Switching back to `public` means re-attaching the T8 policy.

Approve egress (after every install or host-list change), then create the service in tab 9 (9b Start SPCS Service, Create or Roll; 9a is the CDN domain). `CREATE_SERVER_SERVICE` **drops and recreates** the service — ingress hostname changes every time. Confirm first.

```sql
SHOW PENDING SPECIFICATIONS IN APPLICATION AGENTS_TEAMS_APP;
ALTER APPLICATION AGENTS_TEAMS_APP APPROVE SPECIFICATION cortex_and_entra_egress SEQUENCE_NUMBER = <n>;

CALL AGENTS_TEAMS_APP.CONFIG.CREATE_SERVER_SERVICE('https://<TAB_BASE_HOST>');
CALL AGENTS_TEAMS_APP.CONFIG.GRANT_ENDPOINT_ACCESS();
CALL AGENTS_TEAMS_APP.CONFIG.GET_SERVER_STATUS();
```

Wait until status is `READY` (~60s). Copy the endpoint host from tab 9c (no scheme) into `apps/teams/.env` `SPCS_INGRESS_HOST`. That URL is the edge Worker's `SPCS_BASE`, not `VITE_SPCS_BASE` and not the bot messaging endpoint. In privatelink, 9c also shows the private ingress (`privatelink_ingress_url`), and the edge's `SPCS_BASE` is `https://<private>`.

If Create Service says the app needs `USAGE` on `AGENTS_TEAMS_EAI`:

```sql
GRANT USAGE ON INTEGRATION AGENTS_TEAMS_EAI TO APPLICATION AGENTS_TEAMS_APP;
```

## 4a. Entra: token version 2 and `upn` optional claim (both paths)

The Snowflake resource app must issue v2 tokens, and v2 tokens carry no `upn` unless the app requests it. Without it Snowflake rejects the token (`Invalid OAuth access token`) and the tab shows `agent_forbidden`. Check:

```bash
az ad app show --id "$SNOWFLAKE_ENTRA_APP_ID" \
  --query "{v:api.requestedAccessTokenVersion, c:optionalClaims.accessToken[].name}"
```

Expect `v` = `2` and `c` containing `upn`. If not, get user approval (it edits tenant config), then:

```bash
az ad app update --id "$SNOWFLAKE_ENTRA_APP_ID" \
  --requested-access-token-version 2 \
  --optional-claims '{"accessToken":[{"name":"upn","essential":false}]}'
```

Set the version with `--requested-access-token-version 2`; `--set api.requestedAccessTokenVersion=2` fails with `Couldn't find 'api'`. Only new tokens carry the claim, and the edge session caches the old one: tell the user to reload the tab.

## 4b. Per-user identity and grants

One Snowflake user per Entra user. `CORTEX_TEAMS_OAUTH` maps the token's `upn` claim (only) to Snowflake `login_name`; no match is `agent_forbidden` ("You do not have access to that resource"). Cortex resolves permissions from the user's **default** role, so the default role and warehouse must be set. Confirm the account first (`SELECT CURRENT_ACCOUNT_NAME()`), then as `ACCOUNTADMIN`. Check by **`login_name`**, not only the user name: `CREATE USER IF NOT EXISTS` matches the name, so a user that already has that login under another name makes it fail.

```sql
SHOW USERS;
SELECT "name", "login_name", "default_role" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE LOWER("login_name") = LOWER('<entra-upn>');
```

If a row returns, do not create a user. Grant `AGENTS_TEAMS_USER` to that user's `default_role` (`GRANT ROLE AGENTS_TEAMS_USER TO ROLE <default_role>`, or the object grants below straight to it) and leave their default role alone. Otherwise:

```sql
CREATE USER IF NOT EXISTS <snowflake_user> LOGIN_NAME = '<entra-upn>'
  DEFAULT_ROLE = AGENTS_TEAMS_USER DEFAULT_WAREHOUSE = <warehouse>;
GRANT ROLE AGENTS_TEAMS_USER TO USER <snowflake_user>;
GRANT USAGE ON DATABASE <db> TO ROLE AGENTS_TEAMS_USER;
GRANT USAGE ON SCHEMA <db>.<schema> TO ROLE AGENTS_TEAMS_USER;
GRANT USAGE ON AGENT <db>.<schema>.<agent> TO ROLE AGENTS_TEAMS_USER;
```

The role also needs grants on every tool the agent uses (semantic view and its tables, search service, functions, warehouse) and `SNOWFLAKE.CORTEX_USER`. Missing grants do not error: the agent drops the tool and says it is unavailable. Grant them to `AGENTS_TEAMS_USER` for whichever agent you use. Ask the user for the UPN; do not guess it.

## 5. Cloudflare Worker

The edge is one Cloudflare Worker (`packages/teams-edge`): it serves the tab's `dist/` and owns `/api/*`, `/token/exchange` and `/token/link`. Run Wrangler from `packages/teams-edge`. Keep the host that already owns `TAB_BASE_HOST`. Do **not** stand up a second host — Entra SSO fails with "Couldn't sign you in" until that host is on the Entra app. Moving an existing `*.pages.dev` install: [docs/install-teams.md § 6](../../docs/install-teams.md#6-pages-to-worker-cutover).

Both scripts refuse to run when the Worker does not already exist on the logged-in Cloudflare account (a typo would otherwise silently create a new Worker); pass `--create` to `set-edge-secrets.sh` (and `deploy-tab.sh`) on a first install. `deploy-tab.sh` also fails early if `npm install` has not been run. Worker name (both scripts, from `apps/teams/.env` only): `EDGE_WORKER_NAME`, else legacy `PAGES_PROJECT`, else the first label of a `*.workers.dev` `TAB_BASE_HOST` (a `*.pages.dev` host is rejected: this edge deploys as a Worker on `workers.dev` or a custom domain), else `agents-embed-teams`. The workers.dev host is `<worker>.<account-subdomain>.workers.dev`; a custom domain goes in `.env` as `EDGE_CUSTOM_DOMAIN` (rendered into the deploy config) or the dashboard (Workers & Pages → worker → Settings → Domains & Routes). See [B.4](../../docs/install-teams.md#b4-cloudflare-worker).

Account-specific ids live in `apps/teams/.env`, never in `packages/teams-edge/wrangler.jsonc` (a template): `BOT_LINKS_KV_ID`, and `SPCS_VPC_SERVICE_ID` for privatelink. `deploy-tab.sh` refuses to deploy without `BOT_LINKS_KV_ID`; `--create` finds or creates the namespace and writes the id to `.env`. It renders the gitignored `wrangler.local.jsonc` and deploys that.

After the user confirms, push secrets, then deploy. `set-edge-secrets.sh` sends all ten secrets (`AZURE_TENANT_ID OBO_CLIENT_ID OBO_CLIENT_SECRET SNOWFLAKE_SCOPE ENTRA_AUDIENCE_URI SPCS_BASE SPCS_PAT EDGE_SESSION_SECRET BOT_LINK_SECRET BOT_APP_ID`) in one `npx wrangler secret bulk --name <worker> --env ""` call, as JSON on stdin (never argv), and generates `EDGE_SESSION_SECRET`/`BOT_LINK_SECRET` if absent. It does not deploy: `secret bulk` alone leaves warm isolates. If the Worker does not exist yet, wrangler offers to create it as a draft (default yes). `set-pages-secrets.sh` is a deprecated shim that execs it.

```bash
bash apps/teams/scripts/set-edge-secrets.sh
bash apps/teams/scripts/deploy-tab.sh            # --public | --privatelink; default from NETWORK_MODE
```

`deploy-tab.sh` builds the tab and runs `npx wrangler deploy --env <""|privatelink> --name <worker>`. `public` and `hybrid` use the top-level env; `privatelink` uses `env.privatelink`.

`SPCS_BASE` is `.env` `SPCS_BASE`, else `https://` + `SPCS_INGRESS_HOST` (the ingress from tab 9c / `GET_SERVER_STATUS`). `SPCS_PAT` is the `SNOWFLAKE_PAT` of the user that holds `APP_PUBLIC`. `SNOWFLAKE_SCOPE` is derived from `SNOWFLAKE_ENTRA_APP_ID` (or `SNOWFLAKE_OAUTH_ROLE`), not copied from `.env`. Missing secrets → `/api/*` 500.

After **any** change to `SPCS_INGRESS_HOST`, `SPCS_BASE`, or `SNOWFLAKE_PAT`, re-run `bash apps/teams/scripts/set-edge-secrets.sh` then `bash apps/teams/scripts/deploy-tab.sh`. A placeholder `SPCS_BASE` makes every `/api/*` return 500 (Cloudflare 1101 `Invalid URL`). First deploy failing with "You need to register a workers.dev subdomain before publishing to workers.dev": [I14](../../docs/install-teams.md#i14-wrangler-deploy-workersdev-subdomain-or-worker-name).

Check: `cd packages/teams-edge && npx wrangler secret list --name <worker>` lists ten names (never values). Logs: `npx wrangler tail <worker>`.

Order: pick the edge host (tab 9a) → put it in `CREATE_SERVER_SERVICE` / tab 9b → `set-edge-secrets.sh` → `deploy-tab.sh`.

### Private connectivity (optional)

- `SNOWFLAKE_HOST_MODE=internal` returns `395090` for forwarded user tokens; use `account` ([PL8](../../docs/install-teams.md#pl8-395090-with-snowflake_host_modeinternal)). `deploy-spcs.sh` now writes `account` for every `NETWORK_MODE`; `internal` needs `SPCS_HOST_MODE=internal` in `apps/teams/.env` and is service-identity-only (Snowflake accepts only the SPCS token on that host).
- The PAT user's `AWSVPCEID` policy and `SYSTEM$ENFORCE_PRIVATELINK_ACCESS_ONLY` did not block internet use of the PAT ([PL9](../../docs/install-teams.md#pl9-the-pat-still-works-from-the-internet)).
- SPCS ingress auth is `Authorization: Snowflake Token="<PAT>"`; `Bearer` gets a 302.
- **Azure rules** ([§ 7.2](../../docs/install-teams.md#72-prerequisites), [§ 7.5](../../docs/install-teams.md#75-private-dns), [§ 7.6](../../docs/install-teams.md#76-edge-in-privatelink-workers-vpc)): register `Microsoft.Network` and `Microsoft.Compute` on a new subscription; set the PE subnet policy with `az network vnet subnet update`; authorize with `SYSTEM$AUTHORIZE_PRIVATELINK('<private endpoint resource id>', '<az token>')`, not the subscription ID; network rule type `AZURELINKID` with the `linkIdentifier` value; DNS is A records, not CNAMEs; pass secrets to the VM only with `az vm run-command create --protected-parameters`. Revoke the authorization **before** deleting the private endpoint (see `teams-teardown`). If Azure Policy denies network actions or the resource group quota is exceeded, stop and report; do not work around it.
- **GCP rules** ([§ 7.2](../../docs/install-teams.md#72-prerequisites), [§ 7.5](../../docs/install-teams.md#75-private-dns), [§ 7.6](../../docs/install-teams.md#76-edge-in-privatelink-workers-vpc)): authorize the **project** with `SYSTEM$AUTHORIZE_PRIVATELINK('<gcp project id>', '<gcloud token>')` (token via a mode-600 temp file, never printed); the forwarding rule is `PENDING` until then; network rule type `GCPPSCID` with the numeric `pscConnectionId`; three Cloud DNS private zones with A records to the PSC address, named for their domain (zone names are immutable); the VM has no external IP so it needs Cloud NAT; `wrangler tunnel create` prints no token, fetch it from the Cloudflare API; `privatelink_ingress_url` reads "Endpoints provisioning in progress..." for about a minute after `READY`. If IAP SSH (`4033`) or Secret Manager `setIamPolicy` is denied ([PL14](../../docs/install-teams.md#pl14-gcp-secret-manager-iam-denied-for-the-tunnel-vm)), stop and ask; the metadata-token fallback needs the user's explicit OK and the key removed straight after. Revoke the project authorization **before** deleting the forwarding rule (see `teams-teardown`; untested).
- **Azure preflight:** `az account show` tenant/subscription, providers registered, role rights, `az policy assignment list`. On an account with an account-wide IP policy, `account` host mode egress from SPCS is blocked until a narrow allow-list exists ([PL11](../../docs/install-teams.md#pl11-account-network-policy-blocks-the-containers-egress-account-host-mode)); an empty agent selector can be that, not a missing agent ([PL12](../../docs/install-teams.md#pl12-the-agent-selector-is-empty-although-agents-exist)).
- **Fresh-account agent prerequisites:** the sample agent needs a `CORTEX_WH`-style warehouse and a default warehouse on the user ([PL13](../../docs/install-teams.md#pl13-the-default-agent-needs-a-warehouse-the-account-does-not-have)); `COWORK_BOT_STATE` is never created (bot state is lost on restart, non-fatal); add `GRANT USAGE ON AGENT ... TO ROLE AGENTS_TEAMS_USER` yourself or `SHOW AGENTS` returns no rows ([PL12](../../docs/install-teams.md#pl12-the-agent-selector-is-empty-although-agents-exist)). Account-level login history is `SNOWFLAKE.INFORMATION_SCHEMA.LOGIN_HISTORY`.
- **Safety:** never run `ENFORCE_PRIVATELINK_ACCESS_ONLY` without an explicit go-ahead from the user and a confirmed admin recovery path (SSM port-forward, [§ 7.2](../../docs/install-teams.md#72-prerequisites)). Never print the PAT, the tunnel token or the Wrangler OAuth token. Confirm before repointing a live bot endpoint. Warn the user not to share pasted `x-edge-session` values.

It needs `SPCS_BASE=https://<privatelink_ingress_url>` in `.env` (`set-edge-secrets.sh` refuses to fall back to the public host), cloudflared in the customer VPC, and a Workers VPC service id in `env.privatelink.vpc_services[0].service_id`. `deploy-tab.sh --privatelink` refuses while `REPLACE_WITH_VPC_SERVICE_ID` is present. A missing binding returns 500 `{"error":"Edge misconfigured"}`. `hybrid` keeps the public ingress and only moves the SPCS → Cortex hop to the `COMPUTE_POOL` rule. The self-hosted Node edge (`apps/teams/edge.Dockerfile`, one replica per `/data` volume, never root, env file holds the PAT) is [§ 7.6a](../../docs/install-teams.md#76a-edge-in-privatelink-self-hosted-node-edge): confirm before running or restarting it, and never print its env file. Full steps and PL1-PL13: [docs/install-teams.md § 7](../../docs/install-teams.md#7-private-connectivity-optional).

## 6. Teams app

Messaging endpoint is the **edge Worker** origin, never the SPCS ingress:

```bash
bash apps/teams/scripts/set-bot-endpoint.sh
```

That sets `https://<TAB_BASE_HOST>/api/bot/messages` from `apps/teams/.env` (never the SPCS ingress). Discovers the Bot Service in `apps/teams/.env` `AZURE_TENANT_ID`. Set `RESOURCE_GROUP` / `BOT_NAME` if that tenant has more than one bot.

`SPCS_INGRESS_HOST` in `apps/teams/.env` must match the **current** tab-9 ingress (9c, no scheme; not used in privatelink), then:

```bash
bash packages/teams-manifest/zip.sh
# no Azure Bot yet: bash packages/teams-manifest/zip.sh --tab-only  (agents-teams-app-tab-only.zip, personal tab only)
```

Tell the user to sideload `packages/teams-manifest/agents-teams-app.zip` (Teams → Apps → Upload an app) or publish via Admin Center. `name.short` must stay ≤ 30 characters.

The **bot channel** does not do per-user OBO; production bot turns fail closed with a sign-in card. The **personal tab** is the supported per-user path (SSO → `/token/exchange` → same-origin `/api/*`). Hard-refresh Teams (Cmd+Shift+R) after sideload.

## 7. Verify

Tokenless probe (Worker deployed, `SPCS_BASE`/`SPCS_PAT`/`EDGE_SESSION_SECRET` present, `Origin` allowed):

```bash
curl -sS -w '\n%{http_code}\n' -H "Origin: https://<TAB_BASE_HOST>" \
  https://<TAB_BASE_HOST>/api/threads
```

Expect **401** and `{"error":"Unauthorized"}`. That 401 comes from the edge itself (no `X-Edge-Session`) and never reaches SPCS, so ingress + PAT is proven by the tab (and `smoke-test.sh` for the service and policy checks). Then the user opens the personal tab: SSO succeeds, agent list loads, an answer **streams**. The rows below that name SPCS errors show up in the tab's requests, not in this probe.

| Result | Next |
| --- | --- |
| 401 `Unauthorized` | Edge OK. Continue in the tab. |
| 302 / `sfc-oauth-begin` | The edge is not attaching `SPCS_PAT`. |
| 403 `Insufficient privileges to use` | PAT user missing `APP_PUBLIC`. |
| "Programmatic access token is invalid" | `SPCS_PAT` minted in a different Snowflake account from the ingress. Mint it in the ingress account, update `.env`, then `set-edge-secrets.sh` and `deploy-tab.sh`. |
| `390422` / "Incoming request with IP/Token <cloudflare-ip>" | PAT user-level network policy must allow Cloudflare egress ranges. In privatelink the endpoint-ID policy is meant to replace this but was not enforced in testing, so keep the Cloudflare policy ([PL3](../../docs/install-teams.md#pl3-the-private-ingress-rejects-the-edge-401-or-403)). |
| Tab banner "Your Snowflake account's network policy is blocking this connection" | SPCS NAT → Cortex hop. Policy on `CORTEX_TEAMS_OAUTH` with the NAT `/24` from `LOGIN_HISTORY`. In `hybrid`/`privatelink` with `internal` host mode it is the `COMPUTE_POOL` rule instead; `395090` instead means `internal` itself fails, use `account` ([PL1](../../docs/install-teams.md#pl1-390422-after-switching-to-hybrid-or-privatelink)). |
| Tab banner "You do not have access to that resource" (`agent_forbidden`) | The UI maps any upstream 401/403 to this. Read the container log first (Diagnostics below). `Upstream 401: Invalid OAuth access token` means no `upn` claim: step 4a. No matching user means step 4b. |
| 403 `Forbidden origin` on `/api/*` GETs | Stale edge deploy: same-origin GET/HEAD without `Origin` is accepted only when `Sec-Fetch-Site: same-origin`. Run `deploy-tab.sh` (no alias lag). POSTs always need an allowed `Origin`. |
| 429 `Too many requests` on `/token/exchange` | Limiter: 30/min per IP, 10/min per identity; honour `Retry-After`. Usually a 401/403 to re-mint loop; find the underlying 401/403 (often `agent_forbidden`). |
| Chat streams but the agent says a tool is unavailable | Default role lacks tool grants or the user has no default warehouse. Run the role grants and set `DEFAULT_WAREHOUSE`. |
| 500 `missing SPCS_BASE` | Fix `.env`, run `set-edge-secrets.sh`, then `deploy-tab.sh`. |
| Node edge exits at boot (`locked by another process`, mode or owner refusal, root, missing env) | Second replica, loose `/data` perms, or `--user 0` ([PL7](../../docs/install-teams.md#pl7-the-node-edge-will-not-start-or-the-link-store-is-locked)). Never loosen the checks. |
| 500 `Edge misconfigured` | Secrets on a different Worker name ([I14](../../docs/install-teams.md#i14-wrangler-deploy-workersdev-subdomain-or-worker-name)), or privatelink with no `SPCS_VPC` binding ([PL6](../../docs/install-teams.md#pl6-edge-misconfigured-500-in-privatelink)). |
| 500 / Cloudflare 1101 / banner "Failed to list threads: 500" | Placeholder `SPCS_BASE`. See failures.md I17; inspect with `cd packages/teams-edge && npx wrangler tail <worker>`. |
| Anything else | [references/failures.md](references/failures.md) |

**Test the bot** (the tab passing does not prove it): have the user @mention the app in a **channel or group chat**. Expect a sign-in card on first use; after they open the personal tab once, the next @mention gets an answer. No reply at all: see failures.md "Bot gets no reply" and tail the Worker for `bot request rejected: <reason>`. A 1:1 chat with the bot shows a Teams 404 `Conversation was not found`; that is expected (bot scopes are `team` and `groupChat`, the personal tab is the 1:1 path), not a failure.

A `200` is not proof. Check the response body: a chat that opens but shows an error banner, or an agent that answers "tool unavailable", is still a failed install.

### Diagnostics

Container log (Path A), which holds the real upstream error the UI redacts:

```bash
snow sql --role SYSADMIN -q "SELECT SYSTEM\$GET_SERVICE_LOGS('AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS',0,'agents-teams-app',400)" \
  | grep -E "Upstream|error|forbidden"
```

Edge Worker (run from `packages/teams-edge`, no `--env`): `npx wrangler tail <worker> --format pretty --search "<text>" --status error`. `--format json` is pretty-printed **multi-line** JSON, so line-based `grep`/`jq` see nothing; parse the whole stream or use `pretty`. Wrangler redacts `Authorization`. Bot Connector's user-agent is `Microsoft-SkypeBotApi`. Bot rejections log `bot request rejected: <reason>` (never token or header values).

HAR profiling: extract only method, path, status, timing, response-body error strings and header presence. Never values (HARs hold live bearer tokens). Tell the user not to paste HARs or request headers into chat, keep captures outside the repo (`*.har` is gitignored), and delete them afterwards.

A single transient `net::ERR_CONNECTION_RESET` on `/api/agent/run` cleared on its own once. If it recurs, record the time and collect the Worker tail and the container log for that minute before changing anything.

### Automated checks

The agent does not run these (hard rule); give the user the command with the `!` prefix.

| Script | Proves | Limits |
| --- | --- | --- |
| `validate-env.sh [--live]` | `.env` keys, GUIDs, host formats (no `pages.dev`), scope shape, secret lengths, tooling; `--live` checks `SPCS_INGRESS_HOST` against `SHOW ENDPOINTS`. Read-only. `deploy-spcs.sh` runs it first (`--skip-validate` to bypass) | Does not contact Entra or Cloudflare |
| `smoke-test.sh` | Edge status codes (400 / 401 / 200), service READY, live CORS origin, Entra identifier URI, built manifest host. Read-only. `deploy-spcs.sh` runs it last | Unavailable checks print SKIP; a stale manifest zip fails it |

## Cleanup

Delete `temp/alter-teams-secrets.sql` and any saved HAR when done; both can hold secrets.

## Tear down

Only if the user asks. See [docs/install-teams.md § 5](../../docs/install-teams.md#5-tear-down) (Path B: [B.6](../../docs/install-teams.md#b6-tear-down-path-b)). Confirm before `snow app teardown --cascade --force --no-interactive` from `apps/teams/native-app`, before `cd packages/teams-edge && npx wrangler delete --name <worker>`, and before dropping `AGENTS_TEAMS_NETWORK` (unset `NETWORK_POLICY` on `CORTEX_TEAMS_OAUTH` and the PAT user first if the tab 8 policies were applied).

## Changing TAB_BASE_HOST, or rolling an existing install

`create-dev-service.sql` is first-install only: it uses plain `CREATE SERVICE` and fails with "already exists" rather than silently keeping the old image. To roll an existing service use `bash apps/teams/scripts/deploy-spcs.sh [--no-build]`; it re-pins the image digest, rewrites the `Access-Control-Allow-Origin` origin to `https://<TAB_BASE_HOST>`, shows ALTER errors and checks the live spec afterwards.

When `TAB_BASE_HOST` (and `TAB_BASE_URL`) changes, update everything that embeds the host, in this order:

1. `apps/teams/.env`: `TAB_BASE_HOST`, `TAB_BASE_URL` (the only env file the scripts read; the repo-root `.env` is ignored).
2. `fill-dev-secrets.sh`, then apply the generated SQL (refreshes the `ALLOWED_ORIGINS` secret).
3. `deploy-spcs.sh --no-build` (service-spec CORS origin).
4. Entra: Application ID URI on the OBO app becomes `api://<TAB_BASE_HOST>/<OBO_CLIENT_ID>`.
5. `set-edge-secrets.sh` (`ENTRA_AUDIENCE_URI`), then `deploy-tab.sh`.
6. `set-bot-endpoint.sh`, then regenerate the manifest with a bumped version and re-sideload it.

Rollback: every push also tags the image `deploy-<sha>-<timestamp>`. Re-pin the previous digest by running `DESCRIBE SERVICE`, replacing the `@sha256:` value in the spec, and applying `ALTER SERVICE ... FROM SPECIFICATION`.
