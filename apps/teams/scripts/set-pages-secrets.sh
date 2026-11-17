#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# set-pages-secrets.sh — deprecated. The edge moved from Cloudflare Pages to a Worker;
# use set-edge-secrets.sh. This shim forwards to it so existing runbooks keep working.
set -euo pipefail
echo "set-pages-secrets.sh is deprecated; running set-edge-secrets.sh" >&2
exec bash "$(dirname "${BASH_SOURCE[0]}")/set-edge-secrets.sh" "$@"
