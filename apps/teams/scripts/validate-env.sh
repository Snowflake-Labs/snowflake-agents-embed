#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# validate-env.sh — check apps/teams/.env and local tooling before a deploy. Read-only.
#
#   bash apps/teams/scripts/validate-env.sh [--live] [-c <snow connection>]
#
# --live also asks Snowflake (SHOW ENDPOINTS) whether SPCS_INGRESS_HOST is the service's real
# ingress host. Exits 1 if any check fails; warnings do not fail. Values are never printed.

set -uo pipefail

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
ERRORS=0; WARNINGS=0
ok()   { echo -e "  ${GREEN}ok${NC}    $*"; }
warn() { echo -e "  ${YELLOW}warn${NC}  $*"; WARNINGS=$((WARNINGS+1)); }
fail() { echo -e "  ${RED}FAIL${NC}  $*"; ERRORS=$((ERRORS+1)); }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="${REPO_ROOT}/apps/teams/.env"
# shellcheck source=lib/env.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"

LIVE=0; CONN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    -c|--connection) CONN="${2:?-c needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

GUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
host_ok() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$1" == *.* ]]; }

echo "Tooling"
for t in node npx snow python3; do
  command -v "$t" >/dev/null && ok "$t" || fail "$t not found on PATH"
done
command -v docker >/dev/null && ok docker || warn "docker not found (needed by deploy-spcs.sh)"
command -v az >/dev/null && ok az || warn "az not found (needed by create-bot.sh, set-bot-endpoint.sh and rotate-entra-secret.sh)"
[[ -x "${REPO_ROOT}/node_modules/.bin/tsc" ]] && ok "node_modules installed" || fail "node_modules missing: run npm install"

echo "Env file"
if [[ ! -f "$ENV_FILE" ]]; then
  fail "apps/teams/.env not found (copy apps/teams/.env.example)"
  echo; echo "$ERRORS error(s), $WARNINGS warning(s)"; exit 1
fi
perm="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 600)"
[[ "$perm" == 600 || "$perm" == 400 ]] && ok "apps/teams/.env permissions $perm" || warn "apps/teams/.env is mode $perm; run chmod 600"
# Any other env file in the repo (tab local, root, test) should also be owner-only.
while IFS= read -r -d '' f; do
  [[ "$f" == "$ENV_FILE" ]] && continue
  p="$(stat -f '%Lp' "$f" 2>/dev/null || stat -c '%a' "$f" 2>/dev/null || echo 600)"
  rel="${f#"$REPO_ROOT"/}"
  [[ "$p" == 600 || "$p" == 400 ]] && ok "$rel permissions $p" || warn "$rel is mode $p; run chmod 600"
done < <(find "$REPO_ROOT" \( -name '.env' -o -name '.env.*' \) ! -name '*.example' \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -print0 2>/dev/null)

for k in AZURE_TENANT_ID BOT_APP_ID BOT_APP_SECRET OBO_CLIENT_ID OBO_CLIENT_SECRET SNOWFLAKE_ENTRA_APP_ID \
         SNOWFLAKE_PAT DEFAULT_AGENT_FQN APPS_API_HOST TAB_BASE_HOST; do
  [[ -n "$(envval "$k")" ]] && ok "$k set" || fail "$k is empty"
done
[[ -n "$(envval TEAMS_APP_ID)" ]] && ok "TEAMS_APP_ID set" || warn "TEAMS_APP_ID is empty (needed for fill-dev-secrets.sh and the manifest)"
for k in AZURE_TENANT_ID BOT_APP_ID OBO_CLIENT_ID SNOWFLAKE_ENTRA_APP_ID; do
  v="$(envval "$k")"
  [[ -z "$v" || "$v" =~ $GUID_RE ]] || fail "$k is not a GUID"
done

