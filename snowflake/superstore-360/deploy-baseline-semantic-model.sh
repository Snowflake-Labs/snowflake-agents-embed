#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# Upload the version-controlled semantic model used by SUPERSTORE_SALES_AGENT.
set -euo pipefail

cd "$(dirname "$0")"

CONN="${1:-demo}"
snow stage copy superstore_semantic_model.yaml \
  @SUPERSTORE.PUBLIC.SEMANTIC_MODELS_STAGE/ \
  -c "$CONN" --overwrite --no-auto-compress
