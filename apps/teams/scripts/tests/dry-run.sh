#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# Dry-run tests for create-bot.sh and set-svc-network-policy.sh using stub az, snow and curl.
#   bash apps/teams/scripts/tests/dry-run.sh
# Runs against a temp copy of the scripts, so the real apps/teams/.env is never read or written.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/apps/teams" "$TMP/bin"
cp -R "$SRC" "$TMP/apps/teams/scripts"
cat > "$TMP/apps/teams/.env" <<'ENV'
BOT_APP_ID=11111111-2222-3333-4444-555555555555
AZURE_TENANT_ID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
TAB_BASE_HOST=edge.example.workers.dev
SNOWFLAKE_USER=AGENTS_TEAMS_SVC
ENV

cat > "$TMP/bin/az" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "account show --query tenantId"*) echo aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee ;;
  "account show --query id"*) echo 00000000-0000-0000-0000-000000000000 ;;
  "ad app list"*) echo AzureADMyOrg ;;
  "resource list"*) : ;;
  "group exists"*) echo false ;;
  *) echo "unexpected az call: $*" >&2; exit 1 ;;
esac
STUB
cat > "$TMP/bin/snow" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *CURRENT_ACCOUNT_NAME*) echo '[{"A":"TESTACCT"}]' ;;
  *"SHOW PARAMETERS"*) echo '[]' ;;
  *) echo "unexpected snow call (state change in dry run?): $*" >&2; exit 1 ;;
esac
STUB
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '173.245.48.0/20\n103.21.244.0/22\n'
STUB
chmod +x "$TMP/bin/"*

FAILS=0
check() { # name, haystack, needle
  if grep -qF -- "$3" <<<"$2"; then echo "ok   $1"; else echo "FAIL $1: missing \"$3\""; FAILS=$((FAILS+1)); fi
}
run() { PATH="$TMP/bin:$PATH" bash "$TMP/apps/teams/scripts/$1" "${@:2}" 2>&1; }

out="$(run create-bot.sh)"
check "create-bot dry run header"   "$out" "Dry run. --apply would run:"
check "create-bot endpoint"         "$out" "--endpoint https://edge.example.workers.dev/api/bot/messages"
check "create-bot app type"         "$out" "--app-type SingleTenant"
check "create-bot default name"     "$out" "-n agents-teams-bot-11111111"
check "create-bot teams channel"    "$out" "az bot msteams create"

out="$(run set-svc-network-policy.sh)"
check "policy account shown"        "$out" "Snowflake account: TESTACCT"
check "policy dry run"              "$out" "Dry run. SQL that --apply would run:"
check "policy create"               "$out" "CREATE NETWORK POLICY IF NOT EXISTS AGENTS_TEAMS_INGRESS_POLICY"
check "policy cidr list"            "$out" "'173.245.48.0/20', '103.21.244.0/22'"
check "policy attach"               "$out" "ALTER USER AGENTS_TEAMS_SVC SET NETWORK_POLICY = AGENTS_TEAMS_INGRESS_POLICY"

if out="$(run create-bot.sh --bogus)"; then echo "FAIL create-bot accepted --bogus"; FAILS=$((FAILS+1)); else check "create-bot rejects unknown flag" "$out" "unknown argument"; fi

[[ "$FAILS" == 0 ]] || { echo "$FAILS failed"; exit 1; }
echo "all passed"
