# Privacy — Snowflake Agents Embed (Teams)

This is an open-source Snowflake Labs sample. It is **not an officially supported
Snowflake product** and is provided as-is. See [TERMS.md](TERMS.md) and [LICENSE](LICENSE).

This page describes what the Teams tab and bot handle on the device, at the
edge, and in Snowflake. Your organization's Snowflake, Microsoft Entra, and
Teams policies still apply.

## What the browser holds

In production the tab stores an opaque **edge session** (an encrypted JWE) in
memory only. It is sent as `X-Edge-Session` on `/api/*` calls. The browser
does **not** hold the service programmatic access token (PAT) or the user's
Snowflake OAuth token. Chat transcripts are not written to `localStorage`;
session storage keeps only UI preferences and the last-selected agent FQN.

`local-pat` development is the exception: the tab may send a developer PAT to
a loopback server. That mode is refused in production unless
`ALLOW_INSECURE_AUTH_MODE=1`.

## What the edge holds

The edge (Cloudflare Worker or self-hosted Node) decrypts the session and
attaches `SPCS_PAT` plus the user's Snowflake token when proxying to SPCS.
Bot-link records (Entra refresh token and a cached Snowflake access token)
are sealed with `BOT_LINK_SECRET` and stored in Workers KV or a local SQLite
file (`0700`/`0600`). Rotating `EDGE_SESSION_SECRET` invalidates every tab
session. Rotating `BOT_LINK_SECRET` signs every bot user out.

## Identity

External OAuth maps the Entra `upn` claim only to Snowflake `login_name`.
The service PAT must be minted with `ROLE_RESTRICTION`. Anyone who can
present that PAT to the SPCS ingress can also present a user token; treat
the PAT as equivalent to that capability.

## What we do not collect

This sample does not send product analytics to Snowflake Inc. Optional
`POST /api/telemetry` logs capped operational fields (timing, error class)
in the container that you operate, and requires the same user credential as
other `/api/*` routes.
