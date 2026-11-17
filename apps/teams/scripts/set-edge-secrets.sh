#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# set-edge-secrets.sh — put the Cloudflare Worker edge's runtime secrets from
# apps/teams/.env onto the Worker that serves TAB_BASE_HOST (one wrangler secret
# bulk call). Does not deploy; run deploy-tab.sh after so isolates pick them up.
#
#   bash apps/teams/scripts/set-edge-secrets.sh [--create]
#
# The Worker must already exist; pass --create on a first install (wrangler would otherwise
# create a Worker silently, e.g. after a typo in EDGE_WORKER_NAME).
#
# Worker name: EDGE_WORKER_NAME, else legacy PAGES_PROJECT, else TAB_BASE_HOST's first
# label (*.workers.dev) or the host minus .pages.dev, else agents-embed-teams.
# NETWORK_MODE (public | hybrid | privatelink, default public): privatelink needs an
# explicit SPCS_BASE, the privatelink_ingress_url from SHOW ENDPOINTS.
#
# SNOWFLAKE_SCOPE is api://<SNOWFLAKE_ENTRA_APP_ID>/session:role-any, or
# .../session:role:<SNOWFLAKE_OAUTH_ROLE> when that is set (preferred: pair with
# any-role mode DISABLE). (never api://<OBO_CLIENT_ID>/SESSION:ROLE-ANY, which a local tenant
# helper may write). ENTRA_AUDIENCE_URI is api://<TAB_BASE_HOST>/<OBO_CLIENT_ID> so the
# edge accepts Teams SSO tokens whose aud is the App ID URI, not the GUID.
# SPCS_BASE is .env SPCS_BASE, or https://<SPCS_INGRESS_HOST> (not in privatelink).
# SPCS_PAT is SNOWFLAKE_PAT. Mint it ROLE_RESTRICTED with DAYS_TO_EXPIRY = 90 and
# rotate on that cadence (rotate-entra-secret.sh for Entra; re-mint the PAT and
# re-run this script for SPCS_PAT). Cloudflare's Worker egress is the published
# CF IP list, so a leaked PAT is usable from any attacker Worker — keep the PAT
# short-lived. For the self-hosted Node edge, pin the egress IP in the network
# policy instead of the whole Cloudflare range.

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "\n${GREEN}▶ $*${NC}"; }
info() { echo -e "  $*"; }
warn() { echo -e "${YELLOW}!  $*${NC}" >&2; }
die()  { echo -e "${RED}✗  $*${NC}" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=lib/preflight.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/preflight.sh"
ENV_FILE="${REPO_ROOT}/apps/teams/.env"
[[ -f "$ENV_FILE" ]] || die "no apps/teams/.env found"

CREATE_WORKER=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --create) CREATE_WORKER=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

envval() {
  local raw
  raw="$({ grep -iE "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" || true; } \
    | head -1 | sed 's/^[^=]*=[[:space:]]*//' | tr -d '\r' | sed 's/[[:space:]]*$//')"
  raw="${raw#\"}"
  raw="${raw%\"}"
  raw="${raw#\'}"
  raw="${raw%\'}"
  printf '%s' "$raw"
}

require() {
  local name="$1" value="$2"
  [[ -n "$value" ]] || die "${name} is not set — see apps/teams/.env.example"
}

AZURE_TENANT_ID="$(envval AZURE_TENANT_ID)"
OBO_CLIENT_ID="$(envval OBO_CLIENT_ID)"
OBO_CLIENT_SECRET="$(envval OBO_CLIENT_SECRET)"
SNOWFLAKE_ENTRA_APP_ID="$(envval SNOWFLAKE_ENTRA_APP_ID)"
TAB_BASE_HOST="$(envval TAB_BASE_HOST)"
SPCS_BASE="$(envval SPCS_BASE)"
SPCS_INGRESS_HOST="$(envval SPCS_INGRESS_HOST)"
SPCS_PAT="$(envval SNOWFLAKE_PAT)"
BOT_APP_ID="$(envval BOT_APP_ID)"

