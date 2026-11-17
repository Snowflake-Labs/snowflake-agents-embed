# @snowflake-agents-embed/tab

Teams tab SPA: Entra SSO and the chat UI (via `@snowflake-agents-embed/chat-core`).
The build output (`dist/`) is served as static assets by the edge Worker in
[`packages/teams-edge`](../teams-edge), which also owns `/api/*` and the OBO token
exchange.

Architecture, auth modes, deploy steps, and env vars are documented in the app
README, not duplicated here: [`apps/teams/README.md`](../../apps/teams/README.md).

Local dev note: use `packages/tab/.env.development.local` (git-ignored) for a
dev PAT, never `.env.local` — Vite loads `.env.local` in production builds too,
which would bake a credential into the shipped bundle. See the app README's
"Develop" section for the exact variables.

Tests: `npm run test -w packages/tab` (vitest + `@testing-library/react`).