echo "Hosts"
TAB_HOST="$(envval TAB_BASE_HOST)"; TAB_URL="$(envval TAB_BASE_URL)"
if [[ -n "$TAB_HOST" ]]; then
  if [[ "$TAB_HOST" == *://* || "$TAB_HOST" == */* ]]; then fail "TAB_BASE_HOST must be a bare host (no scheme or path)"
  elif ! host_ok "$TAB_HOST"; then fail "TAB_BASE_HOST is not a valid hostname"
  elif [[ "$TAB_HOST" == *.pages.dev ]]; then fail "TAB_BASE_HOST is a pages.dev host; the edge deploys as a Worker (workers.dev or custom domain)"
  else ok "TAB_BASE_HOST format"; fi
fi
if [[ -n "$TAB_URL" && -n "$TAB_HOST" && "$TAB_URL" != "https://${TAB_HOST}" ]]; then
  fail "TAB_BASE_URL does not equal https://TAB_BASE_HOST"
fi
INGRESS="$(envval SPCS_INGRESS_HOST)"; SPCS_BASE="$(envval SPCS_BASE)"; MODE="$(envval NETWORK_MODE)"; MODE="${MODE:-public}"
case "$MODE" in
  public|hybrid) [[ -n "$INGRESS" || -n "$SPCS_BASE" ]] && ok "SPCS upstream set" || fail "set SPCS_INGRESS_HOST or SPCS_BASE" ;;
  privatelink)
    [[ "$SPCS_BASE" == https://*privatelink* ]] && ok "SPCS_BASE looks like a privatelink ingress URL" \
      || fail "NETWORK_MODE=privatelink needs SPCS_BASE=https://<privatelink_ingress_url>" ;;
  *) fail "NETWORK_MODE must be public, hybrid or privatelink" ;;
esac
if [[ -n "$INGRESS" && ( "$INGRESS" == *://* || "$INGRESS" == */* ) ]]; then fail "SPCS_INGRESS_HOST must be a bare host"; fi
if (( LIVE )) && [[ -n "$INGRESS" ]]; then
  SNOW=(snow); [[ -n "$CONN" ]] && SNOW=(snow -c "$CONN")
  LIVE_HOSTS="$("${SNOW[@]}" sql --silent --format json -q "SHOW ENDPOINTS IN SERVICE AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS" 2>/dev/null \
    | python3 -c "import sys,json;print(' '.join(r.get('ingress_url') or '' for r in json.load(sys.stdin)))" 2>/dev/null || true)"
  if [[ -z "$LIVE_HOSTS" ]]; then warn "could not read SHOW ENDPOINTS (service missing or snow not logged in)"
  elif [[ " $LIVE_HOSTS " == *" ${INGRESS} "* ]]; then ok "SPCS_INGRESS_HOST matches the live endpoint"
  else fail "SPCS_INGRESS_HOST does not match the live ingress host (re-run SHOW ENDPOINTS IN SERVICE)"; fi
fi

echo "OAuth scope"
SCOPE="$(envval SNOWFLAKE_SCOPE)"
if [[ -n "$SCOPE" ]]; then
  if [[ ! "$SCOPE" =~ ^api://[0-9a-fA-F-]{36}/session:role(-any|:[A-Za-z_][A-Za-z0-9_$]*)$ ]]; then
    fail "SNOWFLAKE_SCOPE must be api://<SNOWFLAKE_ENTRA_APP_ID>/session:role-any or .../session:role:<ROLE> (lowercase)"
  elif [[ "$SCOPE" != "api://$(envval SNOWFLAKE_ENTRA_APP_ID)/"* ]]; then
    fail "SNOWFLAKE_SCOPE app id differs from SNOWFLAKE_ENTRA_APP_ID (it must be the Snowflake resource app id, not the OBO app id; fix it)"
  else ok "SNOWFLAKE_SCOPE shape"; fi
else
  ok "SNOWFLAKE_SCOPE unset (derived from SNOWFLAKE_ENTRA_APP_ID)"
fi

echo "Secrets"
ES="$(envval EDGE_SESSION_SECRET)"; BL="$(envval BOT_LINK_SECRET)"
for pair in "EDGE_SESSION_SECRET:$ES" "BOT_LINK_SECRET:$BL"; do
  n="${pair%%:*}"; v="${pair#*:}"
  if [[ -z "$v" ]]; then warn "$n unset (set-edge-secrets.sh generates it)"
  elif (( ${#v} < 32 )); then fail "$n is shorter than 32 characters"
  else ok "$n length"; fi
done
[[ -n "$ES" && "$ES" == "$BL" ]] && fail "EDGE_SESSION_SECRET and BOT_LINK_SECRET must differ"

echo "Legacy keys"
LEGACY="$({ grep -ioE '^[[:space:]]*(SALESFORCE|TABLEAU|SIGMA|POWERBI|PBI)_[A-Z0-9_]*' "$ENV_FILE" || true; } | tr -d ' \t' | sort -u | tr '\n' ' ')"
[[ -z "$LEGACY" ]] && ok "none" || warn "non-Teams keys present (unused on main): ${LEGACY}"

echo; echo "$ERRORS error(s), $WARNINGS warning(s)"
exit $(( ERRORS > 0 ))
