#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

# Deploy the tab and the edge (one Cloudflare Worker with static assets) to production.
# Builds packages/tab, then runs wrangler deploy from packages/teams-edge, whose
# wrangler.jsonc serves ../tab/dist and the /api and /token/* edge routes.
#
#   bash apps/teams/scripts/deploy-tab.sh [--public | --privatelink] [--create]
#
# NETWORK_MODE=privatelink (or --privatelink) deploys env.privatelink, which reaches SPCS
# through the SPCS_VPC Workers VPC binding. public and hybrid use the public ingress.
# The Worker name resolves as in set-edge-secrets.sh; run that first. The Worker must already
# exist (set-edge-secrets.sh creates it on a first install); pass --create to deploy a new one.
# Account-specific ids come from apps/teams/.env (BOT_LINKS_KV_ID, and SPCS_VPC_SERVICE_ID for privatelink),
# never from the repo: the script renders packages/teams-edge/wrangler.local.jsonc (gitignored) from the
# wrangler.jsonc template and deploys that. With --create a missing KV namespace is found or created and its
# id is written to .env. EDGE_CUSTOM_DOMAIN (a bare hostname on a zone in this Cloudflare account) adds a
# custom-domain route to the rendered config so every deploy keeps it.

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENV_FILE="${REPO_ROOT}/apps/teams/.env"
die() { echo "✗  $*" >&2; exit 1; }
# shellcheck source=lib/preflight.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/preflight.sh"
env_get() {
  local key="$1" raw
  [[ -f "$ENV_FILE" ]] || return 0
  raw="$({ grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" || true; } | head -1 \
    | sed 's/^[^=]*=[[:space:]]*//' | tr -d '\r' | sed 's/[[:space:]]*$//')"
  raw="${raw#\"}"; raw="${raw%\"}"; raw="${raw#\'}"; raw="${raw%\'}"
  printf '%s' "$raw"
}

MODE_FLAG=""
CREATE_WORKER=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public) MODE_FLAG=public ;;
    --privatelink) MODE_FLAG=privatelink ;;
    --create) CREATE_WORKER=1 ;;
    -h|--help) sed -n '4,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

TEAMS_APP_ID="${TEAMS_APP_ID:-$(env_get TEAMS_APP_ID)}"
: "${TEAMS_APP_ID:?TEAMS_APP_ID is not set — see apps/teams/.env.example}"
# The Worker name and mode come from .env only, as in set-edge-secrets.sh. A shell
# override here could deploy to a Worker that never got the secrets.
TAB_BASE_HOST="$(env_get TAB_BASE_HOST)"
EDGE_WORKER_NAME="$(env_get EDGE_WORKER_NAME)"
EDGE_WORKER_NAME="${EDGE_WORKER_NAME:-$(env_get PAGES_PROJECT)}"
[[ -n "$TAB_BASE_HOST" ]] && reject_pages_dev_host "$TAB_BASE_HOST"
ENV_MODE="$(env_get NETWORK_MODE)"
ENV_MODE="${ENV_MODE:-public}"
NETWORK_MODE="${MODE_FLAG:-$ENV_MODE}"
if [[ "$NETWORK_MODE" != "$ENV_MODE" && ( "$NETWORK_MODE" == privatelink || "$ENV_MODE" == privatelink ) ]]; then
  echo "warning: deploying NETWORK_MODE=${NETWORK_MODE} but apps/teams/.env has ${ENV_MODE};" \
    "SPCS_BASE from set-edge-secrets.sh may point at the wrong ingress" >&2
fi

case "$NETWORK_MODE" in
  public|hybrid) WRANGLER_ENV="" ;;
  privatelink) WRANGLER_ENV="privatelink" ;;
  *) echo "NETWORK_MODE must be public, hybrid or privatelink (got \"${NETWORK_MODE}\")" >&2; exit 1 ;;
esac

