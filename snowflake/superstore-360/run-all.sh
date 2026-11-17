#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# Build SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT and everything it depends on.
#
#   ./run-all.sh                      # every step, default `snow` connection
#   ./run-all.sh -c demo              # named connection from ~/.snowflake/config.toml
#   ./run-all.sh -c demo --only 06    # one step
#   ./run-all.sh -c demo --from 04    # resume from this step onwards
#   FORCE_RESEED=1 ./run-all.sh -c demo --only 02
#
# Every step is idempotent, so a second full run is the intended way to prove
# nothing here depends on being the first to touch the account. The one caveat is
# 02_synthetic_reviews.sql: it leaves REVIEW_SEEDS alone if already populated,
# because rebuilding it re-bills ~680 AI_COMPLETE calls. FORCE_RESEED=1 drops the
# table first so the step regenerates it.
#
# Deliberately not using `snow sql --variable`: that switches on client-side
# templating, which would try to interpret the $$...$$ agent specs.
set -euo pipefail
cd "$(dirname "$0")"

CONN=""
ONLY=""
FROM=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--connection) CONN="$2"; shift 2 ;;
    --only)          ONLY="$2"; shift 2 ;;
    --from)          FROM="$2"; shift 2 ;;
    -h|--help)       sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SNOW=(snow sql)
[[ -n "$CONN" ]] && SNOW+=(-c "$CONN")

selected() {
  local num="${1%%_*}"
  [[ -n "$ONLY" && "$num" != "$ONLY" ]] && return 1
  [[ -n "$FROM" && "$num" < "$FROM"  ]] && return 1
  return 0
}

if [[ "${FORCE_RESEED:-0}" == "1" ]]; then
  echo "FORCE_RESEED=1 -> dropping REVIEW_SEEDS so 02 regenerates it"
  "${SNOW[@]}" -q "DROP TABLE IF EXISTS SUPERSTORE.AGENTS.REVIEW_SEEDS;"
fi

# 07 is allowed to be a near no-op: it only applies the optional tool blocks that
# 00_capability_probe.sql found this account will actually accept.
for f in [0-9][0-9]_*.sql; do
  selected "$f" || continue
  echo
  echo "=============================================================="
  echo "  $f"
  echo "=============================================================="
  "${SNOW[@]}" -f "$f" || { echo "FAILED: $f" >&2; exit 1; }
done

echo
echo "Done. Re-check assertions with: ./run-all.sh -c ${CONN:-<conn>} --only 09"
