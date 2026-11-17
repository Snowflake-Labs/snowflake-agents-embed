#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# Fail if a shipped Native App service spec still contains a provider-owned
# *.force.com, *.pages.dev or *.workers.dev CORS literal. Template tokens
# ({{ cors_origins }}, {{ cdn_origin }}) are the only allowed origin values.
#
# Also fail if the Teams private-network spec drifts from the public one in
# anything but its "# private-only" lines.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
failed=0

for spec in \
  "$root/apps/teams/native-app/services/service_spec.yml" \
  "$root/apps/teams/native-app/services/service_spec_private.yml"
do
  [[ -f "$spec" ]] || continue
  if grep -E 'force\.com|pages\.dev|workers\.dev' "$spec" >/dev/null; then
    echo "lint-service-specs: $spec still contains a force.com, pages.dev or workers.dev literal" >&2
    grep -nE 'force\.com|pages\.dev|workers\.dev' "$spec" >&2 || true
    failed=1
  fi
done

teams_public="$root/apps/teams/native-app/services/service_spec.yml"
teams_private="$root/apps/teams/native-app/services/service_spec_private.yml"
if [[ -f "$teams_public" && -f "$teams_private" ]]; then
  # Compare from `spec:` on; the header comments are allowed to differ.
  if ! diff -u \
    <(sed -n '/^spec:/,$p' "$teams_public") \
    <(sed -n '/^spec:/,$p' "$teams_private" | grep -v '# private-only$') >&2
  then
    echo "lint-service-specs: $teams_private differs from $teams_public outside its '# private-only' lines" >&2
    failed=1
  fi
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
echo "lint-service-specs: ok"
