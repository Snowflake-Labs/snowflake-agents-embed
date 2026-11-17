---
name: teams-deploy-edge-node
version: "1.0"
description: >
  Builds, runs and verifies the self-hosted Node edge for Snowflake Agents for Teams
  (apps/teams/edge.Dockerfile), the alternative to the Cloudflare Worker when a network
  cannot run a tunnel to Cloudflare. Use when the user asks to self-host the edge, run the
  edge in their VPC, or debug the Node edge failing to start or its SQLite lock.
user-invocable: true
allowed-tools:
  - read
  - bash
  - grep
  - glob
---

# Deploy the self-hosted Node edge

Canonical runbook: [docs/install-teams.md § 7.6a](../../docs/install-teams.md#76a-edge-in-privatelink-self-hosted-node-edge). Do not invent a second one. Failures: [PL7](../../docs/install-teams.md#pl7-the-node-edge-will-not-start-or-the-link-store-is-locked).

The Worker + cloudflared privatelink path was validated on AWS on 2026-10-09, but the **self-hosted Node edge itself has not been run against a real PrivateLink account**. Say so before running this for a user.

## Rules

- The env file holds `SPCS_PAT`, `EDGE_SESSION_SECRET` and `BOT_LINK_SECRET`. Keep it `0600`, never print or commit it, never run against the real `apps/teams/.env` without the user's say.
- One replica per `/data` volume. The SQLite store holds an exclusive lock, and a second replica must fail rather than share it.
- Never run as root, never loosen the `0700` dir and `0600` file checks, and never delete the `-wal` or `-shm` files.
- Confirm before `docker run`, `docker stop` or removing the volume. Do not prune Docker images or cache without asking.
- Do not weaken credential custody: the browser holds only the encrypted edge session, and the PAT user keeps `ROLE_RESTRICTION` and its restricted network policy.

## Steps

1. Build from the repo root: `docker build -f apps/teams/edge.Dockerfile -t agents-teams-edge .`
2. Write the env file (`PUBLIC_ORIGIN`, `SPCS_BASE`, `SPCS_PAT`, `EDGE_SESSION_SECRET`, `BOT_APP_ID`, `BOT_LINK_SECRET`, plus the Entra/OBO values and `TRUSTED_PROXY_HOPS`). Reuse existing secret values when migrating from the Worker so sessions and bot links survive.
3. Run hardened, on an encrypted volume:
   `docker run -d --name teams-edge --restart unless-stopped --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp -v teams-edge-data:/data --env-file edge.env -p 8080:8080 agents-teams-edge`
4. Put a TLS-terminating proxy in front, point `TAB_BASE_HOST` at it, and follow the host cutover in [§ 6](../../docs/install-teams.md#6-pages-to-worker-cutover), skipping the Cloudflare steps.
5. Verify: `/healthz` returns `ok`, `/config` returns the tab shell, the edge probe returns 401, a tab chat streams, and `stat -c '%a' /data /data/bot-links.sqlite` prints `700` and `600`.

## Failures

| Symptom | Likely cause |
|---|---|
| `locked by another process` | A second replica or stale container holds the lock |
| `Data directory … has mode` or `owned by uid` | Volume created with loose mode or by another user: `chown node:node`, `chmod 700` / `600` |
| `Refusing to run … as root` | `--user 0` was set |
| `Missing required environment` | A required variable is unset (step 2) |
