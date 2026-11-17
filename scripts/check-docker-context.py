#!/usr/bin/env python3
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
"""Fail if a secret-like path would be sent as the Docker build context."""

from __future__ import annotations

import fnmatch
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKERIGNORE = ROOT / ".dockerignore"

FORBIDDEN_SUFFIXES = (".p8", ".pem", ".key", ".sqlite")


def load_dockerignore(path: Path) -> list[tuple[bool, str]]:
    """Return (negated, pattern) pairs in file order."""
    out: list[tuple[bool, str]] = []
    if not path.is_file():
        return out
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        negated = line.startswith("!")
        pat = line[1:] if negated else line
        pat = pat.lstrip("/")
        if pat.endswith("/"):
            pat = pat.rstrip("/")
        out.append((negated, pat))
    return out


def path_matches(pattern: str, rel: str) -> bool:
    if rel.startswith("./"):
        rel = rel[2:]
    name = rel.rsplit("/", 1)[-1]
    variants = {pattern}
    if pattern.startswith("**/"):
        variants.add(pattern[3:])
    if "/" not in pattern.strip("*"):
        variants.add("**/" + pattern)
    for pat in variants:
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(name, pat):
            return True
        if fnmatch.fnmatch(rel, "**/" + pat):
            return True
    return False


def ignored(rel: str, rules: list[tuple[bool, str]]) -> bool:
    """Last matching rule wins. A match on a parent directory excludes children."""
    parts = rel.split("/")
    prefixes = ["/".join(parts[:i]) for i in range(1, len(parts) + 1)]
    state = False
    for prefix in prefixes:
        for negated, pat in rules:
            if path_matches(pat, prefix):
                state = not negated
    return state


def is_forbidden(rel: str) -> bool:
    name = rel.rsplit("/", 1)[-1]
    if name.startswith(".env") and not name.endswith(".example"):
        return True
    if name == ".secrets" or "/.secrets/" in f"/{rel}/":
        return True
    return name.endswith(FORBIDDEN_SUFFIXES)


def main() -> int:
    rules = load_dockerignore(DOCKERIGNORE)
    hits: list[str] = []
    skip_dirs = {".git", "node_modules", "dist", ".wrangler"}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for name in filenames:
            full = Path(dirpath) / name
            rel = str(full.relative_to(ROOT)).replace(os.sep, "/")
            if ignored(rel, rules):
                continue
            if is_forbidden(rel):
                hits.append(rel)
    if hits:
        print("Docker context would include secret-like paths:", file=sys.stderr)
        for h in sorted(hits):
            print(f"  {h}", file=sys.stderr)
        return 1
    print("ok  docker context has no .env* / *.p8 / .secrets files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
