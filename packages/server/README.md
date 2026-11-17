# @snowflake-agents-embed/server

SPCS backend for the Teams app: Hono routes for the agent SSE relay, Entra→OBO
token exchange, and the Bot Framework webhook.

Architecture, auth modes, deploy steps, and env vars are documented in the app
README, not duplicated here: [`apps/teams/README.md`](../../apps/teams/README.md).

Route-level notes worth knowing when working in this package specifically:

- Imports `@snowflake-agents-embed/chat-core` and `@snowflake-agents-embed/cortex-server`
  uncompiled at runtime via `tsx` (see `apps/teams/Dockerfile`) rather than
  building them as dependencies. `cortex-server` is the host-neutral half of this
  backend, shared with `packages/relay` — read
  [its README](../cortex-server/README.md) before adding anything here that a
  second host would also need.
- `cortex-server/http/rate-limit` is an in-memory per-instance limiter, not shared
  across SPCS replicas — see its doc comment before assuming it's a global cap.
- `cortex-server/snowflake/fetch-timeout` wraps every outbound Snowflake/Cortex
  `fetch()` except the agent-run/bot-cortex routes, which set their own longer bound.
- Bot Cortex timeouts are split by call site: the messaging-extension invoke
  (`handleComposeQuery`) aborts at 12 s (under the Teams 15 s turn limit) and
  substitutes the "open the full app" copy; the incremental message path
  (`callAndReply`) keeps 55 s because it posts/updates activities as events arrive.

Tests: `npm run test -w packages/server` (vitest).
