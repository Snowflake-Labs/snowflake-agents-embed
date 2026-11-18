# Snowflake Agents for Teams (Unofficial)

A Microsoft Teams **tab + bot** that brings [Snowflake Cortex Agents](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents) into Teams. Users chat with a named Cortex Agent and get streamed answers with thinking steps, inline citations, Vega-Lite charts, and virtualized data tables — all inside Teams, authenticated as the signed-in user.

The app ships as a **Snowflake Native App** running on Snowpark Container Services (SPCS), with the tab's static SPA and the token-exchange and `/api/*` proxy edge hosted on a **Cloudflare Worker** ([`packages/teams-edge`](../../packages/teams-edge)).

## Architecture

```
Microsoft Teams
  │  Teams tab (React SPA)  ──── Cloudflare Worker (edge) ──────────┐
  │    │ 1. Teams SSO → Entra JWT                                   │
  │    │ 2. POST /token/exchange  (same-origin)                     │
  │    │      Entra JWT → Microsoft OBO → Snowflake token,          │
  │    │      sealed into an encrypted edge session                 │
  │    │ 3. POST /api/agent/run   (X-Edge-Session)                  │
  │    │      edge attaches SPCS_PAT + X-User-Access-Token          │
  │    ▼                                                            │
  │  SPCS service (Hono)  ◄─────────────────────────────────────────┘
  │    ├─ POST /api/agent/run      → SSE relay to Cortex :run
  │    ├─ POST /api/token/exchange → PAT pass-through (local-pat)
  │    └─ POST /api/bot/messages   → Teams Bot Framework webhook
  │    ▼
  └─ Snowflake Cortex Agents  (.../agents/{name}:run, streaming SSE)
```

Token exchange lives on the **edge** because it must be reachable *before* any Snowflake token exists — the SPCS public endpoint always requires Snowflake auth. The browser never calls SPCS and never holds the service PAT or the user's Snowflake token: `/token/exchange` returns only an encrypted edge session, and the Worker's `/api/*` proxy decrypts it per request, injects the user's token as `X-User-Access-Token`, and authenticates to the SPCS ingress with `SPCS_PAT`.

`NETWORK_MODE` (`public` default, `hybrid`, `privatelink`) changes the network path, not this flow. `hybrid` keeps the public ingress but points the container at the SPCS-injected internal `SNOWFLAKE_HOST`, gated by a `COMPUTE_POOL` network rule on `CORTEX_TEAMS_OAUTH`. `privatelink` (preview, not yet validated end to end) sends the Worker's SPCS calls through a Workers VPC binding to the `privatelink_ingress_url`, restricts the PAT user to your private-endpoint IDs, and verifies the Bot Connector JWT at the edge. A self-hosted Node edge (`edge.Dockerfile`) is the alternative when a Cloudflare tunnel is not allowed. See [Private connectivity](../../docs/teams/teams-private-connectivity.md).

## Monorepo layout

npm workspaces (`packages/*`):

| Package | Purpose | Key tech |
| --- | --- | --- |
| [`packages/tab`](../../packages/tab) | Teams tab SPA + SSE client, chart/table rendering | React 18, Vite 5, `@microsoft/teams-js`, `vega-embed`, `@tanstack/react-virtual` |
| [`packages/teams-edge`](../../packages/teams-edge) | Cloudflare Worker edge (or self-hosted Node edge in `src/node/`): serves the tab's `dist/`, `/api/*` proxy, `/token/exchange` (OBO), `/token/link` (bot sign-in) | Cloudflare Workers, Wrangler, `jose` |
| [`packages/server`](../../packages/server) | SPCS backend: agent SSE relay, token exchange, Teams bot webhook | Hono, `@hono/node-server`, `botbuilder`, `jose` |
| [`packages/teams-manifest`](../../packages/teams-manifest) | Teams app manifest + icons | — |

Supporting dirs: [`native-app/`](native-app) (Snowflake Native App manifest, setup SQL, SPCS service specs, and the Streamlit setup wizard), [`docs/`](docs), `Dockerfile` / `docker-compose.yml`.

## Auth modes

The server requires `TEAMS_AUTH_MODE` or legacy `AUTH_MODE` at boot (`packages/server/src/config.ts`); an omitted or misspelled value is a startup error, not a silent fall-through to `local-pat`.

