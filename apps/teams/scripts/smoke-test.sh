#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# smoke-test.sh — read-only post-deploy checks for the Teams edge, SPCS service and manifest.
#
#   bash apps/teams/scripts/smoke-test.sh [-c <snow connection>]
#
# Checks that the hostname agrees everywhere it is stored (.env, live service CORS, Entra
# identifier URI, built manifest), that the edge answers the expected status codes, and that the
# service is READY. Anything that cannot be checked is reported SKIP, never ok. Exits 1 on FAIL.

set -uo pipefail

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
FAILS=0
ok()   { echo -e "  ${GREEN}ok${NC}    $*"; }
skip() { echo -e "  ${YELLOW}SKIP${NC}  $*"; }
fail() { echo -e "  ${RED}FAIL${NC}  $*"; FAILS=$((FAILS+1)); }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="${REPO_ROOT}/apps/teams/.env"
SERVICE="${SERVICE:-AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS}"
[[ -f "$ENV_FILE" ]] || { echo "no apps/teams/.env found" >&2; exit 1; }
# shellcheck source=lib/env.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"

CONN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--connection) CONN="${2:?-c needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

HOST="$(envval TAB_BASE_HOST)"; HOST="${HOST#https://}"; HOST="${HOST%%/*}"
[[ -n "$HOST" ]] || { echo "TAB_BASE_HOST is not set in apps/teams/.env" >&2; exit 1; }
OBO_CLIENT_ID="$(envval OBO_CLIENT_ID)"
SNOW=(snow); [[ -n "$CONN" ]] && SNOW=(snow -c "$CONN")
echo "Host under test: ${HOST}"

echo "Edge"
status() { curl -s -o /dev/null -m 15 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }
code="$(status -X POST "https://${HOST}/token/exchange" -H "Origin: https://${HOST}" -H 'Content-Type: application/json' -d '{}')"
[[ "$code" == 400 ]] && ok "POST /token/exchange with empty body -> 400" || fail "POST /token/exchange expected 400, got ${code}"
code="$(status -X POST "https://${HOST}/api/generate-title" -H "Origin: https://${HOST}" -H 'Content-Type: application/json' -d '{"firstMessage":"x"}')"
[[ "$code" == 401 ]] && ok "POST /api/generate-title without a session -> 401" || fail "POST /api/generate-title expected 401, got ${code}"
code="$(status "https://${HOST}/")"
[[ "$code" == 200 ]] && ok "GET / serves the tab -> 200" || fail "GET / expected 200, got ${code}"

echo "Service"
if command -v snow >/dev/null; then
  ST="$("${SNOW[@]}" sql --silent --format json -q "SELECT SYSTEM\$GET_SERVICE_STATUS('$SERVICE')" 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.loads(list(d[0].values())[0])[0]['status'])" 2>/dev/null || true)"
  [[ "$ST" == READY ]] && ok "service status READY" || fail "service status is '${ST:-unreadable}', expected READY"
  SPEC="$("${SNOW[@]}" sql --silent --format json -q "DESCRIBE SERVICE $SERVICE" 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['spec'])" 2>/dev/null || true)"
  if [[ -z "$SPEC" ]]; then skip "could not read the live service spec"
  elif grep -q "https://${HOST}\"" <<<"$SPEC"; then ok "live spec CORS origin is https://${HOST}"
  else fail "live spec Access-Control-Allow-Origin does not contain https://${HOST} (run deploy-spcs.sh)"; fi
  PAT_USER="$(envval SNOWFLAKE_USER)"
  if [[ "$PAT_USER" =~ ^[A-Za-z_][A-Za-z0-9_$]*$ ]]; then
    POL="$("${SNOW[@]}" sql --silent --format json -q "SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN USER ${PAT_USER}" 2>/dev/null \
      | python3 -c "import sys,json;d=json.load(sys.stdin)[0];print(d['level']+' '+d['value'])" 2>/dev/null || true)"
    case "$POL" in
      USER\ ?*) ok "PAT user ${PAT_USER} has its own network policy (${POL#USER })" ;;
      "") skip "could not read the network policy of ${PAT_USER} (privileges?)" ;;
      *) skip "PAT user ${PAT_USER} has no user-level policy; if calls fail with 390422 'IP/Token ... not allowed', run set-svc-network-policy.sh" ;;
    esac
  else
    skip "SNOWFLAKE_USER not set: PAT user network policy not checked"
  fi
