#!/usr/bin/env python3
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
"""Fail if a Teams Dockerfile drops a required source COPY or USER node."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REQUIRED = {
    ROOT / "apps/teams/Dockerfile": (
        "packages/chat-core/src",
        "packages/cortex-server/src",
        "USER node",
    ),
    ROOT / "apps/teams/edge.Dockerfile": (
        "packages/cortex-server/src",
        "packages/teams-edge/src",
        "USER node",
    ),
}


def main() -> int:
    failed = False
    for path, needles in REQUIRED.items():
        text = path.read_text()
        for needle in needles:
            if needle not in text:
                print(f"{path.relative_to(ROOT)}: missing {needle!r}", flush=True)
                failed = True
    if failed:
        return 1
    print("ok  Dockerfiles COPY source-only packages and USER node")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