- **`local-pat`** — dev/testing without Entra. The tab sends a Snowflake [Personal Access Token](https://docs.snowflake.com/en/user-guide/programmatic-access-tokens) via `X-Snowflake-Pat`; no Teams SSO. The token route probes Snowflake and advertises a short lifetime.
- **`local-oauth`** — full Entra JWT → OBO flow, run locally (tab only).
- **`production`** — the shipped SPCS mode; the tab's Entra JWT is validated then exchanged On-Behalf-Of for a Snowflake-audience token.

Per-user Snowflake identity on the **bot channel** is not implemented. Production/local-oauth bot turns fail closed with a sign-in message pointing at the tab; they do not fall back to the shared PAT. The tab SSO path is the supported per-user path.

## Getting started

Requires Node 20+.

```bash
npm install
cp apps/teams/.env.example apps/teams/.env   # fill in values (see below)
```

### Develop

```bash
npm run dev:server        # Hono server on :3000 (tsx watch)
npm run dev:tab           # Vite dev server for the tab SPA
```

For local tab testing without Teams SSO, create `packages/tab/.env.development.local` (git-ignored) with `VITE_AUTH_MODE=local-pat`, `VITE_SPCS_BASE=` (empty → relative `/api`), and `VITE_SNOWFLAKE_PAT=<dev-pat>`. **Use `.env.development.local`, not `.env.local`** — Vite loads `.env.local` in production builds too, which would bake the PAT into the bundle.

### Build

```bash
npm run build             # builds server (tsc) then tab (tsc && vite build)
```

## Deployment

### Tab → Cloudflare Worker

The tab SPA and the edge routes deploy together as one Worker (config template in `packages/teams-edge/wrangler.jsonc`; `deploy-tab.sh` fills account ids from `.env`). Put the runtime secrets from `apps/teams/.env` first (one `wrangler secret bulk` call; never in the bundle), then build and deploy:

```bash
bash apps/teams/scripts/set-edge-secrets.sh
bash apps/teams/scripts/deploy-tab.sh            # or --privatelink
```

`deploy-tab.sh` builds the tab and runs `wrangler deploy` from `packages/teams-edge`. The Worker name comes from `EDGE_WORKER_NAME`, else legacy `PAGES_PROJECT`, else the first label of a `*.workers.dev` `TAB_BASE_HOST`, else `agents-embed-teams`. `set-pages-secrets.sh` is a deprecation shim for `set-edge-secrets.sh`. Moving an existing `*.pages.dev` install: [Pages to Worker cutover](../../docs/teams/teams-install.md#6-pages-to-worker-cutover).

### Server → Snowflake Native App on SPCS

The backend runs as a container in a Native App. After install, grant the
installer the admin role and ordinary users only the public role:

```sql
GRANT APPLICATION ROLE AGENTS_TEAMS_APP.APP_ADMIN TO ROLE <installer_role>;
GRANT APPLICATION ROLE AGENTS_TEAMS_APP.APP_PUBLIC TO ROLE AGENTS_TEAMS_USER;
```

`APP_ADMIN` is required to set secrets, configure External OAuth, and create/roll
the SPCS service. `CREATE INTEGRATION ON ACCOUNT` is a temporary install-time
grant — revoke it after `CONFIG.CREATE_OAUTH_INTEGRATION()` succeeds.

Use the Streamlit **setup wizard** to provision the app, secrets, external-access integration, and service:

```
native-app/streamlit/setup_wizard.py   # run in Snowsight
```

The wizard stores Bot/OBO credentials and app config as Snowflake secrets (`bot_app_id`, `bot_app_secret`, `obo_client_id`, `obo_client_secret`, `default_agent_fqn`, `teams_app_id`), which SPCS injects as env vars. Service specs live in `native-app/services/` (`service_spec.yml` = production, `service_spec_deploy.yml` = local-pat). The container image is built from the root `Dockerfile` and pushed to the account's Snowflake image registry.

## Environment variables

All are documented in [`.env.example`](.env.example) (no real values). Summary:

| Variable | Modes | Purpose |
| --- | --- | --- |
| `AUTH_MODE` | all | `local-pat` \| `local-oauth` \| `production` |
| `SNOWFLAKE_ACCOUNT` | all | Account URL, `<account>.snowflakecomputing.com` |
| `SNOWFLAKE_PAT` | local-pat | Personal Access Token for the server |
| `AZURE_TENANT_ID` | oauth/prod | Entra tenant ID |
| `BOT_APP_ID` / `BOT_APP_SECRET` | oauth/prod | Teams Bot Framework app credentials |
| `OBO_CLIENT_ID` / `OBO_CLIENT_SECRET` | oauth/prod | Entra app used for the OBO exchange |
| `SNOWFLAKE_SCOPE` | oauth/prod | `api://<snowflake-app-id>/SESSION:ROLE-ANY` |
| `DEFAULT_AGENT_FQN` | all | Target Cortex agent, `DB.SCHEMA.AGENT_NAME` (from a Snowflake secret in prod) |
| `TEAMS_APP_ID` | all | Teams manifest app ID |
| `PORT` | all | Server port (default 3000) |

Tab build-time vars (`packages/tab/.env.production`): `VITE_SPCS_BASE` (empty → same-origin `/api/*` through the edge proxy); `VITE_EDGE_BASE` (empty → same-origin `/token/exchange`).

Cloudflare Worker edge secrets (`set-edge-secrets.sh`): `AZURE_TENANT_ID`, `OBO_CLIENT_ID`, `OBO_CLIENT_SECRET`, `SNOWFLAKE_SCOPE`, `ENTRA_AUDIENCE_URI`, `SPCS_BASE`, `SPCS_PAT`, `EDGE_SESSION_SECRET`, `BOT_LINK_SECRET`, `BOT_APP_ID`. Hosting vars in `apps/teams/.env`: `TAB_BASE_HOST` / `TAB_BASE_URL` (Worker custom domain, recommended, or `<worker>.<subdomain>.workers.dev`; a legacy `*.pages.dev` host keeps working until cutover), `EDGE_WORKER_NAME`, `NETWORK_MODE`.

## Documentation

- Host install guide: [`docs/teams/teams-install.md`](../../docs/teams/teams-install.md)
- Troubleshooting: [`docs/teams/teams-troubleshooting.md` §4](../../docs/teams/teams-troubleshooting.md)
