#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# Read keys from apps/teams/.env. Source this file; set ENV_FILE first. Sets no shell options.

# envval KEY — prints the value (quotes and CR stripped), empty if unset. The `|| true` is
# load-bearing: under `set -e` a grep that matches nothing would kill the caller.
envval() {
  local raw
  raw="$({ grep -iE "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" || true; } \
    | head -1 | sed 's/^[^=]*=[[:space:]]*//' | tr -d '\r' | sed 's/[[:space:]]*$//')"
  raw="${raw#\"}"; raw="${raw%\"}"; raw="${raw#\'}"; raw="${raw%\'}"
  printf '%s' "$raw"
}
