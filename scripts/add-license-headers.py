#!/usr/bin/env python3
"""Idempotently prepend the Apache-2.0 header to tracked source files."""
import subprocess
import sys
from pathlib import Path

LINES = [
    "Copyright 2026 Snowflake Inc.",
    "SPDX-License-Identifier: Apache-2.0",
]
MARKER = "SPDX-License-Identifier"

SLASH = {".ts", ".tsx", ".mjs", ".js", ".css"}
HASH = {".sh", ".py", ".yml", ".yaml"}
DASH = {".sql"}


def header(ext: str) -> str | None:
    if ext in SLASH:
        return "".join(f"// {l}\n" for l in LINES) if ext != ".css" else "/* " + " | ".join(LINES) + " */\n"
    if ext in HASH:
        return "".join(f"# {l}\n" for l in LINES)
    if ext in DASH:
        return "".join(f"-- {l}\n" for l in LINES)
    return None


def main() -> int:
    files = subprocess.check_output(["git", "ls-files"], text=True).splitlines()
    changed = 0
    for f in files:
        p = Path(f)
        h = header(p.suffix)
        if h is None or "node_modules" in p.parts:
            continue
        text = p.read_text()
        if MARKER in text[:600]:
            continue
        if text.startswith("#!"):
            first, _, rest = text.partition("\n")
            text = f"{first}\n{h}{rest}"
        else:
            text = h + text
        p.write_text(text)
        changed += 1
    print(f"updated {changed} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
