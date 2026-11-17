# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
"""Classify Superstore sub-categories into a sales-versus-sentiment quadrant.

Reads the Analyst result as JSON on stdin (a list of row objects, or an object
with a "rows"/"data" key) and writes the classification as JSON to stdout.

Column names are matched case-insensitively and by substring, because the exact
labels coming back from text-to-SQL vary between runs -- "TOTAL_SALES",
"total_sales_gbp" and "SUM(SALES)" all mean the same axis, and hard-coding one of
them makes the skill fail intermittently for no useful reason.

    cat analyst_rows.json | python quadrant.py
"""

import json
import statistics
import sys


def _pick(row, *candidates):
    """First key in `row` whose name contains any of `candidates`."""
    lowered = {k.lower(): k for k in row}
    for cand in candidates:
        for low, original in lowered.items():
            if cand in low:
                return original
    return None


def _to_float(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = str(value).replace(",", "").replace("£", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


def main() -> int:
    raw = json.load(sys.stdin)
    if isinstance(raw, dict):
        rows = raw.get("rows") or raw.get("data") or raw.get("results") or []
    else:
        rows = raw
    rows = [r for r in rows if isinstance(r, dict)]
    if not rows:
        json.dump({"error": "no rows supplied"}, sys.stdout)
        return 1

    probe = rows[0]
    k_name = _pick(probe, "sub_category", "subcategory", "sub-category", "category", "name")
    k_sales = _pick(probe, "sales", "revenue")
    k_rating = _pick(probe, "avg_rating", "average_rating", "rating")
    k_negative = _pick(probe, "negative", "pct_neg")

    missing = [label for label, key in
               (("sub-category", k_name), ("sales", k_sales), ("rating", k_rating))
               if key is None]
    if missing:
        json.dump({"error": f"could not find column(s) for: {', '.join(missing)}",
                   "columns_seen": list(probe)}, sys.stdout)
        return 1

    parsed = []
    for row in rows:
        sales = _to_float(row.get(k_sales))
        rating = _to_float(row.get(k_rating))
        if sales is None or rating is None:
            continue
        parsed.append({
            "sub_category": row.get(k_name),
            "sales": sales,
            "rating": rating,
            "pct_negative": _to_float(row.get(k_negative)) if k_negative else None,
        })

    if len(parsed) < 2:
        json.dump({"error": "need at least two usable rows to take a median"}, sys.stdout)
        return 1

    median_sales = statistics.median(p["sales"] for p in parsed)
    median_rating = statistics.median(p["rating"] for p in parsed)

    for p in parsed:
        high_sales = p["sales"] >= median_sales
        high_rating = p["rating"] >= median_rating
        if high_sales and not high_rating:
            p["quadrant"] = "Fix first"
        elif high_sales:
            p["quadrant"] = "Protect"
        elif high_rating:
            p["quadrant"] = "Niche, healthy"
        else:
            p["quadrant"] = "Monitor"

    # Worst rating first within the quadrant that matters, then most negative as
    # the tie-break, so the caller can read priority straight off the list.
    fix_first = sorted(
        (p for p in parsed if p["quadrant"] == "Fix first"),
        key=lambda p: (p["rating"], -(p["pct_negative"] or 0)),
    )

    json.dump({
        "medians": {"sales": round(median_sales, 2), "rating": round(median_rating, 3)},
        "counts": {q: sum(1 for p in parsed if p["quadrant"] == q)
                   for q in ("Fix first", "Protect", "Niche, healthy", "Monitor")},
        "fix_first_priority": fix_first,
        "all": sorted(parsed, key=lambda p: -p["sales"]),
    }, sys.stdout, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
