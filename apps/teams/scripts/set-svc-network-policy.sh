#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# set-svc-network-policy.sh — let Cloudflare egress reach Snowflake as the service PAT user.
#
#   bash apps/teams/scripts/set-svc-network-policy.sh [-c <snow connection>] [--user NAME] [--apply] [--replace]
#
# The edge Worker calls the SPCS ingress with the PAT from Cloudflare IPs. If the PAT user falls under an
# account policy that does not list them, every call fails with "IP/Token <ip> is not allowed to access
# Snowflake" (390422). This creates a user-level policy AGENTS_TEAMS_INGRESS_POLICY from
# https://www.cloudflare.com/ips-v4 and attaches it to the PAT user (SNOWFLAKE_USER in apps/teams/.env,
# or --user). Re-running refreshes the IP list.
#
# Prints the SQL by default; --apply runs it. A user that already has a different user-level policy is
# left alone unless --replace. Account-level policies are never touched. Applies to NETWORK_MODE public
# and hybrid; in privatelink see docs/teams/teams-private-connectivity.md section 7.4.

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
die() { echo -e "${RED}✗  $*${NC}" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="${REPO_ROOT}/apps/teams/.env"
POLICY="AGENTS_TEAMS_INGRESS_POLICY"
CONN=""; USER_NAME=""; APPLY=0; REPLACE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--connection) CONN="${2:?-c needs a value}"; shift 2 ;;
    --user) USER_NAME="${2:?--user needs a value}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --replace) REPLACE=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [[ -z "$USER_NAME" ]]; then
  [[ -f "$ENV_FILE" ]] || die "no apps/teams/.env found (or pass --user)"
  # shellcheck source=lib/env.sh
  source "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"
  USER_NAME="$(envval SNOWFLAKE_USER)"
fi
[[ -n "$USER_NAME" ]] || die "SNOWFLAKE_USER is not set in apps/teams/.env (or pass --user)"
[[ "$USER_NAME" =~ ^[A-Za-z_][A-Za-z0-9_$]*$ ]] || die "user \"${USER_NAME}\" is not a plain Snowflake identifier"
command -v snow >/dev/null || die "snow (Snowflake CLI) not found on PATH"
command -v curl >/dev/null || die "curl not found on PATH"

# -c goes after the subcommand (snow sql -c demo, never snow -c demo sql).
sql() {
  if [[ -n "$CONN" ]]; then snow sql -c "$CONN" --silent --enable-templating none "$@"
  else snow sql --silent --enable-templating none "$@"; fi
}
json_field() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0][sys.argv[1]] if d else '')" "$1" 2>/dev/null || true; }

ranges="$(curl -fsS -m 20 https://www.cloudflare.com/ips-v4)" || die "could not fetch https://www.cloudflare.com/ips-v4"
ranges="$(tr -d '\r' <<<"$ranges" | sed '/^[[:space:]]*$/d')"
[[ -n "$ranges" ]] || die "Cloudflare IP list is empty"
while IFS= read -r cidr; do
  [[ "$cidr" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || die "unexpected line in the Cloudflare IP list: ${cidr}"
done <<<"$ranges"
ip_list="$(sed "s/.*/'&'/" <<<"$ranges" | paste -sd, - | sed 's/,/, /g')"

account="$(sql --format json -q "SELECT CURRENT_ACCOUNT_NAME() AS A" | json_field A)"
[[ -n "$account" ]] || die "could not query Snowflake; check the snow connection"
echo "Snowflake account: ${account}"
echo "PAT user:          ${USER_NAME}"

param="$(sql --format json -q "SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN USER ${USER_NAME}" 2>/dev/null || true)"
cur_level="$(json_field level <<<"$param")"
cur_value="$(json_field value <<<"$param")"

if [[ "$cur_level" == USER && -n "$cur_value" && "$cur_value" != "$POLICY" ]]; then
  if [[ "$REPLACE" == 0 ]]; then
    echo -e "${YELLOW}${USER_NAME} already has the user-level policy ${cur_value}; leaving it.${NC}"
    echo "Check that it allows the Cloudflare ranges (DESCRIBE NETWORK POLICY ${cur_value}) or re-run with --replace."
    exit 0
  fi
  echo "Replacing user-level policy ${cur_value} with ${POLICY}"
fi

stmts=(
  "CREATE NETWORK POLICY IF NOT EXISTS ${POLICY} ALLOWED_IP_LIST = (${ip_list}) COMMENT = 'Cloudflare egress for the Agents Teams edge'"
  "ALTER NETWORK POLICY ${POLICY} SET ALLOWED_IP_LIST = (${ip_list})"
  "ALTER USER ${USER_NAME} SET NETWORK_POLICY = ${POLICY}"
)

if [[ "$APPLY" == 0 ]]; then
  echo; echo "Dry run. SQL that --apply would run:"
  printf '  %s;\n' "${stmts[@]}"
  exit 0
fi
for s in "${stmts[@]}"; do sql -q "$s" >/dev/null || die "failed: ${s%%(*}"; done
echo -e "${GREEN}✓${NC} ${USER_NAME} now uses ${POLICY} ($(wc -l <<<"$ranges" | tr -d ' ') Cloudflare IPv4 ranges)"
