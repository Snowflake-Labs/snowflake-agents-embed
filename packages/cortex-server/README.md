# @snowflake-agents-embed/cortex-server

Host-neutral server-side Snowflake/Cortex integration. `packages/chat-core` is the client-side
counterpart; this is the server-side one. It is consumed by `packages/server` (the Microsoft Teams
tab + bot backend, deployed from `apps/teams`).

## Why this package exists

It keeps everything that talks to Snowflake or Cortex (REST wrappers with timeouts, agent-run and
agent-listing routes, credential resolution, MCP OAuth, rate limiting, security headers) apart from
the host-specific Hono app. A new host backend can reuse it instead of copying files.

The acceptance test: **if you are writing a new host backend and find yourself copying a file out
of `packages/server`, that file belongs in this package.**

## No build step

This package has no `build` script and emits no `dist`. Its `exports` map points directly at
TypeScript source:

```json
"exports": { "./snowflake/*": "./src/snowflake/*.ts", ... }
```

Consumers import it uncompiled, exactly as they do `chat-core`:

```ts
import { fetchWithTimeout } from '@snowflake-agents-embed/cortex-server/snowflake/fetch-timeout'
```

This is why the containers run `node_modules/.bin/tsx` rather than plain `node`, and why both
`apps/teams/Dockerfile` (server) and `apps/teams/edge.Dockerfile` (edge) `COPY` this package's
`src/` **and** its `package.json` (Node reads the exports map from the manifest) into the runner
stage. A missing `COPY` typechecks clean and only fails when the container starts.

Running a transpiler on the serving path is a real wart. It is a pre-existing decision inherited
from `chat-core`, not one this package introduces.

## Layout

| Path | Contents |
|---|---|
| `src/snowflake/` | Talking to Snowflake: `fetch-timeout.ts` (AbortController wrappers for REST and streaming calls), `agent-ref.ts` (FQN parse/validate, agent-run URL), `credential.ts`, `session.ts`, `list-agents.ts`, `agent-details.ts`, `feedback.ts`, `mcp-oauth.ts`, `mcp-authorizations.ts`, `connectors-url.ts`, `path-id.ts` |
| `src/http/` | Hono-layer pieces: route factories (`agent-run`, `agents`, `config`, `feedback`, `mcp-oauth`, `statements`, `telemetry`, `threads`, `title`, `index`), `attachments.ts`, and middleware helpers (`rate-limit.ts`, `sliding-window.ts`, `security-headers.ts`, `log-safe-error.ts`, `upstream-error.ts`, `deps.ts`) |
| `src/host/` | Adapter seams a host implements: `credentialResolver.ts`, `hostBackendAdapter.ts` |
| `src/auth/` | `entra-token.ts` (Entra token validation) |
| `src/config/` | `load-env.ts` (`apps/teams/.env` for local dev; a no-op in SPCS, where env vars are injected), `runtime.ts` |
| `src/test/` | Shared test fixtures (`identities.ts`) |

## What does NOT belong here

Host-specific code stays in its host package:

- **Auth strategy.** The Entra → On-Behalf-Of → Snowflake exchange lives in `packages/server`.
  A shared auth-mode enum would mean every new host edits a type in this package, so shared code
  takes an already-resolved credential instead.
- **`server/src/bot/`, `lib/bot-state.ts`, `lib/share-snapshot.ts`**: Bot Framework and Adaptive
  Cards. They stay in `server` until a second bot host provides a real example to extract from.
- **CORS allow-lists, CSP, static file serving, `serveStatic`**: each host composes its own
  `index.ts`.

## Timeout ladder

Documented so a later change cannot invert a hop without noticing:

| Hop | Bound | Where |
|---|---|---|
| SQL-API statement | 30 s | request body `timeout` |
| SQL-API HTTP abort | 40 s | `fetchWithTimeout` (10 s margin above the statement) |
| Agent-run time-to-first-byte | 55 s | `fetchWithTimeoutStreaming` |
| Agent-run total stream | 300 s | same helper; timer cleared only when the body ends |
| SSE keepalive ping | 15 s of silence | `wrapUpstreamSse` (`:ping` comment) |
| Browser stall watchdog | 45 s without bytes | `parseSseStream({ stallTimeoutMs })` in chat-core |

## Tests

`src/**/*.test.ts`, run with `npm run test -w packages/cortex-server`.
