#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# rotate-entra-secret.sh — rotate an Entra client secret end to end without printing it.
#
#   bash apps/teams/scripts/rotate-entra-secret.sh --obo|--bot [-c <snow connection>] [--create-worker]
#
# --obo  rotates OBO_CLIENT_SECRET (Entra app OBO_CLIENT_ID): apps/teams/.env, Snowflake secret,
#        Cloudflare Worker secret.
# --bot  rotates BOT_APP_SECRET (Entra app BOT_APP_ID): apps/teams/.env and Snowflake secret
#        (the Worker only holds BOT_APP_ID).
#
# Order: add a new credential (the old one keeps working), write .env, apply to Snowflake and the
# Worker, then delete the old credentials. If a later step fails the old credential is left in
# place, so nothing is locked out; fix the cause and re-run (the .env then already has the new
# value, which the re-run replaces with another new one).
# Afterwards roll the service so SPCS re-reads the secrets: bash apps/teams/scripts/deploy-spcs.sh
# Rotate Entra secrets when they approach expiry (90-day PAT cadence is separate:
# re-mint SNOWFLAKE_PAT and run set-edge-secrets.sh).
# Needs: az (logged in to AZURE_TENANT_ID), snow, python3, and what set-edge-secrets.sh needs.

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "\n${GREEN}▶ $*${NC}"; }
info() { echo -e "  $*"; }
die()  { echo -e "${RED}✗  $*${NC}" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="${REPO_ROOT}/apps/teams/.env"
[[ -f "$ENV_FILE" ]] || die "no apps/teams/.env found"

TARGET=""; CONN=""; CREATE_FLAG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --obo|--bot) TARGET="${1#--}"; shift ;;
    -c|--connection) CONN="${2:?-c needs a value}"; shift 2 ;;
    --create-worker) CREATE_FLAG=(--create); shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$TARGET" ]] || die "pass --obo or --bot"

command -v az >/dev/null || die "az CLI not found on PATH"
command -v python3 >/dev/null || die "python3 not found on PATH"

envval() {
  local raw
  raw="$({ grep -iE "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" || true; } \
    | head -1 | sed 's/^[^=]*=[[:space:]]*//' | tr -d '\r' | sed 's/[[:space:]]*$//')"
  raw="${raw#\"}"; raw="${raw%\"}"; raw="${raw#\'}"; raw="${raw%\'}"
  printf '%s' "$raw"
}

if [[ "$TARGET" == obo ]]; then ID_KEY=OBO_CLIENT_ID; SECRET_KEY=OBO_CLIENT_SECRET
else ID_KEY=BOT_APP_ID; SECRET_KEY=BOT_APP_SECRET; fi
APP_ID="$(envval "$ID_KEY")"
TENANT="$(envval AZURE_TENANT_ID)"
[[ -n "$APP_ID" ]] || die "${ID_KEY} is not set in apps/teams/.env"
[[ -n "$TENANT" ]] || die "AZURE_TENANT_ID is not set in apps/teams/.env"

step "Checking az login"
CURRENT_TENANT="$(az account show --query tenantId -o tsv 2>/dev/null || true)"
[[ "$CURRENT_TENANT" == "$TENANT" ]] \
  || die "az is logged into tenant '${CURRENT_TENANT:-none}', expected ${TENANT}. Run: az login --tenant ${TENANT}"

step "Adding a new client secret to ${ID_KEY} (${APP_ID})"
OLD_KEY_IDS="$(az ad app credential list --id "$APP_ID" --query '[].keyId' -o tsv)"
NEW_SECRET="$(az ad app credential reset --id "$APP_ID" --append \
  --display-name "rotated-$(date -u +%Y%m%d%H%M%S)" --years 1 --query password -o tsv)"
[[ -n "$NEW_SECRET" ]] || die "Entra returned no secret"

step "Updating apps/teams/.env (${SECRET_KEY})"
NEW_SECRET="$NEW_SECRET" ENV_FILE="$ENV_FILE" SECRET_KEY="$SECRET_KEY" python3 - <<'PY'
import os, re, tempfile
path, key, val = os.environ["ENV_FILE"], os.environ["SECRET_KEY"], os.environ["NEW_SECRET"]
lines = open(path).read().split("\n")
pat = re.compile(r"^\s*" + re.escape(key) + r"\s*=", re.I)
done = False
for i, ln in enumerate(lines):
    if pat.match(ln) and not done:
        lines[i] = f"{key}={val}"; done = True
if not done:
    lines.append(f"{key}={val}")
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, "w") as f:
    f.write("\n".join(lines))
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
unset NEW_SECRET

step "Applying to Snowflake secrets (statements not echoed)"
FILL_ARGS=(--apply)
[[ -n "$CONN" ]] && FILL_ARGS+=(-c "$CONN")
bash "$SCRIPT_DIR/fill-dev-secrets.sh" "${FILL_ARGS[@]}" >/dev/null

if [[ "$TARGET" == obo ]]; then
  step "Updating the Cloudflare Worker secrets"
  bash "$SCRIPT_DIR/set-edge-secrets.sh" ${CREATE_FLAG[@]+"${CREATE_FLAG[@]}"} >/dev/null
fi

step "Deleting the previous credentials"
for KID in $OLD_KEY_IDS; do
  az ad app credential delete --id "$APP_ID" --key-id "$KID" >/dev/null
  info "deleted credential ${KID}"
done

step "Done — ${SECRET_KEY} rotated."
info "Next: bash apps/teams/scripts/deploy-spcs.sh   (roll the service so it re-reads the secrets)"
[[ "$TARGET" == obo ]] && info "Then: bash apps/teams/scripts/deploy-tab.sh   (warm isolates keep the old Worker secret until redeploy)"