else
  skip "snow not installed: service status and CORS not checked"
fi

echo "Entra"
if command -v az >/dev/null && [[ -n "$OBO_CLIENT_ID" ]]; then
  URIS="$(az ad app show --id "$OBO_CLIENT_ID" --query 'identifierUris' -o tsv 2>/dev/null || true)"
  if [[ -z "$URIS" ]]; then skip "az not logged in or app not readable"
  elif grep -qx "api://${HOST}/${OBO_CLIENT_ID}" <<<"$URIS"; then ok "identifier URI api://${HOST}/${OBO_CLIENT_ID}"
  else fail "Entra identifier URIs do not include api://${HOST}/${OBO_CLIENT_ID}"; fi
else
  skip "az not available: identifier URI not checked"
fi

echo "Bot"
BOT_APP_ID="$(envval BOT_APP_ID)"
if command -v az >/dev/null && [[ -n "$BOT_APP_ID" ]]; then
  BOT_ROWS="$(az resource list --resource-type Microsoft.BotService/botServices --query "[].[resourceGroup,name]" -o tsv 2>/dev/null || true)"
  BOT_FOUND=""
  while IFS=$'\t' read -r b_rg b_name; do
    [[ -n "$b_name" ]] || continue
    b_info="$(az bot show -g "$b_rg" -n "$b_name" --query "[properties.msaAppId,properties.endpoint]" -o tsv 2>/dev/null || true)"
    if [[ "$(head -1 <<<"$b_info" | tr 'A-Z' 'a-z')" == "$(tr 'A-Z' 'a-z' <<<"$BOT_APP_ID")" ]]; then
      BOT_FOUND="$b_name"; BOT_EP="$(sed -n 2p <<<"$b_info")"; break
    fi
  done <<<"$BOT_ROWS"
  if [[ -z "$BOT_ROWS" ]]; then skip "az not logged in or no bots visible: bot not checked"
  elif [[ -z "$BOT_FOUND" ]]; then fail "no Azure Bot uses BOT_APP_ID (run apps/teams/scripts/create-bot.sh; without it adding the app to a channel fails with BulkMembershipRequest)"
  elif [[ "$BOT_EP" == "https://${HOST}/api/bot/messages" ]]; then ok "bot ${BOT_FOUND} endpoint matches the edge host"
  else fail "bot ${BOT_FOUND} endpoint is ${BOT_EP:-empty}, expected https://${HOST}/api/bot/messages (run set-bot-endpoint.sh)"; fi
else
  skip "az not available: bot not checked"
fi

echo "Manifest"
ZIP="${REPO_ROOT}/packages/teams-manifest/agents-teams-app.zip"
if [[ ! -f "$ZIP" ]]; then
  fail "no packages/teams-manifest/agents-teams-app.zip (run packages/teams-manifest/zip.sh)"
else
  M="$(unzip -p "$ZIP" manifest.json 2>/dev/null || true)"
  if grep -q "\"${HOST}\"\|api://${HOST}/" <<<"$M"; then ok "manifest references ${HOST}"
  else fail "manifest in ${ZIP#"$REPO_ROOT/"} does not reference ${HOST} (rebuild and bump the version)"; fi
  echo "  zip: ${ZIP#"$REPO_ROOT/"}"
fi

echo; (( FAILS == 0 )) && echo "Smoke test passed." || echo "${FAILS} check(s) failed."
exit $(( FAILS > 0 ))
