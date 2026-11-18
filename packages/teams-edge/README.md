# @snowflake-agents-embed/teams-edge

The Teams edge: one Cloudflare Worker that serves the tab's `dist/` as static assets
and owns the server-side routes the browser and Bot Connector call.

| Route | Handler |
|---|---|
| `/api/*` | `src/core/api-proxy.ts`: checks `Origin` and `X-Edge-Session`, attaches `SPCS_PAT`, forwards to `SPCS_BASE` |
| `POST /token/exchange` | `src/core/exchange.ts`: Entra SSO token, OBO to Snowflake, mints the edge session |
| `POST /token/link` | `src/core/link.ts`: completes bot sign-in, storing the encrypted OBO refresh token in `BOT_LINKS` KV |
| anything else | static assets (SPA fallback) |

`src/core/` is source-only and host-neutral: it uses standard Fetch types and an injected
`EdgeRuntime` (`src/core/runtime.ts`). `src/workers/index.ts` is the Cloudflare adapter and `src/node/` is the self-hosted Node adapter.

## Network modes

`wrangler.jsonc` is a template with two envs; account-specific ids (`BOT_LINKS_KV_ID`, `SPCS_VPC_SERVICE_ID`) come from `apps/teams/.env`, and `deploy-tab.sh` renders the gitignored `wrangler.local.jsonc` it deploys:

- top level (`--env ""`), for `NETWORK_MODE=public` and `hybrid`: global `fetch` to the public
  SPCS ingress.
- `env.privatelink`: `SPCS_UPSTREAM=vpc` sends SPCS calls through the `SPCS_VPC` Workers VPC
  binding (cloudflared in the customer VPC) to the `privatelink_ingress_url`. Entra, JWKS and
  OBO calls still use the global `fetch`. The Bot Connector JWT is verified at the edge. A
  missing binding fails closed with a 500.

## Self-hosted Node edge

`src/node/` runs the same core as a container for networks that cannot run a tunnel to
Cloudflare. Image: `apps/teams/edge.Dockerfile`. Start locally with `npm start -w packages/teams-edge`.

- `config.ts`: `loadNodeConfig` requires `PUBLIC_ORIGIN`, `SPCS_BASE`, `SPCS_PAT`,
  `EDGE_SESSION_SECRET`, `BOT_APP_ID`, `BOT_LINK_SECRET`. The Bot Connector JWT is always verified.
- `app.ts`: rebuilds each request URL from `PUBLIC_ORIGIN` (Host is never trusted), takes the
  client IP from `TRUSTED_PROXY_HOPS`, serves `/healthz`, confined static files and the SPA fallback.
- `sqlite-kv.ts`: bot-link store (`node:sqlite`, Node 22.13+). Refuses root, requires dir `0700`
  and file `0600` owned by the running user, and holds an exclusive lock, so run one replica per volume.

Run and verify: [teams/private-connectivity.md § 7.6a](../../docs/teams/private-connectivity.md#76a-edge-in-privatelink-self-hosted-node-edge).

## Deploy

From the repo root, with `apps/teams/.env` filled in:

```
bash apps/teams/scripts/set-edge-secrets.sh
bash apps/teams/scripts/deploy-tab.sh            # or --privatelink
```

Bundle check without credentials: `npx wrangler deploy --dry-run --env ""` (or `--env privatelink`)
after `npm run build -w packages/tab`.

Tests: `npm run test -w packages/teams-edge`. Typecheck runs `tsconfig.json` (core),
`tsconfig.node.json` (core and `src/node`) and `tsconfig.workers.json` (workers-types).
