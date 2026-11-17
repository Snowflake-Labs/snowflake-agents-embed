#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# create-bot.sh — create the Azure Bot Service and enable its Teams channel (idempotent).
#
#   bash apps/teams/scripts/create-bot.sh [--apply] [--resource-group NAME] [--bot-name NAME] [--location LOC]
#
# Reads BOT_APP_ID, AZURE_TENANT_ID and TAB_BASE_HOST from apps/teams/.env. The messaging endpoint is
# https://<TAB_BASE_HOST>/api/bot/messages (the edge origin, never the SPCS ingress). Without a bot, adding
# the Teams app to a channel fails with "BadRequest: Failed to execute Skype backend request
# BulkMembershipRequest".
#
# Dry run by default; --apply creates what is missing. An existing bot is never modified: if its endpoint
# differs, run set-bot-endpoint.sh. Defaults: resource group agents-teams-rg, bot name
# agents-teams-bot-<first 8 chars of BOT_APP_ID>, bot location global (F0). --location only applies to a new
# resource group (default uksouth). RESOURCE_GROUP / BOT_NAME / AZURE_SUBSCRIPTION_ID in .env also work.

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "\n${GREEN}▶ $*${NC}"; }
info() { echo -e "  $*"; }
die()  { echo -e "${RED}✗  $*${NC}" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="${REPO_ROOT}/apps/teams/.env"
[[ -f "$ENV_FILE" ]] || die "no apps/teams/.env found"
# shellcheck source=lib/env.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"

APPLY=0; RG_ARG=""; BOT_ARG=""; LOCATION="uksouth"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --resource-group) RG_ARG="${2:?--resource-group needs a value}"; shift 2 ;;
    --bot-name) BOT_ARG="${2:?--bot-name needs a value}"; shift 2 ;;
    --location) LOCATION="${2:?--location needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

