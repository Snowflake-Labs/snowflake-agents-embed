# Teams failure catalog

Customer-safe probes. Do not print secret values. After any `bash apps/teams/scripts/set-edge-secrets.sh`, run `bash apps/teams/scripts/deploy-tab.sh` — `secret bulk` alone leaves warm isolates.

The edge is one Cloudflare Worker (`packages/teams-edge`). Its name is `EDGE_WORKER_NAME`, else legacy `PAGES_PROJECT`, else the first label of a `*.workers.dev` `TAB_BASE_HOST` (a `*.pages.dev` host maps to its name minus `.pages.dev`), else `agents-embed-teams`; both scripts read it from `apps/teams/.env`. Always invoke Wrangler from `packages/teams-edge`, and never pass `--env privatelink` to `tail` / `secret` (Wrangler would target `<worker>-privatelink`, which does not exist).

Source detail: [docs/teams/teams-troubleshooting.md § 4](../../../docs/teams/teams-troubleshooting.md).

---

## Setup script errors (install time)

Doc: [docs/teams/teams-troubleshooting.md § 4.1, During install](../../../docs/teams/teams-troubleshooting.md#41-during-install-script-and-deploy-errors). Fix the `apps/teams/.env` value, then re-run the same script (all are idempotent).

### I1 — tenant setup with `az`: `Cannot find user or service principal ... 'TEAMS_USERNAME=…'`

Probe: `grep -c '^TEAMS_USERNAME=TEAMS_USERNAME' apps/teams/.env` (do not print the value). Cause: doubled key, so the value starts with `TEAMS_USERNAME=`. Fix: single `TEAMS_USERNAME=user@domain`. Tell the user to re-run the step (the agent must not).

### I2 — `fill-dev-secrets.sh`: `APPS_API_HOST is not set`

Cause: key blank/commented; `fill-dev-secrets.sh` requires it. Fix: `APPS_API_HOST=apps-api.c1.<region>.<cloud>.app.snowflake.com`, re-run, then user reviews and applies `temp/alter-teams-secrets.sql` (gitignored) in the ingress account.

### I3 — `failed to connect to the docker API at unix:///…/docker.sock`

Probe: `docker info >/dev/null 2>&1 && echo up || echo down`. Fix: `open -a Docker`, wait, re-run. `docker context ls` if still failing.

### I4 — `<IMAGE_REPO>` / `<teams_na_image_repo_url>` placeholder

Probe: `snow sql -q "SHOW IMAGE REPOSITORIES IN SCHEMA AGENTS_TEAMS_APP_DB.PUBLIC"`. Use `repository_url` of `IMAGE_REPO` (Native App: `NA_IMAGE_REPO`): no scheme, no trailing slash, no `/agents-teams-app`. zsh treats unquoted `<...>` as a redirect, so substitute the value and drop the brackets.

### I14 — `wrangler deploy`: workers.dev subdomain or Worker name

Symptoms: `You need to register a workers.dev subdomain before publishing to workers.dev`; `EDGE_WORKER_NAME "…" is not a valid Worker name`; or `set-edge-secrets.sh` succeeded but `/token/exchange` answers 500 `Edge misconfigured` (secrets went to a different Worker). Cause: the first `wrangler deploy` creates the Worker (no project to create first), but publishing to workers.dev needs the account's subdomain; a name changed between the two scripts splits secrets from code. Fix: register the subdomain once (dashboard → Workers & Pages) or use a custom domain; set `EDGE_WORKER_NAME` in `apps/teams/.env` to the Worker that owns `TAB_BASE_HOST` (`<worker>.<account-subdomain>.workers.dev`); re-run `set-edge-secrets.sh`, then `deploy-tab.sh`. Verify: `cd packages/teams-edge && npx wrangler secret list --name <worker>` lists ten names. See [teams/teams-troubleshooting.md I14](../../../docs/teams/teams-troubleshooting.md#i14-wrangler-deploy-workersdev-subdomain-or-worker-name).

### I15 — `set-edge-secrets.sh`: `SNOWFLAKE_PAT is not set`

Fix (user runs; the secret is shown once): `ALTER USER AGENTS_TEAMS_SVC ADD PROGRAMMATIC ACCESS TOKEN <NAME> ROLE_RESTRICTION = '<role>' DAYS_TO_EXPIRY = 30;` then paste `token_secret` into `SNOWFLAKE_PAT=` (no whitespace). Never print it. Afterwards suggest removing superseded PATs with `ALTER USER … REMOVE PROGRAMMATIC ACCESS TOKEN <old>`. The same `✗ <NAME> is not set` covers every required key; in privatelink it stops instead with `NETWORK_MODE=privatelink needs SPCS_BASE=https://<privatelink_ingress_url>`. See [teams/teams-troubleshooting.md I15](../../../docs/teams/teams-troubleshooting.md#i15-set-edge-secretssh-snowflake_pat-is-not-set).

### I17 — `/api/*` 500, Cloudflare 1101, UI "Failed to list threads: 500"

Cause: the Worker secret `SPCS_BASE` is a placeholder, so `new Request(upstream)` in `packages/teams-edge/src/core/api-proxy.ts` throws `Invalid URL`. Probe (presence only): `grep -c '<' <<< "$(grep '^SPCS_INGRESS_HOST=' apps/teams/.env)"` non-zero means still a placeholder. Fix: `SHOW ENDPOINTS IN SERVICE AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS` → `ingress_url` into `SPCS_INGRESS_HOST` (no scheme; in privatelink set `SPCS_BASE=https://<privatelink_ingress_url>` instead) → `bash apps/teams/scripts/set-edge-secrets.sh` → `bash apps/teams/scripts/deploy-tab.sh` (secrets need a redeploy). Verify: reload the tab; the thread list loads. A tokenless `curl` returns the edge's own 401 even with a placeholder `SPCS_BASE` (it never builds the upstream URL), so it cannot confirm this fix.

### I16 — `deploy-tab.sh` DNS / fetch failure

Transient Wrangler network error. Retry; if persistent, `cd packages/teams-edge && npx wrangler whoami`.

### I21 — `CREATE SERVICE`: `Secret ... does not exist or not authorized`

Cause: `create-dev-service.sql` runs as SYSADMIN, which needs `READ` on all 12 secrets in `AGENTS_TEAMS_APP_DB.CONFIG`; an older bootstrap did not grant it. Fix (ACCOUNTADMIN): re-run `bootstrap-dev-spcs.sql` (idempotent), or `GRANT READ ON SECRET AGENTS_TEAMS_APP_DB.CONFIG.<name> TO ROLE SYSADMIN` for each, then re-run the rendered `create-dev-service.sql`. See [teams/teams-troubleshooting.md I21](../../../docs/teams/teams-troubleshooting.md#i21-create-service-secret--does-not-exist-or-not-authorized).

### Diagnostics — Need the real edge Worker exception

```bash
cd packages/teams-edge
npx wrangler tail <worker> --format pretty --search "<text>" --status error   # no --env, even in privatelink
npx wrangler secret list --name <worker>    # names only; expect ten
```

Then reproduce the failing request. Dashboard: Workers & Pages → the Worker → Logs; secrets under Settings → Variables and Secrets. macOS has no `timeout`; stop with Ctrl-C.

- `--format json` is pretty-printed multi-line JSON, so line-based `grep`/`jq` miss it; use `pretty`, or parse the whole stream.
- Wrangler redacts `Authorization`. Bot Connector calls carry the user-agent `Microsoft-SkypeBotApi`; bot rejections log `bot request rejected: <reason>`.
- Never paste HAR/header captures into chat: they contain live bearer tokens and edge sessions. Keep captures outside the repo (`*.har` is gitignored) and delete them afterwards.
- A single `net::ERR_CONNECTION_RESET` on `/api/agent/run` was transient once. If it recurs, note the time and collect the Worker tail and container log for that minute before changing anything.

### Bot gets no reply

Symptom: @mention in a channel or group chat gets no answer and no sign-in card. Probe: `npx wrangler tail <worker> --format pretty --search "bot request rejected"`, then @mention again. The reason says which check failed:

| Log reason | Meaning / fix |
| --- | --- |
| `jwt verification failed: <code>` | Wrong `BOT_APP_ID` (audience), wrong issuer, expired token or JWKS fetch failure. Fix `BOT_APP_ID`, `set-edge-secrets.sh`, `deploy-tab.sh` |
| `token has no serviceurl claim` / `serviceurl claim does not match activity` | Not a genuine Bot Connector call; do not loosen the check |
| `activity has no from.aadObjectId or channelData.tenant.id` | Not a Teams-user activity; expected for non-Teams senders |
| `missing or malformed Bearer token` | Unauthenticated probe (expected 401) |

No `bot request rejected` line at all: the messaging endpoint is wrong (`bash apps/teams/scripts/set-bot-endpoint.sh`) or the Teams channel on the Bot Service is disabled (`create-bot.sh`). Bot Connector tokens have no `iat`; the edge must not set `maxTokenAge`.

### 1:1 chat with the bot: Teams 404 `Conversation was not found` (expected)

Not a failure. The manifest's bot scopes are `team` and `groupChat`, so there is no personal bot conversation. Test by @mentioning the app in a channel or group chat; the personal tab is the 1:1 surface.

---

## AADSTS500011 — Teams sign-in, resource principal not found

**Symptom.** Token call to `login.microsoftonline.com/<tenant>/oauth2/v2.0/token` returns 400 `invalid_resource`, `AADSTS500011`, naming `api://<host>/<BOT_APP_ID>`. The tab may show Cloudflare "Nothing is here yet".

**Cause.** `TAB_BASE_HOST` (so manifest `webApplicationInfo.resource`) differs from the Entra Application ID URI, and/or the Worker is not deployed on that host (no first `deploy-tab.sh`, or a custom domain not attached). "Nothing is here yet" is a legacy `*.pages.dev` project with no Production deployment; on a Worker host the equivalent is a Cloudflare 404 / 1042.

**Probe.**

```bash
az ad app show --id <OBO_CLIENT_ID> --query identifierUris
grep -n '"resource"' packages/teams-manifest/manifest.json
cd packages/teams-edge && npx wrangler deployments list --name <worker>   # need an active version
```

**Fix.** Align `TAB_BASE_HOST` / `TAB_BASE_URL` with the registered URI host (or add the host with `az ad app update --id <OBO_CLIENT_ID> --identifier-uris …`, listing every URI to keep: the flag replaces the set; needs user approval), then `set-edge-secrets.sh`, `deploy-tab.sh`, `set-bot-endpoint.sh`, update SPCS `ALLOWED_ORIGINS` and roll, `zip.sh`, re-upload in Teams. Moving off `*.pages.dev` follows the same order ([teams/teams-install.md § 6](../../../docs/teams/teams-install.md#6-pages-to-worker-cutover)). See [teams/teams-troubleshooting.md T1](../../../docs/teams/teams-troubleshooting.md#t1-aadsts500011-and-nothing-is-here-yet).

---

## AADSTS65005 — `/token/exchange` 401

**Symptom.** Tab signs in; `POST https://<TAB_BASE_HOST>/token/exchange` returns 401 with `code":"AADSTS65005"` (Entra status 400: scope/resource does not exist).

**Cause.** `SNOWFLAKE_SCOPE` (the edge Worker secret **and** the Snowflake `SNOWFLAKE_SCOPE` secret) points at the Teams SSO/bot app, or uses `SESSION:ROLE-ANY`. OBO needs the **Snowflake OAuth resource** app and lowercase `session:role-any`. `set-edge-secrets.sh` derives the edge value from `SNOWFLAKE_ENTRA_APP_ID` (`api://<id>/session:role-any`, or `session:role:<SNOWFLAKE_OAUTH_ROLE>` when that is set), so a wrong edge scope means a wrong `SNOWFLAKE_ENTRA_APP_ID`.

**Probe.**

```bash
az ad app show --id <snowflake-resource-app-id> \
  --query "{appId:appId,uris:identifierUris,scopes:api.oauth2PermissionScopes[].value,preAuth:api.preAuthorizedApplications}"
```

Expect identifier `api://<snowflake-resource-app-id>`, scope `session:role-any`, Teams app pre-authorized. Compare `apps/teams/.env` `SNOWFLAKE_ENTRA_APP_ID` / `SNOWFLAKE_SCOPE` **shape** only — do not print secrets.

**Fix.** Fix `SNOWFLAKE_ENTRA_APP_ID` in `apps/teams/.env`, then `bash apps/teams/scripts/set-edge-secrets.sh` and `bash apps/teams/scripts/deploy-tab.sh`. Set the Snowflake `SNOWFLAKE_SCOPE` secret to `api://<snowflake-resource-app-id>/session:role-any` (Path A: `fill-dev-secrets.sh`, apply `temp/alter-teams-secrets.sql`, `deploy-spcs.sh`; Native App: `CONFIGURE_OAUTH` with that same resource app, not `OBO_CLIENT_ID`, then `ROLL_SERVER_SERVICE`). A healthy exchange returns `{ edgeSession, expiresIn }`; the Snowflake token never reaches the browser.

---

## Programmatic access token is invalid (wrong-account PAT)

**Symptom.** Tab shows "Programmatic access token is invalid." The edge's `/api/*` fails at the ingress; nothing reaches the container.

**Cause.** `SPCS_PAT` was minted in a different Snowflake account from the one hosting the SPCS ingress (easy when several `snow` connections exist). A whitespace-wrapped PAT is a different failure: see the `FAULT` row below.

**Probe.**

```sql
SELECT CURRENT_ACCOUNT_NAME();   -- run on the connection that minted the PAT; compare with the ingress host's account
```

Compare that with the account in `SPCS_INGRESS_HOST` / `SPCS_BASE`. Do not print the PAT.

**Fix.** In the ingress account, mint a token for the PAT user, put it in `apps/teams/.env` `SNOWFLAKE_PAT` (no whitespace), then:

```bash
bash apps/teams/scripts/set-edge-secrets.sh
bash apps/teams/scripts/deploy-tab.sh
```

**Verify.** Reload the tab: the error moves on (often to the Cloudflare IP error, which is the next fix). A tokenless probe cannot show this: the edge answers it with its own 401 before calling SPCS. A direct PAT request to the ingress from your own IP is blocked by a Cloudflare-only PAT policy.

---

## 390303 / `agent_forbidden` on `/api/threads` ("You do not have access to that resource")

**Symptom.** Teams `POST /api/threads` 401 `agent_forbidden`; upstream `390303` or `null`. Tab banner "You do not have access to that resource."

**Cause.** The UI shows `agent_forbidden` for **any** upstream 401/403 (only Snowflake 390422 becomes `network_policy_blocked`), so the banner does not identify the cause. Read the container log first (Path A):

```bash
snow sql --role SYSADMIN -q "SELECT SYSTEM\$GET_SERVICE_LOGS('AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS',0,'agents-teams-app',400)" | grep -E "Upstream|error|forbidden"
```

Then branch on the log line:

1. `Upstream 401: Invalid OAuth access token`: the token has no `upn` claim. See [Invalid OAuth access token](#invalid-oauth-access-token-missing-upn-claim).
2. Token accepted but no user: no Snowflake user's `login_name` equals the person's Entra UPN. `CORTEX_TEAMS_OAUTH` maps `upn` only (`email` and `preferred_username` are user-editable and not accepted).
3. Chat streams but a tool is "unavailable": see the next entry.

**Probe (cause 2).**

```sql
SELECT CURRENT_ACCOUNT_NAME();
SHOW USERS LIKE '<snowflake_user>';
SELECT name, login_name, default_role, default_warehouse
FROM SNOWFLAKE.ACCOUNT_USAGE.USERS
WHERE deleted_on IS NULL AND LOWER(login_name) = LOWER('<entra-upn>');   -- no row = cause 2
DESC SECURITY INTEGRATION CORTEX_TEAMS_OAUTH;   -- EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM should be ('upn')
```

**Fix (cause 2).** First check for a user that already has that `login_name` (`CREATE USER IF NOT EXISTS` matches the user name, not the login):

```sql
SHOW USERS;
SELECT "name", "default_role" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE LOWER("login_name") = LOWER('<entra-upn>');
```

If a row returns, do not create a user: grant `AGENTS_TEAMS_USER` to that user's `default_role` and skip the `CREATE USER` below. Otherwise:

```sql
CREATE USER IF NOT EXISTS <snowflake_user> LOGIN_NAME = '<entra-upn>'
  DEFAULT_ROLE = AGENTS_TEAMS_USER DEFAULT_WAREHOUSE = <warehouse>;
GRANT ROLE AGENTS_TEAMS_USER TO USER <snowflake_user>;
GRANT USAGE ON DATABASE <db> TO ROLE AGENTS_TEAMS_USER;
GRANT USAGE ON SCHEMA <db>.<schema> TO ROLE AGENTS_TEAMS_USER;
GRANT USAGE ON AGENT <db>.<schema>.<agent> TO ROLE AGENTS_TEAMS_USER;
```

Reload the tab (no sideload required). Ask the user for the UPN; do not guess it.

---

## Invalid OAuth access token (missing `upn` claim)

**Symptom.** Tab banner `agent_forbidden`; container log `Upstream 401: Invalid OAuth access token`. `/token/exchange` succeeded.

**Cause.** The Snowflake resource app issues v2 tokens and has no `upn` access-token optional claim, so `CORTEX_TEAMS_OAUTH` (mapping claim `upn`) cannot map the token.

**Probe.**

```bash
az ad app show --id "$SNOWFLAKE_ENTRA_APP_ID" --query "{v:api.requestedAccessTokenVersion, c:optionalClaims.accessToken[].name}"
```

Expect `v` = `2` and `c` containing `upn`.

**Fix** (needs user approval; edits tenant config):

```bash
az ad app update --id "$SNOWFLAKE_ENTRA_APP_ID" --requested-access-token-version 2 \
  --optional-claims '{"accessToken":[{"name":"upn","essential":false}]}'
```

Use `--requested-access-token-version 2`; `--set api.requestedAccessTokenVersion=2` fails with `Couldn't find 'api'`. Then reload the tab: the edge session caches the old token.

---

## 403 `Forbidden origin` on `/api/*`

**Symptom.** Same-origin GETs (threads, agents) return `{"error":"Forbidden origin"}` while POSTs work.

**Cause.** Browsers omit `Origin` on same-origin GET/HEAD. The edge (`packages/teams-edge/src/core/api-proxy.ts`) accepts that only with `Sec-Fetch-Site: same-origin`; POSTs always need an allowed `Origin`. An older edge deploy lacks the allowance, and a new deploy can take ~15s to reach every location.

**Fix.** `bash apps/teams/scripts/deploy-tab.sh`, wait, re-probe. A tokenless cross-site GET must still be refused.

---

## 429 `Too many requests` on `/token/exchange`

**Symptom.** Tab fails to sign in; `POST /token/exchange` returns 429 with `Retry-After`.

**Cause.** Limits are 30/min per IP and 10/min per identity. The usual trigger is a loop: an upstream 401/403 makes the tab re-mint, and concurrent requests each re-mint. `useTeamsAuth` now single-flights the exchange, so any remaining loop means a real 401/403 to fix (often `agent_forbidden`).

**Fix.** Wait `Retry-After`, fix the underlying 401/403, reload.

---

## `set-bot-endpoint.sh` finds no Bot Service

**Cause.** No `Microsoft.BotService/botServices` resource exists in `AZURE_TENANT_ID` (`create-bot.sh` has not run, or ran in another tenant).

**Fix.** `bash apps/teams/scripts/create-bot.sh` (dry run), then `--apply` after the user confirms; it only creates what is missing and never edits an existing bot. The personal tab works without the bot.

## Add to channel: `BadRequest ... BulkMembershipRequest`

**Cause.** The manifest's `bots[].botId` has no Azure Bot Service, or its Teams channel is disabled. See [I20](../../../docs/teams/teams-troubleshooting.md#i20-adding-the-app-to-a-channel-badrequest--bulkmembershiprequest).

**Fix.** `bash apps/teams/scripts/create-bot.sh` to diagnose; `--apply` to create (confirm first: it creates Azure resources). `smoke-test.sh` reports the same under Bot.

---

## Chat works but the agent says a tool is unavailable (RBAC)

**Symptom.** The agent streams a reply, then says a tool (for the test agent, "Superstore Analyst") is not available. No error banner, so an HTTP-status check passes.

**Cause.** The user's **default role** lacks a grant the tool needs, or the user has no default warehouse. Cortex drops tools the caller cannot use rather than failing. Typical gaps: the semantic view and its base tables, the search service, custom functions, warehouse `USAGE`, `SNOWFLAKE.CORTEX_USER`.

**Probe.**

```sql
SELECT CURRENT_ACCOUNT_NAME();
SHOW USERS LIKE '<snowflake_user>';          -- default_role, default_warehouse must be set
SHOW GRANTS TO ROLE AGENTS_TEAMS_USER;       -- compare with the agent's tools
```

**Fix.** Grant the role everything the agent uses. Grant `AGENTS_TEAMS_USER` everything the agent uses, then:

```sql
ALTER USER <snowflake_user> SET DEFAULT_ROLE = AGENTS_TEAMS_USER, DEFAULT_WAREHOUSE = <warehouse>;
```

Start a **new** chat; the old thread keeps the earlier answer.

---

## Tokenless `/api/threads` is not 401, or the tab's own `/api/*` fails at the ingress

**Probe.**

```bash
curl -sS -w '\n%{http_code}\n' -H "Origin: https://<TAB_BASE_HOST>" \
  https://<TAB_BASE_HOST>/api/threads
```

The tokenless 401 is the edge's own: with no `X-Edge-Session` it returns before calling SPCS. It proves the Worker is deployed on that host, `SPCS_BASE` / `SPCS_PAT` / `EDGE_SESSION_SECRET` are set and the `Origin` is allowed. It does **not** prove the ingress accepts the PAT. The ingress rows below show up on the tab's own (session-bearing) `/api/*` calls in the browser network panel, or from a direct PAT request to the ingress.

| Result | Seen on | Cause | Fix |
| --- | --- | --- | --- |
| 401 `{"error":"Unauthorized"}` | probe | Healthy edge | Continue in the tab |
| 403 `{"error":"Forbidden origin"}` | probe | `Origin` not the Worker host | See "403 `Forbidden origin`" above |
| 500 `Proxy misconfigured: missing SPCS_BASE` / `SPCS_PAT` / `EDGE_SESSION_SECRET` | probe | That Worker secret is unset | `set-edge-secrets.sh`, then `deploy-tab.sh` |
| 500 `{"error":"Edge misconfigured"}` | probe, tab | Every edge route: privatelink deploy without the `SPCS_VPC` binding. `/token/exchange` only: secrets on a different Worker | PL6, or I14 |
| 302 / `sfc-oauth-begin` | tab | Ingress saw no valid credential: the edge did not attach `SPCS_PAT` | `set-edge-secrets.sh`, then `deploy-tab.sh` |
| 403 `Insufficient privileges to use <ingress>` | tab | PAT user lacks endpoint access | Native App: `GRANT APPLICATION ROLE AGENTS_TEAMS_APP.APP_PUBLIC TO USER "<pat-user>"`. Path A: the `AGENTS_TEAMS!ALL_ENDPOINTS_USAGE` service-role grant in `create-dev-service.sql` (single-quote it in zsh, I6) |
| 500 `{"responseType":"FAULT","detail":""}` | tab | Ingress rejected `SPCS_PAT` (whitespace in the JWT, often a wrapped signature). Container logs stay empty | Strip spaces from `apps/teams/.env` `SNOWFLAKE_PAT`, `set-edge-secrets.sh`, `deploy-tab.sh` |
| 500, Cloudflare 1101 | tab | Placeholder `SPCS_BASE` | I17 |
| Hitting **ingress** with no PAT → 302 | direct | Expected | The edge must attach the PAT; do not use ingress as the bot endpoint |

---

## Cloudflare IP blocked at ingress

**Symptom.** `/api/*` 401: `Incoming request with IP/Token <public-ip> is not allowed`. The IP is a Cloudflare edge range (`104.16/13`, `172.64/13`, `162.158/15`, …), not SPCS NAT and not `10.x`.

**Cause.** The edge Worker authenticates to ingress with `SPCS_PAT`. Snowflake evaluates that **PAT user's** network policy against the Cloudflare egress IP. The managed account policy is not the lever. In `privatelink` the PAT user's policy is `AGENTS_TEAMS_PL_INGRESS_POLICY` (private endpoint IDs), which replaces this one; a Cloudflare IP there means the edge was deployed without `--privatelink` or `SPCS_BASE` still points at the public ingress ([PL3](../../../docs/teams/teams-private-connectivity.md#pl3-the-private-ingress-rejects-the-edge-401-or-403)).

**Fix.** Run `bash apps/teams/scripts/set-svc-network-policy.sh [-c <conn>] [--apply]` (dry run by default; skips a user that already has another user-level policy unless `--replace`). This is an explicit install step ([teams/teams-install.md 5a](../../../docs/teams/teams-install.md)), not optional: `smoke-test.sh` now fails without it. The manual equivalent: give the PAT user a user-level policy that allows Cloudflare egress. Use the published ranges (<https://www.cloudflare.com/ips-v4>) in a dedicated policy; do not use `0.0.0.0/0`. Do **not** edit `ACCOUNT_VPN_POLICY_SE` and do **not** add Cloudflare ranges to the account policy.

```sql
CREATE NETWORK POLICY IF NOT EXISTS AGENTS_TEAMS_INGRESS_POLICY
  ALLOWED_IP_LIST = ('<cloudflare-ipv4-cidr>', '<cloudflare-ipv4-cidr>' /* …full ips-v4 list */);
ALTER USER "<pat-user>" SET NETWORK_POLICY = AGENTS_TEAMS_INGRESS_POLICY;   -- or <customer-allow-policy>
```

This is a different hop from `390422` on Cortex below: that one is fixed on the `CORTEX_TEAMS_OAUTH` integration, this one on the PAT user. Both can be needed on a fresh account, this one first.

Then confirm `SNOWFLAKE_PAT` in `apps/teams/.env` is that user's **ACTIVE** token, and run `bash apps/teams/scripts/set-edge-secrets.sh` then `bash apps/teams/scripts/deploy-tab.sh`.

**Verify.** Reload the tab; the IP error is gone. A tokenless probe cannot show this (the edge's own 401), and a direct PAT request from a laptop is blocked by this very policy, as intended.

---

## `Token expired` at ingress

**Symptom.** `/api/*` 401 `Token expired. …`. Often works for a few minutes after a PAT change, then fails. JWT `exp` still looks far-future.

**Cause.** Deployed `SPCS_PAT` is a **rotated-out** PAT. Rotation leaves a short grace window, then `394401`.

**Probe.**

```sql
SHOW USER PROGRAMMATIC ACCESS TOKENS FOR USER "<pat-user>";
```

Use the `ACTIVE` row, not `*_ROTATED_*`.

**Fix.** Put the ACTIVE token in `apps/teams/.env` `SNOWFLAKE_PAT` (the user pastes it; never print it), then `bash apps/teams/scripts/set-edge-secrets.sh` and `bash apps/teams/scripts/deploy-tab.sh`. Every rotation needs both steps.

---

## 390422 on Cortex (`/api/agent/run` or `/api/threads`)

**Symptom.** Upstream `390422`: IP/token not allowed. In the tab the banner reads "Your Snowflake account's network policy is blocking this connection". Blocked IP is often a **private** `10.x` (internal SPCS route) or the compute-pool **public NAT**.

**Cause.** This is the SPCS → Cortex hop, not the Cloudflare → ingress hop (see "Cloudflare IP blocked at ingress"). The NAT range is region-specific, so never reuse a range from another account or from older docs. If the blocked IP is public and the image is current, the account policy simply lacks the NAT range. Otherwise a Cortex URL built from injected `SNOWFLAKE_HOST` uses an un-allowlistable private path. In `public` the shipped image builds from `SNOWFLAKE_ACCOUNT` (`SNOWFLAKE_HOST_MODE=account`, public NAT). Do **not** tell the customer to edit server source.

In `hybrid` / `privatelink` with `SNOWFLAKE_HOST_MODE=internal` the blocked IP is a private address and a NAT `/24` cannot match it. But `internal` is experimental: it returned `395090` for forwarded user tokens in testing, and `account` mode worked ([PL8](../../../docs/teams/teams-private-connectivity.md#pl8-395090-with-snowflake_host_modeinternal)). If you do use `internal`, the fix is `AGENTS_TEAMS_POOL_POLICY` (a `COMPUTE_POOL` ingress rule for `AGENTS_TEAMS_APP_POOL`) on `CORTEX_TEAMS_OAUTH`, applied from wizard 8c or [teams/teams-private-connectivity.md § 7.4](../../../docs/teams/teams-private-connectivity.md#74-network-sql-accountadmin) **before** Create/Roll. A user with their own network policy overrides the integration's, so that policy also needs the pool rule. See [PL1](../../../docs/teams/teams-private-connectivity.md#pl1-390422-after-switching-to-hybrid-or-privatelink).

External-OAuth source-IP is the network policy **on the integration**, independent of the account policy.

**Probe.**

```sql
SELECT CURRENT_ACCOUNT_NAME();   -- must be the ingress account
SELECT client_ip, is_success, error_message
FROM SNOWFLAKE.ACCOUNT_USAGE.LOGIN_HISTORY      -- can lag a few minutes
WHERE user_name ILIKE '%<login>%'
ORDER BY event_timestamp DESC LIMIT 5;
```

If `ACCOUNT_USAGE` has not caught up, use `TABLE(SNOWFLAKE.INFORMATION_SCHEMA.LOGIN_HISTORY(...))`. The `SNOWFLAKE.` prefix is required; bare `INFORMATION_SCHEMA.LOGIN_HISTORY` is an invalid object.

**Fix (`public`).** Attach a scoped policy to `CORTEX_TEAMS_OAUTH` using the **observed** public NAT `/24` from `LOGIN_HISTORY` (do not copy an example range from another account). Never allowlist `10.x`.

```sql
USE ROLE ACCOUNTADMIN;
CREATE OR REPLACE NETWORK POLICY AGENTS_TEAMS_SPCS_POLICY
  ALLOWED_IP_LIST = ('<observed-nat-prefix>/24');
ALTER SECURITY INTEGRATION CORTEX_TEAMS_OAUTH
  SET NETWORK_POLICY = AGENTS_TEAMS_SPCS_POLICY;
```

---

## Stale Worker behaviour after secret rotation

**Cause.** Warm isolates keep the old values. `wrangler secret bulk` (what `set-edge-secrets.sh` runs) is not enough.

**Fix.** `bash apps/teams/scripts/deploy-tab.sh`.

---

## Personal tab “Couldn’t sign you in”

**Cause.** The edge origin is not the Entra-authorized host. A new custom domain or `*.workers.dev` host fails until it is on the Entra / Teams SSO app.

**Fix.** Reuse the existing `EDGE_WORKER_NAME` / `TAB_BASE_HOST`. Point wizard tab 9 (9a CDN Domain), `TAB_BASE_URL`, and the manifest at that same origin. Moving from a Pages host is the cutover in [teams/teams-install.md § 6](../../../docs/teams/teams-install.md#6-pages-to-worker-cutover).

---

## Sideload `UnableToParseTeamsAppManifest` / `name.short`

**Cause.** Teams caps `name.short` at 30. Rebuild with `bash packages/teams-manifest/zip.sh` (template short name is `Snowflake Agent (Unofficial)`). Confirm `SPCS_INGRESS_HOST` matches the **current** ingress before zipping.

---

## Legacy: `wrangler pages deploy` `Project not found` (`8000007`)

Only from an old Pages-era script or runbook. `deploy-tab.sh` now runs `wrangler deploy`, and the first deploy creates the Worker, so there is no project to create. If you see this, you are running a stale command: use `deploy-tab.sh` and, for an existing `*.pages.dev` install, follow the cutover in [teams/teams-install.md § 6](../../../docs/teams/teams-install.md#6-pages-to-worker-cutover). Do not create a new Pages project.

---

## `Cannot find module 'miniflare'` / Wrangler fails at repo root

**Fix.** `cd packages/teams-edge` before `npx wrangler`.

---

## `snow: No such option: -c`

**Fix.** `snow sql -c demo …` or `SNOWFLAKE_DEFAULT_CONNECTION_NAME`. Never `snow -c demo sql`.

---

## Voice dictation missing in the Teams tab

By design. Teams tabs block the browser speech API in the iframe. Not a deploy failure.

---

# Private connectivity (`hybrid` / `privatelink`) only

PL1-PL7 come from the design; PL8-PL10 were observed on AWS PrivateLink on 2026-10-09. The Worker + cloudflared path itself passed (tab chat and a real Teams bot message). It also passed on Azure (2026-10-10) and GCP (2026-10-11) without the real bot message; PL11-PL14 come from those runs. The Node edge and the GCP teardown are untested. Doc: [teams/teams-private-connectivity.md § 7.7](../../../docs/teams/teams-private-connectivity.md#77-private-connectivity-failures). In `public` none of them apply.

### PL1 — 390422 after switching to `hybrid` or `privatelink`

The container now takes the internal route (`SNOWFLAKE_HOST_MODE=internal`), which a NAT `/24` cannot match. Apply the `COMPUTE_POOL` rule SQL (wizard 8c, or [§ 7.4](../../../docs/teams/teams-private-connectivity.md#74-network-sql-accountadmin)) **before** Create/Roll. Users with their own network policy override the integration's; the wizard's `POLICY_REFERENCES` query lists them (it can lag ~2 hours), and their policies need the pool rule too. [PL1](../../../docs/teams/teams-private-connectivity.md#pl1-390422-after-switching-to-hybrid-or-privatelink).

### PL2 — NXDOMAIN for a `.privatelink` host

From the edge side (VPC VM, cloudflared host): private DNS for the `privatelink_ingress_url` host is missing; add the records from `SYSTEM$GET_PRIVATELINK_CONFIG` ([§ 7.5](../../../docs/teams/teams-private-connectivity.md#75-private-dns)). Inside SPCS: `SNOWFLAKE_ACCOUNT` must stay in the org-account form, because the `.privatelink` account host does not resolve there. [PL2](../../../docs/teams/teams-private-connectivity.md#pl2-nxdomain-for-a-privatelink-host).

### PL3 — The private ingress rejects the edge (401 or 403)

`401` "Incoming request with IP/Token … is not allowed": the private endpoint ID in `AGENTS_TEAMS_PL_INGRESS_RULE` (`AWSVPCEID` / `AZURELINKID` / `GCPPSCID`) is wrong or missing, the policy is not on the PAT user, or the edge still calls the public ingress (Cloudflare IP). Fix the rule or `SPCS_BASE`; do not widen the policy to the internet. `403 Insufficient privileges`: the PAT user lacks `APP_PUBLIC`. The edge probe still returns its own 401; check in the tab. [PL3](../../../docs/teams/teams-private-connectivity.md#pl3-the-private-ingress-rejects-the-edge-401-or-403).

### PL4 — Northstar host, audience, or certificate mismatch

Copy `SPCS_BASE` verbatim from `SHOW ENDPOINTS` (`privatelink_ingress_url`), including any `-next` form, and build DNS from that actual host. Known issues: the token audience can differ from the host form, and the wildcard can miss the served certificate SAN. [PL4](../../../docs/teams/teams-private-connectivity.md#pl4-northstar-host-audience-or-certificate-mismatch).

### PL5 — `cloudflared` cannot connect (UDP 7844)

The tunnel host needs outbound UDP 7844 (QUIC) to Cloudflare, with TCP 7844 (HTTP/2) as the fallback. Open that egress on the VPC VM's security group / firewall, or run `cloudflared tunnel run --protocol http2 <tunnel>` if UDP cannot be opened, then re-check the tunnel in the dashboard. [PL5](../../../docs/teams/teams-private-connectivity.md#pl5-cloudflared-cannot-connect-udp-7844).

### PL6 — 500 `Edge misconfigured` in `privatelink`

The tab loads (static assets do not run the Worker), but every `/api/*` and `/token/*` request is 500 `{"error":"Edge misconfigured"}`: the deployed Worker has `SPCS_UPSTREAM=vpc` but no `SPCS_VPC` binding (the edge fails closed). Set `SPCS_VPC_SERVICE_ID` in `apps/teams/.env` (`npx wrangler vpc service create …` prints it), then `bash apps/teams/scripts/deploy-tab.sh --privatelink`. [PL6](../../../docs/teams/teams-private-connectivity.md#pl6-edge-misconfigured-500-in-privatelink).

### PL7 — Node edge will not start or the link store is locked

The self-hosted edge refuses to boot on: a second replica holding the SQLite lock (`locked by another process`), a data dir or DB file that is group or world accessible or owned by another user, running as root, or a missing required variable (`BOT_APP_ID` and `BOT_LINK_SECRET` are required). Run exactly one replica, fix the volume with `chown node:node` and `chmod 700` (dir) / `600` (file), and never delete the `-wal` or `-shm` files. [PL7](../../../docs/teams/teams-private-connectivity.md#pl7-the-node-edge-will-not-start-or-the-link-store-is-locked).

Tear down: [§ 7.8](../../../docs/teams/teams-private-connectivity.md#78-tear-down-private-connectivity).

---

# Native App (Path B) only

Installed via the Native App ([teams/teams-native-app.md § B.5](../../../docs/teams/teams-native-app.md#b5-native-app-failures)).

## Service `ENOTFOUND` for `*.snowflakecomputing.com`

**Symptom.** Container cannot resolve Cortex; `DESC SERVICE` still lists the EAI.

**Cause.** `EXTERNAL_ACCESS` spec `cortex_and_entra_egress` is pending.

**Probe / fix.**

```sql
SHOW PENDING SPECIFICATIONS IN APPLICATION AGENTS_TEAMS_APP;
ALTER APPLICATION AGENTS_TEAMS_APP APPROVE SPECIFICATION cortex_and_entra_egress SEQUENCE_NUMBER = <n>;
```

Recreate the service (`CREATE_SERVER_SERVICE`) after approval. Confirm first.

---

## Service never READY / climbing `restartCount`

**Cause.** arm64 image (`exec format error`). Rebuild `--platform linux/amd64`, retag, push `:latest` to `NA_IMAGE_REPO`, then `./scripts/native-app-release.sh teams v1`.

---

## `397012: Image … not found`

**Cause.** `:latest` missing from the **manifest** repo (`na_image_repo`), or tagged into `IMAGE_REPO` instead. Push to `/agents_teams_app_db/public/na_image_repo/agents-teams-app:latest`.

---

## Create Service needs `USAGE` on `AGENTS_TEAMS_EAI`

**Cause.** An account-level integration of that name already exists.

```sql
GRANT USAGE ON INTEGRATION AGENTS_TEAMS_EAI TO APPLICATION AGENTS_TEAMS_APP;
```

Retry Create Service.

---

## `093118` — cannot grant `CREATE INTEGRATION`

**Cause.** That privilege is not on the manifest. Create `CORTEX_TEAMS_OAUTH` as `ACCOUNTADMIN`, then `GRANT MODIFY ON INTEGRATION CORTEX_TEAMS_OAUTH TO APPLICATION AGENTS_TEAMS_APP`.

---

## `395089` spec template / `Unknown function SYSTEM$GET_SECRET_STRING`

**Cause.** Installed app version is stale (`cdn_origin` not JSON-encoded, or old secret API).

**Fix.** `./scripts/native-app-release.sh teams v1`, then retry `CREATE_SERVER_SERVICE` / `SET_SECRET`.

---

## Service `FAILED` — `Missing required environment variable: ALLOWED_ORIGINS`

**Cause.** `CREATE_SERVER_SERVICE` did not write `CONFIG.ALLOWED_ORIGINS` from the CDN origin (old version, or origin omitted).

**Fix.** Upgrade the app, then `CREATE_SERVER_SERVICE('https://<TAB_BASE_HOST>')` so production `TEAMS_AUTH_MODE` can boot.

### PL8 — `395090` with `SNOWFLAKE_HOST_MODE=internal`

Every container → Snowflake call fails with upstream 401 `395090` ("Please use OAuth"); the tab shows `agent_forbidden`; no `390422`. Cause: the SPCS-internal host accepts only the SPCS-issued service token, so forwarded External OAuth, PAT and JWT credentials are rejected regardless of `enableCustomCredentials` or the pool rule. The server reports it as `host_mode_rejects_user_token`. Fix: set `SNOWFLAKE_HOST_MODE: account` in the live spec and keep the T8 policy. `deploy-spcs.sh` writes `account` by default; only `SPCS_HOST_MODE=internal` in `apps/teams/.env` writes `internal`. Open question for Snowflake: a private egress path for non-SPCS credentials. [PL8](../../../docs/teams/teams-private-connectivity.md#pl8-395090-with-snowflake_host_modeinternal)

### PL9 — The PAT still works from the internet

With `AGENTS_TEAMS_PL_INGRESS_POLICY` attached to the PAT user, a laptop PAT still gets `200` on the public ingress and the SQL API; `LOGIN_HISTORY_BY_USER` shows `client_ip` `0.0.0.0` and no rejection. Do not rely on the endpoint-ID policy as the control. Keep `ROLE_RESTRICTION`, short expiry and the T7 policy, and raise it with Snowflake. Test the ingress with `Authorization: Snowflake Token="<PAT>"`, not `Bearer`. [PL9](../../../docs/teams/teams-private-connectivity.md#pl9-the-pat-still-works-from-the-internet)

### PL10 — `thread_not_found` 404 after enforcing

After `SYSTEM$ENFORCE_PRIVATELINK_ACCESS_ONLY()` the tab's `GET /api/threads` returned 404 `thread_not_found` (any upstream 404 maps to it), with no `Upstream 404` in the container log and `200 []` for the same call with the service PAT. Cause undetermined. Enforcement also did not block public key-pair or PAT logins, and the public ingress went to 500. Revert with `SELECT SYSTEM$DISABLE_PRIVATELINK_ACCESS_ONLY();` (through the SSM port-forward recovery path if needed) and retry. Never enforce without an explicit go-ahead. [PL10](../../../docs/teams/teams-private-connectivity.md#pl10-thread_not_found-404-after-enforcing)

### PL11 — Account network policy blocks the container's egress (`account` host mode)

Tab shows the T8 "network policy is blocking this connection" banner and the agent selector is empty, but the PAT user works. `SNOWFLAKE.INFORMATION_SCHEMA.LOGIN_HISTORY` shows the user from an SPCS egress address (a pool, e.g. a `/24`; `35.246.9.x` on GCP `europe-west2`, `153.45.151.x` on Azure westus2) as `INCOMING_REQUEST_BLOCKED`. Fix: allow the egress range for the Teams users or `CORTEX_TEAMS_OAUTH` only; never edit the account-wide policy. Full entry: [PL11](../../../docs/teams/teams-private-connectivity.md#pl11-account-network-policy-blocks-the-containers-egress-account-host-mode).

### PL12 — Agent selector empty although agents exist

`runShowAgents` (`cortex-server/src/snowflake/list-agents.ts`) returns `[]` on any non-OK response, so a blocked login or missing grant looks like no agents. Check `LOGIN_HISTORY` and the `agents-teams-app` container log first. If the PAT user's `SHOW AGENTS` is `200` with no rows, the role lacks `USAGE ON AGENT` (a grants script may not grant it): grant it. Known code gap. See [PL12](../../../docs/teams/teams-private-connectivity.md#pl12-the-agent-selector-is-empty-although-agents-exist).

### PL13 — Default agent needs a warehouse the account lacks

Sample agent references `CORTEX_WH`; fresh trial accounts have none, and the user's `DEFAULT_ROLE` needs a default warehouse. Create or point at a warehouse, grant `USAGE`, set `DEFAULT_WAREHOUSE`. See [PL13](../../../docs/teams/teams-private-connectivity.md#pl13-the-default-agent-needs-a-warehouse-the-account-does-not-have).

### PL14 — GCP Secret Manager IAM denied for the tunnel VM

`gcloud secrets add-iam-policy-binding` returns `403 secretmanager.secrets.setIamPolicy` denied, so the VM service account cannot read the tunnel token and `cloudflared` never starts. Ask a project admin for `secretAccessor` on that one secret; do not widen IAM yourself. Fallback only with the user's explicit OK: pass the token in an instance metadata key, then remove the key and delete the secret straight after `cloudflared` is active. See [PL14](../../../docs/teams/teams-private-connectivity.md#pl14-gcp-secret-manager-iam-denied-for-the-tunnel-vm).
