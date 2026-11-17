#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# Report synonyms that are claimed by more than one column in the SAME logical
# table of a semantic view.
#
#   ./check-synonyms.sh -c demo
#   ./check-synonyms.sh -c demo SUPERSTORE.PUBLIC.SUPERSTORE_ANALYSIS
#
# This reproduces the warning Snowsight's semantic-view validator emits. It
# matters because an ambiguous synonym is a silent quality problem: Cortex Analyst
# still answers, it just may bind "revenue" to the row-level fact instead of the
# aggregate metric, and the wrong choice looks like a plausible number.
#
# Facts, dimensions and metrics share one synonym namespace per table, so all
# three have to be pulled and compared together.
set -euo pipefail
cd "$(dirname "$0")"

CONN=""
VIEW="SUPERSTORE.AGENTS.SUPERSTORE_360"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--connection) CONN="$2"; shift 2 ;;
    *) VIEW="$1"; shift ;;
  esac
done

SNOW=(snow sql --format json)
[[ -n "$CONN" ]] && SNOW+=(-c "$CONN")

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for kind in DIMENSIONS FACTS METRICS; do
  "${SNOW[@]}" -q "SHOW SEMANTIC $kind IN $VIEW;" > "$tmp/$kind.json" 2>/dev/null || echo '[]' > "$tmp/$kind.json"
done

python3 - "$tmp" "$VIEW" <<'PY'
import json, sys, collections
tmp, view = sys.argv[1], sys.argv[2]

# (table, synonym) -> [column, ...]
owners = collections.defaultdict(list)
for kind in ('DIMENSIONS', 'FACTS', 'METRICS'):
    try:
        rows = json.load(open(f'{tmp}/{kind}.json'))
    except Exception:
        rows = []
    for r in rows if isinstance(rows, list) else []:
        raw = r.get('synonyms')
        if not raw:
            continue
        try:
            syns = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            continue
        for s in syns or []:
            owners[(r.get('table_name'), s.strip().lower())].append(
                f"{r.get('name','?').lower()} ({kind[:-1].lower()})")

dupes = {k: v for k, v in owners.items() if len(set(v)) > 1}
print(f'{view}')
if not dupes:
    print('  no duplicate synonyms within any table')
    sys.exit(0)
print(f'  {len(dupes)} duplicated synonym(s):')
for i, ((table, syn), cols) in enumerate(sorted(dupes.items()), 1):
    print(f'  {i}. "{syn}" in {table} -> {", ".join(sorted(set(cols)))}')
sys.exit(1)
PY
