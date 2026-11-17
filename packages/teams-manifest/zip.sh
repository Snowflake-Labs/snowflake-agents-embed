#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# Build agents-teams-app.zip ready to sideload in Teams.
#   bash packages/teams-manifest/zip.sh [--tab-only]
# --tab-only writes agents-teams-app-tab-only.zip without bots, composeExtensions and configurableTabs,
# for installs that have no Azure Bot yet (see apps/teams/scripts/create-bot.sh). It cannot be added to a channel.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAB_ONLY=0
case "${1:-}" in
  "") ;;
  --tab-only) TAB_ONLY=1 ;;
  -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 1 ;;
esac
cd "$DIR"
node generate.mjs
if [[ "$TAB_ONLY" == 1 ]]; then
  OUT="${DIR}/agents-teams-app-tab-only.zip"
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
    for (const k of ["bots", "composeExtensions", "configurableTabs"]) delete m[k];
    fs.writeFileSync(process.argv[1] + "/manifest.json", JSON.stringify(m, null, 2) + "\n");
  ' "$STAGE"
  rm -f "$OUT"
  zip -j "$OUT" "$STAGE/manifest.json" color.png outline.png
else
  OUT="${DIR}/agents-teams-app.zip"
  rm -f "$OUT"
  zip -j "$OUT" manifest.json color.png outline.png
fi
echo "Created: $OUT"
echo "Sideload via Teams → Apps → Manage your apps → Upload an app"