BOT_APP_ID="$(envval BOT_APP_ID)"
AZURE_TENANT_ID="$(envval AZURE_TENANT_ID)"
TAB_BASE_HOST="$(envval TAB_BASE_HOST)"
[[ -n "$BOT_APP_ID" ]] || die "BOT_APP_ID is not set in apps/teams/.env"
[[ -n "$AZURE_TENANT_ID" ]] || die "AZURE_TENANT_ID is not set in apps/teams/.env"
[[ -n "$TAB_BASE_HOST" ]] || die "TAB_BASE_HOST is not set in apps/teams/.env"
[[ "$BOT_APP_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || die "BOT_APP_ID is not a GUID"
TAB_BASE_HOST="${TAB_BASE_HOST#https://}"; TAB_BASE_HOST="${TAB_BASE_HOST#http://}"; TAB_BASE_HOST="${TAB_BASE_HOST%/}"
ENDPOINT="https://${TAB_BASE_HOST}/api/bot/messages"

RESOURCE_GROUP="${RG_ARG:-$(envval RESOURCE_GROUP)}"; RESOURCE_GROUP="${RESOURCE_GROUP:-agents-teams-rg}"
BOT_NAME="${BOT_ARG:-$(envval BOT_NAME)}"; BOT_NAME="${BOT_NAME:-agents-teams-bot-${BOT_APP_ID:0:8}}"
SUBSCRIPTION="$(envval AZURE_SUBSCRIPTION_ID)"
[[ "$RESOURCE_GROUP" =~ ^[A-Za-z0-9._()-]{1,90}$ ]] || die "resource group \"${RESOURCE_GROUP}\" has unexpected characters"
[[ "$BOT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{1,41}$ ]] || die "bot name \"${BOT_NAME}\" is not valid (2-42 chars: letters, digits, . _ -)"
[[ "$LOCATION" =~ ^[a-z0-9]+$ ]] || die "location \"${LOCATION}\" is not valid"

command -v az >/dev/null || die "az (Azure CLI) not found on PATH"
current_tenant="$(az account show --query tenantId -o tsv 2>/dev/null || true)"
[[ "$current_tenant" == "$AZURE_TENANT_ID" ]] || die "az is logged into tenant ${current_tenant:-none}, expected ${AZURE_TENANT_ID}.
  Run: az login --tenant ${AZURE_TENANT_ID}"
if [[ -z "$SUBSCRIPTION" ]]; then
  SUBSCRIPTION="$(az account show --query id -o tsv)"
else
  az account list --query "[?tenantId=='${AZURE_TENANT_ID}'].id" -o tsv | grep -qix "$SUBSCRIPTION" \
    || die "AZURE_SUBSCRIPTION_ID is not in AZURE_TENANT_ID"
fi
SUB=(--subscription "$SUBSCRIPTION")

step "Azure Bot for app ${BOT_APP_ID}"
info "subscription:   ${SUBSCRIPTION}"
info "resource group: ${RESOURCE_GROUP}"
info "bot:            ${BOT_NAME}"
info "endpoint:       ${ENDPOINT}"

# The bot's app type must match the Entra app's sign-in audience, or Bot Framework auth fails.
audience="$(az ad app list --filter "appId eq '${BOT_APP_ID}'" --query "[0].signInAudience" -o tsv 2>/dev/null || true)"
case "$audience" in
  AzureADMyOrg) APP_TYPE=SingleTenant ;;
  AzureADMultipleOrgs|AzureADandPersonalMicrosoftAccount) APP_TYPE=MultiTenant ;;
  *) die "could not read signInAudience for BOT_APP_ID ${BOT_APP_ID} (not found, or no Entra read access). Check BOT_APP_ID and the az login." ;;
esac
info "app type:       ${APP_TYPE} (Entra signInAudience ${audience})"

existing="$(az resource list --resource-type Microsoft.BotService/botServices \
  --query "[?name=='${BOT_NAME}'].resourceGroup" -o tsv "${SUB[@]}" 2>/dev/null || true)"

if [[ -n "$existing" ]]; then
  [[ "$existing" == "$RESOURCE_GROUP" ]] || die "bot ${BOT_NAME} already exists in resource group ${existing}, not ${RESOURCE_GROUP}. Pass --resource-group ${existing}."
  cur_ep="$(az bot show -g "$RESOURCE_GROUP" -n "$BOT_NAME" --query properties.endpoint -o tsv "${SUB[@]}")"
  cur_app="$(az bot show -g "$RESOURCE_GROUP" -n "$BOT_NAME" --query properties.msaAppId -o tsv "${SUB[@]}")"
  [[ "$cur_app" == "$BOT_APP_ID" ]] || die "bot ${BOT_NAME} exists but uses app ${cur_app}, not BOT_APP_ID. Choose another --bot-name."
  if [[ "$cur_ep" == "$ENDPOINT" ]]; then
    echo -e "${GREEN}✓${NC} bot exists and its endpoint is in sync"
  else
    echo -e "${YELLOW}bot exists with endpoint ${cur_ep:-<none>}; run: bash apps/teams/scripts/set-bot-endpoint.sh${NC}"
  fi
  teams_on="$(az bot msteams show -g "$RESOURCE_GROUP" -n "$BOT_NAME" --query properties.properties.isEnabled -o tsv "${SUB[@]}" 2>/dev/null || true)"
  if [[ "$teams_on" == true || "$teams_on" == True ]]; then
    echo -e "${GREEN}✓${NC} Teams channel is enabled"
    exit 0
  fi
  info "Teams channel is not enabled"
else
  info "bot does not exist"
fi

rg_exists="$(az group exists -n "$RESOURCE_GROUP" "${SUB[@]}")"
if [[ "$APPLY" == 0 ]]; then
  echo; echo "Dry run. --apply would run:"
  [[ "$rg_exists" == true ]] || echo "  az group create -n ${RESOURCE_GROUP} -l ${LOCATION}"
  [[ -n "$existing" ]] || echo "  az bot create -g ${RESOURCE_GROUP} -n ${BOT_NAME} --appid ${BOT_APP_ID} --app-type ${APP_TYPE} --tenant-id ${AZURE_TENANT_ID} --endpoint ${ENDPOINT} --sku F0"
  echo "  az bot msteams create -g ${RESOURCE_GROUP} -n ${BOT_NAME}"
  exit 0
fi

if [[ "$rg_exists" != true ]]; then
  step "Creating resource group ${RESOURCE_GROUP}"
  az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none "${SUB[@]}"
fi
if [[ -z "$existing" ]]; then
  step "Creating bot ${BOT_NAME}"
  az bot create -g "$RESOURCE_GROUP" -n "$BOT_NAME" --appid "$BOT_APP_ID" --app-type "$APP_TYPE" \
    --tenant-id "$AZURE_TENANT_ID" --endpoint "$ENDPOINT" --sku F0 -o none "${SUB[@]}"
fi
step "Enabling the Teams channel"
az bot msteams create -g "$RESOURCE_GROUP" -n "$BOT_NAME" -o none "${SUB[@]}" 2>/dev/null
echo -e "${GREEN}✓${NC} bot ${BOT_NAME} ready; messaging endpoint ${ENDPOINT}"