# Keep in lockstep with set-edge-secrets.sh so the deploy hits the Worker holding the secrets.
if [[ -z "$EDGE_WORKER_NAME" && -n "$TAB_BASE_HOST" ]]; then
  host="${TAB_BASE_HOST#https://}"
  host="${host#http://}"
  host="${host%%/*}"
  case "$host" in
    *.workers.dev) EDGE_WORKER_NAME="${host%%.*}" ;;
    *.pages.dev)   EDGE_WORKER_NAME="${host%.pages.dev}" ;;
  esac
fi
EDGE_WORKER_NAME="${EDGE_WORKER_NAME:-agents-embed-teams}"
if [[ ! "$EDGE_WORKER_NAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "EDGE_WORKER_NAME \"${EDGE_WORKER_NAME}\" is not a valid Worker name (lowercase letters, digits, hyphens)" >&2
  exit 1
fi

EDGE_DIR="${REPO_ROOT}/packages/teams-edge"
WRANGLER_TEMPLATE="${EDGE_DIR}/wrangler.jsonc"
WRANGLER_CFG="${EDGE_DIR}/wrangler.local.jsonc"
BOT_LINKS_KV_ID="$(env_get BOT_LINKS_KV_ID)"
SPCS_VPC_SERVICE_ID="$(env_get SPCS_VPC_SERVICE_ID)"
if [[ -n "$BOT_LINKS_KV_ID" && ! "$BOT_LINKS_KV_ID" =~ ^[0-9a-f]{32}$ ]]; then
  die "BOT_LINKS_KV_ID in apps/teams/.env must be a 32-character hex Cloudflare KV namespace id"
fi
if [[ "$WRANGLER_ENV" == privatelink ]]; then
  if [[ -z "$SPCS_VPC_SERVICE_ID" ]]; then
    echo "NETWORK_MODE=privatelink needs SPCS_VPC_SERVICE_ID in apps/teams/.env. Create the service with:" >&2
    echo "  (cd packages/teams-edge && npx wrangler vpc service create <name> --type http --tunnel-id <id> --hostname <privatelink ingress host>)" >&2
    echo "then put the returned id in apps/teams/.env as SPCS_VPC_SERVICE_ID." >&2
    exit 1
  fi
  [[ "$SPCS_VPC_SERVICE_ID" =~ ^[A-Za-z0-9_-]+$ ]] || die "SPCS_VPC_SERVICE_ID in apps/teams/.env has unexpected characters"
fi

EDGE_CUSTOM_DOMAIN="$(env_get EDGE_CUSTOM_DOMAIN)"
if [[ -n "$EDGE_CUSTOM_DOMAIN" ]]; then
  [[ "$EDGE_CUSTOM_DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]] \
    || die "EDGE_CUSTOM_DOMAIN in apps/teams/.env must be a bare hostname (no scheme or path)"
  if [[ -n "$TAB_BASE_HOST" && "${TAB_BASE_HOST#https://}" != "$EDGE_CUSTOM_DOMAIN" ]]; then
    echo "warning: EDGE_CUSTOM_DOMAIN (${EDGE_CUSTOM_DOMAIN}) differs from TAB_BASE_HOST (${TAB_BASE_HOST}); the manifest and Entra use TAB_BASE_HOST" >&2
  fi
fi

require_node_modules "$REPO_ROOT"

# Wrangler reads CLOUDFLARE_API_TOKEN from the process env only; a shell value wins over .env.
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  cf_token="$(env_get CLOUDFLARE_API_TOKEN)"
  [[ -z "$cf_token" ]] || export CLOUDFLARE_API_TOKEN="$cf_token"
  unset cf_token
fi

# BOT_LINKS_KV_ID must be a namespace on the logged-in Cloudflare account; a foreign id fails at runtime.
kv_listed=0
if kv_list="$(cd "$EDGE_DIR" && npx wrangler kv namespace list 2>/dev/null)"; then
  kv_listed=1
else
  # A deploy token without Workers KV Storage read cannot list namespaces; the deploy itself does not need it.
  echo "warning: could not list KV namespaces (token lacks Workers KV Storage: Read?); BOT_LINKS_KV_ID not verified" >&2
fi
if [[ -z "$BOT_LINKS_KV_ID" ]]; then
  [[ "$CREATE_WORKER" == 1 ]] || die "BOT_LINKS_KV_ID is not set in apps/teams/.env.
   Re-run with --create to find or create the namespace and record its id,
   or run: (cd packages/teams-edge && npx wrangler kv namespace create BOT_LINKS) and put the id in .env."
  if [[ "$kv_listed" == 1 ]]; then
    BOT_LINKS_KV_ID="$(node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        const m = JSON.parse(s).find(n => /(^|-)BOT_LINKS$/.test(n.title));
        if (m) process.stdout.write(m.id);
      });' <<<"$kv_list" 2>/dev/null || true)"
  fi
  if [[ -n "$BOT_LINKS_KV_ID" ]]; then
    echo "Using existing BOT_LINKS KV namespace ${BOT_LINKS_KV_ID}"
  else
    echo "Creating BOT_LINKS KV namespace on this Cloudflare account"
    kv_out="$(cd "$EDGE_DIR" && npx wrangler kv namespace create BOT_LINKS </dev/null 2>&1)" \
      || die "wrangler kv namespace create failed"
    BOT_LINKS_KV_ID="$(grep -oE '[0-9a-f]{32}' <<<"$kv_out" | head -1)"
    [[ -n "$BOT_LINKS_KV_ID" ]] || die "could not read the new KV namespace id from wrangler output"
  fi
  if grep -qE '^[[:space:]]*BOT_LINKS_KV_ID[[:space:]]*=' "$ENV_FILE"; then
    NEW_ID="$BOT_LINKS_KV_ID" perl -pi -e 's/^(\s*BOT_LINKS_KV_ID\s*=).*/$1$ENV{NEW_ID}/' "$ENV_FILE"
  else
    printf '\nBOT_LINKS_KV_ID=%s\n' "$BOT_LINKS_KV_ID" >> "$ENV_FILE"
  fi
  echo "  recorded BOT_LINKS_KV_ID in apps/teams/.env"
elif [[ "$kv_listed" == 1 ]] && ! grep -q "\"id\": *\"${BOT_LINKS_KV_ID}\"" <<<"$kv_list"; then
  die "BOT_LINKS_KV_ID in apps/teams/.env is not a KV namespace on this Cloudflare account.
   Clear it and re-run with --create, or check 'npx wrangler whoami'."
fi

# Render the deploy config from the committed template. Only ids from .env are substituted.
KV_ID="$BOT_LINKS_KV_ID" VPC_ID="$SPCS_VPC_SERVICE_ID" DOMAIN="$EDGE_CUSTOM_DOMAIN" perl -pe '
  s/REPLACE_WITH_KV_NAMESPACE_ID/$ENV{KV_ID}/g;
  s/REPLACE_WITH_VPC_SERVICE_ID/$ENV{VPC_ID}/g if length $ENV{VPC_ID};
  s/^([ \t]*)("name": "[^"]*",)[ \t]*$/$1$2\n$1"routes": [{ "pattern": "$ENV{DOMAIN}", "custom_domain": true }],/ if length $ENV{DOMAIN};
' "$WRANGLER_TEMPLATE" > "$WRANGLER_CFG"

require_worker "$EDGE_WORKER_NAME" "$EDGE_DIR" "$CREATE_WORKER"

(cd "${REPO_ROOT}/packages/tab" && VITE_TEAMS_APP_ID="$TEAMS_APP_ID" npm run build)

echo "Deploying Worker ${EDGE_WORKER_NAME} (NETWORK_MODE=${NETWORK_MODE})"
cd "$EDGE_DIR"
npx wrangler deploy --config "$WRANGLER_CFG" --env "$WRANGLER_ENV" --name "$EDGE_WORKER_NAME"
