#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# Shared preflight helpers for apps/teams/scripts. Source this file; it sets no shell options.

if ! declare -F die >/dev/null; then
  die() { echo "✗  $*" >&2; exit 1; }
fi

# Fail unless workspace dependencies are installed (tsc/vite come from the root node_modules).
require_node_modules() {
  local root="$1"
  [[ -x "${root}/node_modules/.bin/tsc" ]] \
    || die "node_modules is missing or incomplete. Run 'npm install' at ${root} first."
}

# Workers deploy to workers.dev; a pages.dev TAB_BASE_HOST can never match the deployed Worker.
reject_pages_dev_host() {
  case "$1" in
    *.pages.dev)
      die "TAB_BASE_HOST=$1 is a pages.dev host, but this edge deploys as a Worker (workers.dev or a custom domain)." \
          "Set TAB_BASE_HOST/TAB_BASE_URL to the Worker host and re-run." ;;
  esac
}

# Exit 0 if the named Worker already exists on the logged-in Cloudflare account.
worker_exists() {
  local name="$1" edge_dir="$2"
  (cd "$edge_dir" && npx wrangler deployments list --name "$name" >/dev/null 2>&1)
}

# Die when the Worker is missing unless create=1. wrangler otherwise creates it silently.
require_worker() {
  local name="$1" edge_dir="$2" create="${3:-0}"
  if worker_exists "$name" "$edge_dir"; then return 0; fi
  [[ "$create" == 1 ]] && return 0
  die "Worker \"${name}\" was not found on this Cloudflare account (or wrangler is not logged in)." \
      "Check EDGE_WORKER_NAME/TAB_BASE_HOST and 'npx wrangler whoami'. For a first install pass --create."
}