require AZURE_TENANT_ID "$AZURE_TENANT_ID"
require BOT_APP_ID "$BOT_APP_ID"
require OBO_CLIENT_ID "$OBO_CLIENT_ID"
require OBO_CLIENT_SECRET "$OBO_CLIENT_SECRET"
require SNOWFLAKE_ENTRA_APP_ID "$SNOWFLAKE_ENTRA_APP_ID"
require TAB_BASE_HOST "$TAB_BASE_HOST"
require SNOWFLAKE_PAT "$SPCS_PAT"
reject_pages_dev_host "${TAB_BASE_HOST#https://}"

EDGE_SESSION_SECRET="$(envval EDGE_SESSION_SECRET)"
if [[ -z "$EDGE_SESSION_SECRET" ]]; then
  # Generated once and persisted so re-runs do not invalidate live edge sessions.
  EDGE_SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  printf '\nEDGE_SESSION_SECRET=%s\n' "$EDGE_SESSION_SECRET" >> "$ENV_FILE"
  info "generated EDGE_SESSION_SECRET and saved it to apps/teams/.env"
fi

BOT_LINK_SECRET="$(envval BOT_LINK_SECRET)"
if [[ -z "$BOT_LINK_SECRET" ]]; then
  # Generated once and persisted; rotating it invalidates every stored bot sign-in.
  BOT_LINK_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  printf '\nBOT_LINK_SECRET=%s\n' "$BOT_LINK_SECRET" >> "$ENV_FILE"
  info "generated BOT_LINK_SECRET and saved it to apps/teams/.env"
fi

TAB_BASE_HOST="${TAB_BASE_HOST#https://}"
TAB_BASE_HOST="${TAB_BASE_HOST#http://}"
TAB_BASE_HOST="${TAB_BASE_HOST%%/*}"
TAB_BASE_HOST="${TAB_BASE_HOST%/}"

NETWORK_MODE="$(envval NETWORK_MODE)"
NETWORK_MODE="${NETWORK_MODE:-public}"
case "$NETWORK_MODE" in
  public|hybrid|privatelink) ;;
  *) die "NETWORK_MODE must be public, hybrid or privatelink (got \"${NETWORK_MODE}\")" ;;
esac

# Keep in lockstep with deploy-tab.sh so secrets land on the Worker it deploys.
EDGE_WORKER_NAME="$(envval EDGE_WORKER_NAME)"
EDGE_WORKER_NAME="${EDGE_WORKER_NAME:-$(envval PAGES_PROJECT)}"
if [[ -z "$EDGE_WORKER_NAME" ]]; then
  case "$TAB_BASE_HOST" in
    *.workers.dev) EDGE_WORKER_NAME="${TAB_BASE_HOST%%.*}" ;;
    *.pages.dev)   EDGE_WORKER_NAME="${TAB_BASE_HOST%.pages.dev}" ;;
  esac
