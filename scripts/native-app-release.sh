#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# native-app-release.sh - pushes a new version/patch to an app's Native App
# application package and upgrades the provider's own dev/test application object.
#
# Takes over everything downstream of the container image existing in the
# provider's image repository (digest pinning + CREATE/ALTER SERVICE). The image
# itself is still built and pushed by apps/teams/scripts/deploy-spcs.sh.
#
#   ./scripts/native-app-release.sh teams v1
#
# Prerequisites: Snowflake CLI authenticated to the account that owns the
# image repository referenced in apps/teams/native-app/manifest.yml.

set -euo pipefail

APP="${1:-}"
VERSION="${2:-v1}"
[[ "$APP" == "teams" ]] || {
  echo "usage: $0 teams [version]" >&2
  exit 1
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/$APP/native-app"
cd "$APP_DIR"

SNOW="${SNOW_BIN:-snow}"
command -v "$SNOW" >/dev/null 2>&1 || { echo "snow CLI not found" >&2; exit 1; }

echo "==> Validating manifest + setup script (snow app deploy)"
"$SNOW" sql --format json -q "SELECT 1" >/dev/null # fail fast if not authenticated
"$SNOW" app deploy --no-interactive

echo "==> Registering version $VERSION in the application package"
"$SNOW" app version create "$VERSION" --no-interactive --force --skip-git-check

echo "==> Upgrading (or creating) the provider's own dev/test application object"
"$SNOW" app run --version "$VERSION" --no-interactive

echo "==> Done. See snowflake.yml for the application package/object identifiers."
