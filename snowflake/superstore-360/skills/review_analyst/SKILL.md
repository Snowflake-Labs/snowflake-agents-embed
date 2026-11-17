---
name: review_analyst
description: Assign Superstore sub-categories to a named four-quadrant sales-versus-sentiment matrix (Fix first / Protect / Monitor / Deprioritise). Only for explicit quadrant, matrix or prioritisation-framework requests.
instructions: |
  Use this skill ONLY when the user explicitly asks for the quadrant, the matrix,
  a 2x2, or a named prioritisation framework. The distinguishing output is the
  quadrant LABEL itself - "Fix first" / "Protect" / "Monitor" / "Deprioritise" -
  not the underlying numbers.

  Do NOT use it to answer which sub-categories sell well but review badly. That
  is a plain two-metric ranking, and Superstore_Analyst answers it in one call
  from TOTAL_SALES, AVG_RATING and PCT_NEGATIVE_REVIEWS. This description used to
  say "identify which ones are commercially important but poorly reviewed", which
  invited exactly that question and cost 143-225 seconds against roughly 25 for
  the Analyst, because the skill must start the code sandbox and re-fetch the
  data first. If you are not going to emit quadrant labels, you do not need this
  skill.

  Do not use it for a plain ranking ("top 5 sub-categories by sales") - the
  Superstore_Analyst tool answers that directly and more cheaply.

  Steps:

  1. Get the per-sub-category figures with Superstore_Analyst, asking for
     total sales, average review rating, percentage of negative reviews, and
     return count grouped by sub-category.

  2. Run quadrant.py against that result to classify each sub-category. It splits
     on the median of each axis, so the output is relative to this dataset rather
     than to an absolute rating threshold.

  3. Report the "Fix first" quadrant (high sales, low rating) in priority order.
     For the top two, call Review_Search filtered to that sub-category to quote
     what customers actually complain about, and cite the review titles.

  Always state the medians you split on. A sub-category called "poorly reviewed"
  without that reference point is not a claim the user can check.
---

# Review analyst

Superstore's commercial reporting and its customer-sentiment data live at
different grains: sales are line-item level, reviews are one row per review. A
sub-category can look healthy on revenue while quietly generating most of the
complaints, and that combination is invisible in either dataset alone.

This skill exists to make that overlap explicit and ranked, so the answer is
"here is where to act, and here is what customers said", not two separate tables
the user has to reconcile themselves.

## Axes

- **Commercial weight** — total sales in GBP.
- **Satisfaction** — average star rating, with percentage of 1-2 star reviews as
  the tie-breaker.

Both are split at the median across sub-categories, giving four quadrants:

| | Low sales | High sales |
|---|---|---|
| **High rating** | Niche, healthy | Protect |
| **Low rating** | Monitor | **Fix first** |

## Caveats to carry into the answer

- The review corpus is synthetic and ratings are correlated with returns,
  negative profit and heavy discounting in the source data. Treat it as
  directional, not as real voice-of-customer.
- Sales cover 2020-2023 across 15 European countries; currency is GBP.
- `SALES_PER_REVIEW` in the semantic view spans two grains. Do not use it as an
  axis here.
