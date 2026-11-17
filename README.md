# Snowflake Agents Embed

Snowflake Cortex agent chat, embedded in Microsoft Teams. The app is displayed as
**Snowflake Agents for Teams (Unofficial)**.

**Maintainer:** Snowflake Inc. (Snowflake Labs)
**License:** [Apache-2.0](LICENSE)

This is an open-source Snowflake Labs sample. It is **not an officially supported
Snowflake product** and is provided **as-is, with no SLA or warranty**. See [NOTICE](NOTICE).
It calls public [Cortex Agents](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents)
APIs. It is not [Snowflake CoWork](https://docs.snowflake.com/en/user-guide/snowflake-cortex/snowflake-cowork)
(the first-party Snowsight UI) and is not the official Cortex Agents Teams integration.

This repository is Teams-only.

## What it does

A Teams **tab + bot** that lets users chat with a named Cortex Agent and get
streamed answers with thinking steps, inline citations, Vega-Lite charts and
virtualized data tables, authenticated as the signed-in user (Entra SSO, then
On-Behalf-Of exchange for a Snowflake token).

```
Teams tab (React SPA)
  │ 1. Teams SSO → Entra JWT
  │ 2. POST /token/exchange   → encrypted edge session (OBO under the hood)
  │ 3. POST /api/agent/run    → edge attaches SPCS_PAT + user token
  ▼
Edge (Cloudflare Worker, or self-hosted Node)
  ▼
SPCS service (Hono): SSE relay · token exchange · Bot Framework webhook
  ▼
Snowflake Cortex Agents (:run, streaming SSE)
```

The browser never holds the service PAT or the user's Snowflake token. Details:
[`apps/teams/README.md`](apps/teams/README.md) and
[`docs/authentication-patterns.md`](docs/authentication-patterns.md).

## Repo layout

npm workspaces monorepo (`packages/*`, Node 22+, see `.nvmrc`).

```
apps/teams/            Deploy assets: Native App (setup SQL, SPCS specs, Streamlit
                       wizard), Dockerfiles, env templates, scripts/
packages/
├── server/            SPCS backend (Hono): Bot Framework webhook, SSE relay, token exchange
├── tab/               Teams tab SPA (Vite, React); Entra SSO
├── teams-edge/        Edge: tab assets, /api/* proxy, /token/exchange, /token/link.
│                      Cloudflare Worker adapter + self-hosted Node adapter
├── chat-core/         Shared React chat UI (source-only)
├── cortex-server/     Host-neutral Snowflake/Cortex server integration (source-only)
└── teams-manifest/    Teams app manifest generator + icons
docs/                  Install guides and auth patterns
skills/                Claude Code deploy skills (teams-deploy, teams-deploy-edge-node)
snowflake/superstore-360/   Sample Superstore data, semantic view and demo agent SQL
```

## Deploying

Start at [`docs/install-guide.md`](docs/install-guide.md), then
[`docs/install-teams.md`](docs/install-teams.md), which covers:

- standalone SPCS install (default) and Native App install (Appendix B)
- Teams app sideload, verification and common failures (§4)
- teardown (§5), Pages-to-Worker cutover (§6)
- `NETWORK_MODE` `public` / `hybrid` / `privatelink` (§7)

Scripts live in `apps/teams/scripts/` (`validate-env.sh`, `deploy-spcs.sh`,
`set-edge-secrets.sh`, `deploy-tab.sh`, `smoke-test.sh`, and more). They read only
`apps/teams/.env`. A self-hosted Node edge is available via
`apps/teams/edge.Dockerfile` when a Cloudflare tunnel is not allowed.

The `teams-deploy` and `teams-deploy-edge-node` skills under [`skills/`](skills)
wrap these flows for Claude Code. 

## Security notes

Tab SSO is the supported per-user authentication path; bot turns fail with a sign-in prompt rather than falling back to a shared PAT. Mint the service PAT with
`ROLE_RESTRICTION` and keep per-user network policies restricted. See
[`PRIVACY.md`](PRIVACY.md) and [`TERMS.md`](TERMS.md).
