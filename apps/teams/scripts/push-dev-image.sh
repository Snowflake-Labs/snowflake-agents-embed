#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# push-dev-image.sh — Path A first push of linux/amd64 :latest to IMAGE_REPO
# (not NA_IMAGE_REPO). Resolves repository_url from SHOW IMAGE REPOSITORIES so
# the operator does not paste a placeholder (zsh treats <IMAGE_REPO> as a
# redirect).
#
#   bash apps/teams/scripts/push-dev-image.sh
#   bash apps/teams/scripts/push-dev-image.sh -c demo
#   bash apps/teams/scripts/push-dev-image.sh --no-build
#
# This is not deploy-spcs.sh: it does not ALTER SERVICE. Run it before
# create-dev-service.sql. After the service exists, use deploy-spcs.sh to
# push and roll.

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "\n${GREEN}▶ $*${NC}"; }
info() { echo -e "  $*"; }
warn() { echo -e "${YELLOW}!  $*${NC}"; }
die()  { echo -e "${RED}✗  $*${NC}" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

CONN=""
DO_BUILD=1
LOCAL_IMAGE="${LOCAL_IMAGE:-agents-teams-app:latest}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--connection) CONN="$2"; shift 2 ;;
    --no-build)      DO_BUILD=0; shift ;;
    -h|--help)       sed -n '2,14p' "$0"; exit 0 ;;
    *)               die "unknown argument: $1" ;;
  esac
done

# -c goes after the subcommand (snow sql -c demo, never snow -c demo sql).
snow_sql() {
  if [[ -n "$CONN" ]]; then
    snow sql -c "$CONN" --enable-templating none "$@"
  else
    snow sql --enable-templating none "$@"
  fi
}

snow_registry_login() {
  if [[ -n "$CONN" ]]; then
    snow spcs image-registry login -c "$CONN"
  else
    snow spcs image-registry login
  fi
}

command -v docker >/dev/null || die "docker not found on PATH"
command -v snow   >/dev/null || die "snow (Snowflake CLI) not found on PATH"
command -v python3 >/dev/null || die "python3 not found on PATH"

step "Resolving IMAGE_REPO from SHOW IMAGE REPOSITORIES"
IMAGE_REPO="$(
  snow_sql --format json -q "SHOW IMAGE REPOSITORIES IN SCHEMA AGENTS_TEAMS_APP_DB.PUBLIC" \
    | python3 -c '
import json, sys
rows = json.load(sys.stdin)
if isinstance(rows, dict):
    rows = [rows]
matches = [r for r in rows if str(r.get("name", "")).upper() == "IMAGE_REPO"]
if not matches:
    sys.exit("IMAGE_REPO not found in AGENTS_TEAMS_APP_DB.PUBLIC")
print(matches[0]["repository_url"].strip())
'
)"
[[ -n "$IMAGE_REPO" ]] || die "empty repository_url for IMAGE_REPO"
REGISTRY_IMAGE="${IMAGE_REPO}/agents-teams-app"
info "$REGISTRY_IMAGE"

if [[ "$DO_BUILD" == 1 ]]; then
  step "Building $LOCAL_IMAGE for linux/amd64"
  docker build --platform linux/amd64 -f apps/teams/Dockerfile -t "$LOCAL_IMAGE" .
else
  warn "Skipping build (--no-build); using existing $LOCAL_IMAGE"
fi

step "Logging in to the Snowflake image registry"
snow_registry_login

step "Tagging and pushing ${REGISTRY_IMAGE}:latest"
docker tag "$LOCAL_IMAGE" "${REGISTRY_IMAGE}:latest"
PUSH_OUT="$(docker push "${REGISTRY_IMAGE}:latest")"
echo "$PUSH_OUT" | tail -1
DIGEST="$(echo "$PUSH_OUT" | grep -oE 'sha256:[0-9a-f]{64}' | tail -1 || true)"
[[ -n "$DIGEST" ]] && info "digest $DIGEST"

step "Done — IMAGE_REPO has ${REGISTRY_IMAGE}:latest"
info "Next: create the service (SYSADMIN), then deploy-spcs.sh to roll later changes."