fi
EDGE_WORKER_NAME="${EDGE_WORKER_NAME:-agents-embed-teams}"
[[ "$EDGE_WORKER_NAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] \
  || die "EDGE_WORKER_NAME \"${EDGE_WORKER_NAME}\" is not a valid Worker name (lowercase letters, digits, hyphens)"

SNOWFLAKE_OAUTH_ROLE="$(envval SNOWFLAKE_OAUTH_ROLE)"
if [[ -n "$SNOWFLAKE_OAUTH_ROLE" ]]; then
  [[ "$SNOWFLAKE_OAUTH_ROLE" =~ ^[A-Za-z_][A-Za-z0-9_$]*$ ]] \
    || die "SNOWFLAKE_OAUTH_ROLE must be an unquoted Snowflake identifier"
  SNOWFLAKE_SCOPE="api://${SNOWFLAKE_ENTRA_APP_ID}/session:role:${SNOWFLAKE_OAUTH_ROLE}"
else
  SNOWFLAKE_SCOPE="api://${SNOWFLAKE_ENTRA_APP_ID}/session:role-any"
fi
ENTRA_AUDIENCE_URI="$(envval ENTRA_AUDIENCE_URI)"
ENTRA_AUDIENCE_URI="${ENTRA_AUDIENCE_URI:-api://${TAB_BASE_HOST}/${OBO_CLIENT_ID}}"

if [[ -z "$SPCS_BASE" ]]; then
  # The public ingress host is the wrong upstream in privatelink, so never fall back to it.
  [[ "$NETWORK_MODE" != privatelink ]] \
    || die "NETWORK_MODE=privatelink needs SPCS_BASE=https://<privatelink_ingress_url> (SHOW ENDPOINTS)"
  require SPCS_INGRESS_HOST "$SPCS_INGRESS_HOST"
  SPCS_INGRESS_HOST="${SPCS_INGRESS_HOST#https://}"
  SPCS_INGRESS_HOST="${SPCS_INGRESS_HOST#http://}"
  SPCS_INGRESS_HOST="${SPCS_INGRESS_HOST%/}"
  SPCS_BASE="https://${SPCS_INGRESS_HOST}"
fi
SPCS_BASE="${SPCS_BASE%/}"
if [[ "$NETWORK_MODE" == privatelink && "$SPCS_BASE" != *privatelink* ]]; then
  warn "NETWORK_MODE=privatelink but SPCS_BASE does not look like a privatelink_ingress_url: ${SPCS_BASE}"
fi

command -v npx >/dev/null || die "npx not found on PATH"
command -v node >/dev/null || die "node not found on PATH"
require_worker "$EDGE_WORKER_NAME" "${REPO_ROOT}/packages/teams-edge" "$CREATE_WORKER"

SECRET_NAMES=(AZURE_TENANT_ID OBO_CLIENT_ID OBO_CLIENT_SECRET SNOWFLAKE_SCOPE ENTRA_AUDIENCE_URI
  SPCS_BASE SPCS_PAT EDGE_SESSION_SECRET BOT_LINK_SECRET BOT_APP_ID)

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  cf_token="$(envval CLOUDFLARE_API_TOKEN)"
  [[ -z "$cf_token" ]] || export CLOUDFLARE_API_TOKEN="$cf_token"
  unset cf_token
fi

step "Putting ${#SECRET_NAMES[@]} edge secrets on Worker ${EDGE_WORKER_NAME} (NETWORK_MODE=${NETWORK_MODE})"
cd "${REPO_ROOT}/packages/teams-edge"
# Values reach wrangler on stdin as JSON, never in argv or a temp file. --env "" is the
# top-level env: with --name, an env name would make wrangler target <name>-<env> instead.
# SPCS_UPSTREAM is a wrangler.jsonc var in env.privatelink, not a secret; the two would clash.
(
  export SECRET_NAMES_CSV="$(IFS=,; echo "${SECRET_NAMES[*]}")"
  export "${SECRET_NAMES[@]}"
  node -e '
    const out = {}
    for (const k of process.env.SECRET_NAMES_CSV.split(",")) out[k] = process.env[k]
    process.stdout.write(JSON.stringify(out))
  ' | npx wrangler secret bulk --name "$EDGE_WORKER_NAME" --env ""
)

step "Done — secret bulk alone leaves warm isolates."
info "SNOWFLAKE_SCOPE=${SNOWFLAKE_SCOPE/${SNOWFLAKE_ENTRA_APP_ID}/<SNOWFLAKE_ENTRA_APP_ID>}"
info "ENTRA_AUDIENCE_URI=api://<TAB_BASE_HOST>/<OBO_CLIENT_ID>"
info "SPCS_BASE=${SPCS_BASE}"
info "Next: bash apps/teams/scripts/deploy-tab.sh"
