#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# set-bot-endpoint.sh — point the Azure Bot messaging endpoint at the edge
# origin (never the SPCS ingress). Reads TAB_BASE_HOST and AZURE_TENANT_ID
# from apps/teams/.env. All Azure CLI calls stay in that tenant.
#
#   bash apps/teams/scripts/set-bot-endpoint.sh
#
# Finds the Bot Service in subscriptions that belong to AZURE_TENANT_ID.
# Optional AZURE_SUBSCRIPTION_ID / RESOURCE_GROUP / BOT_NAME narrow the search.

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "\n${GREEN}▶ $*${NC}"; }
info() { echo -e "  $*"; }
die()  { echo -e "${RED}✗  $*${NC}" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"
ENV_FILE="${REPO_ROOT}/apps/teams/.env"
[[ -f "$ENV_FILE" ]] || die "no apps/teams/.env found"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Read a key from .env. The `|| true` is load-bearing: under `set -e` a grep that
# matches nothing exits 1, which fails the assignment and kills the script.
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

TAB_BASE_HOST="${TAB_BASE_HOST:-$(envval TAB_BASE_HOST)}"
AZURE_TENANT_ID="${AZURE_TENANT_ID:-$(envval AZURE_TENANT_ID)}"
[[ -n "$TAB_BASE_HOST" ]] || die "TAB_BASE_HOST is not set — see apps/teams/.env.example"
[[ -n "$AZURE_TENANT_ID" ]] || die "AZURE_TENANT_ID is not set — see apps/teams/.env.example"
TAB_BASE_HOST="${TAB_BASE_HOST#https://}"
TAB_BASE_HOST="${TAB_BASE_HOST#http://}"
TAB_BASE_HOST="${TAB_BASE_HOST%/}"

RESOURCE_GROUP="${RESOURCE_GROUP:-$(envval RESOURCE_GROUP)}"
BOT_NAME="${BOT_NAME:-$(envval BOT_NAME)}"
SUBSCRIPTION="${AZURE_SUBSCRIPTION_ID:-$(envval AZURE_SUBSCRIPTION_ID)}"
BOT_APP_ID="${BOT_APP_ID:-$(envval BOT_APP_ID)}"

ENDPOINT="https://${TAB_BASE_HOST}/api/bot/messages"

command -v az >/dev/null || die "az (Azure CLI) not found on PATH"
command -v python3 >/dev/null || die "python3 not found on PATH"

CURRENT_TENANT="$(az account show --query tenantId -o tsv 2>/dev/null || true)"
if [[ "$CURRENT_TENANT" != "$AZURE_TENANT_ID" ]]; then
  die "az is logged into tenant ${CURRENT_TENANT:-none}, expected ${AZURE_TENANT_ID} from apps/teams/.env.
  Run: az login --tenant ${AZURE_TENANT_ID}"
fi

step "Resolving Azure Bot in tenant ${AZURE_TENANT_ID}"

SUBS_JSON="$(az account list --query "[?tenantId=='${AZURE_TENANT_ID}']" -o json)"
RESOLVED="$(
  SUBS_JSON="$SUBS_JSON" WANT_SUB="$SUBSCRIPTION" RESOURCE_GROUP="$RESOURCE_GROUP" \
  BOT_NAME="$BOT_NAME" BOT_APP_ID="$BOT_APP_ID" python3 - <<'PY'
import json, os, subprocess, sys

subs = json.loads(os.environ["SUBS_JSON"] or "[]")
want_sub = (os.environ.get("WANT_SUB") or "").lower()
want_rg = os.environ.get("RESOURCE_GROUP") or ""
want_name = os.environ.get("BOT_NAME") or ""
want_app = (os.environ.get("BOT_APP_ID") or "").lower()

if not subs:
    sys.exit("no Azure subscription in this tenant")

if want_sub:
    matched = [s for s in subs if str(s.get("id", "")).lower() == want_sub]
    if not matched:
        sys.exit("AZURE_SUBSCRIPTION_ID is not in AZURE_TENANT_ID")
    subs = matched

hits = []
for s in subs:
    sid = s["id"]
    raw = subprocess.check_output(
        ["az", "resource", "list", "--subscription", sid,
         "--resource-type", "Microsoft.BotService/botServices", "-o", "json"],
        text=True,
    )
    for b in json.loads(raw or "[]"):
        hits.append({
            "subscription": sid,
            "subscriptionName": s.get("name") or sid,
            "resourceGroup": b.get("resourceGroup"),
            "name": b.get("name"),
            "properties": b.get("properties") or {},
        })

if want_rg:
    hits = [h for h in hits if h["resourceGroup"] == want_rg]
if want_name:
    hits = [h for h in hits if h["name"] == want_name]
if want_app and len(hits) > 1:
    app_hits = []
    for h in hits:
        props = h.get("properties") or {}
        app = str(props.get("msaAppId") or props.get("msa_app_id") or "").lower()
        if app == want_app:
            app_hits.append(h)
    if app_hits:
        hits = app_hits

if len(hits) == 1:
    h = hits[0]
    print(f"{h['subscription']}\t{h['resourceGroup']}\t{h['name']}\t{h['subscriptionName']}")
    raise SystemExit(0)
if len(hits) == 0:
    sys.exit("no Microsoft.BotService/botServices in AZURE_TENANT_ID")
names = ", ".join(f"{h['subscriptionName']}/{h['resourceGroup']}/{h['name']}" for h in hits)
sys.exit(f"multiple bots ({names}); set RESOURCE_GROUP and BOT_NAME")
PY
)" || die "${RESOLVED:-could not resolve Bot Service in AZURE_TENANT_ID}. Create one (Path A: bash apps/teams/scripts/create-bot.sh --apply; Path B: wizard tab 5), or set RESOURCE_GROUP and BOT_NAME."

IFS=$'\t' read -r SUBSCRIPTION RESOURCE_GROUP BOT_NAME SUB_NAME <<<"$RESOLVED"
info "subscription: ${SUB_NAME} (${SUBSCRIPTION})"
info "resource group: ${RESOURCE_GROUP}"
info "bot:            ${BOT_NAME}"
info "endpoint:       ${ENDPOINT}"

step "Setting Azure Bot messaging endpoint"
az resource update \
  --subscription "$SUBSCRIPTION" \
  -g "$RESOURCE_GROUP" \
  -n "$BOT_NAME" \
  --resource-type Microsoft.BotService/botServices \
  --set "properties.endpoint=${ENDPOINT}" \
  --query "properties.endpoint" \
  -o tsv

step "Done — messaging endpoint is the edge origin, not SPCS ingress."
