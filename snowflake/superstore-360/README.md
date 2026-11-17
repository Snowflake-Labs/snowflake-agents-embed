# Superstore 360 — a maximal-capability Cortex Agent

`SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT` turns on every Cortex Agent capability
this account supports, so that the Teams tab, the
server and the SSE parser are driven by **real** events instead of fixtures.

## Why this exists

`SUPERSTORE.PUBLIC.SUPERSTORE_SALES_AGENT` — the simple baseline agent —
has exactly one tool:

```json
{"tools":[{"tool_spec":{"type":"cortex_analyst_text_to_sql","name":"Superstore_Analyst"}}],
 "skills":[]}
```

So a large amount of client code had never seen a real payload.
`packages/chat-core/src/api/sseParser.ts` parses `response.chart`, `response.table`,
`response.text.annotation`, `ask_user_question` and `permission_decision`; none of
those could occur, because no configured tool emitted them.

`SUPERSTORE_SALES_AGENT` is left **completely untouched** as the regression
baseline. `SHOW AGENTS IN ACCOUNT` may come back empty for it on a fresh account, since
it is not something `00_base_database.sql` recreates (see below). If you need it, build
it from `superstore_semantic_model.yaml` (see `deploy-baseline-semantic-model.sh`).

## What gets built

`00_base_database.sql` provisions `SUPERSTORE.PUBLIC` itself first — the
`ORDERS`/`PEOPLE`/`RETURNS` base tables (and the `_V` views everything below reads),
loaded from the CSVs committed under `data/`, so a brand-new account can deploy the
whole agent, not just the `AGENTS` add-on. The CSVs are synthetic: every customer,
product and manager is invented, and `node scripts/generate-data.mjs [seed]` rebuilds
them deterministically (default seed 360). Everything else is
in a new `SUPERSTORE.AGENTS` schema, so `SUPERSTORE.PUBLIC` and its
load-bearing grants stay frozen once seeded.

| Object | Type | Purpose |
|---|---|---|
| `PRODUCT_REVIEWS` | table, 2,974 rows | Synthetic review corpus keyed to real `PRODUCT_ID`s — one review per sampled order line |
| `REVIEW_SEEDS` | table, 680 rows | LLM-generated seed reviews (sub-category × rating × persona) |
| `ORDER_LINES` | table, 10,000 rows | `ORDERS_V` plus a `WAS_RETURNED` flag, so return rate is an order-line metric |
| `PRODUCTS` | table, 1,915 rows | Conformed product dimension |
| `REGIONS` | table, 3 rows | Conformed region dimension (also fixes a false key on `PEOPLE_V`) |
| `CUSTOMERS` | table, 795 rows | Conformed customer dimension |
| `DELIVERY_MODES` | table, 4 rows | Conformed delivery-mode dimension |
| `PRODUCT_REVIEWS_SEARCH` | Cortex Search service | Backs the `Review_Search` tool |
| `SUPERSTORE_360` | semantic view | 7 logical tables, 2 fact grains, 4 conformed dimensions, 36 dimensions, 7 facts, 31 metrics |
| `FORECAST_SALES`, `CUSTOMER_HEALTH_SCORE`, `SUMMARISE_PRODUCT_REVIEWS` | functions | The three `generic` tools |
| `SKILLS` | stage | Holds the `review_analyst` skill |
| `CAPABILITY_PROBE` | table | Which optional features this account accepts |
| `SUPERSTORE_DEMO_MCP` | Snowflake-managed MCP server | Wraps `Review_Search` + `Superstore_Analyst` as MCP tools — no external OAuth |
| `SUPERSTORE_360_AGENT` | agent | 8 tools, 6 types, + skills + MCP |

### Agent tool surface

| `tool_spec.type` | Name | Notes |
|---|---|---|
| `cortex_analyst_text_to_sql` | `Superstore_Analyst` | Points at a **semantic view**, not a stage YAML |
| `cortex_search` | `Review_Search` | `max_results: 1000`, `id_column` = a URL so citations are clickable |
| `data_to_chart` | `data_to_chart` | |
| `generic` | `forecast_sales` | OLS trend, returns OBJECT |
| `generic` | `customer_health_score` | RFM + returns + sentiment, returns OBJECT |
| `generic` | `summarise_product_reviews` | Wraps `AI_AGG` |
| `web_search` | `web_search` | |
| `code_execution` | `code_execution` | `permission_policy: always_allow` |

Plus top-level `skills: [review_analyst]` (STAGE source) and
`mcp_servers: [SUPERSTORE.AGENTS.SUPERSTORE_DEMO_MCP]` — a Snowflake-managed MCP
server this build creates and owns, not an external connector, so it needs no
OAuth and no account-specific setup.

## Running it

```bash
cd snowflake/superstore-360
./run-all.sh -c demo              # everything, idempotent
./run-all.sh -c demo --only 09    # just re-run the assertions
./run-all.sh -c demo --from 06    # resume from the agent onwards
FORCE_RESEED=1 ./run-all.sh -c demo --only 02   # regenerate the 680 LLM seeds
```

`02` skips regeneration when `REVIEW_SEEDS` is already populated, because
rebuilding it re-bills ~680 `AI_COMPLETE` calls. Everything else is
`CREATE OR REPLACE` / `IF NOT EXISTS`; two consecutive full runs both end in
`ALL CHECKS PASSED`.

### Check the semantic view for ambiguous synonyms

```bash
./check-synonyms.sh -c demo                                      # SUPERSTORE_360
./check-synonyms.sh -c demo SUPERSTORE.PUBLIC.SUPERSTORE_ANALYSIS # any view
```

Reproduces the warning Snowsight's semantic-view validator emits, by pulling
`SHOW SEMANTIC DIMENSIONS|FACTS|METRICS` and looking for one synonym claimed by two
columns of the same logical table. Exits non-zero on a finding, so it works in CI.
`09_verify.sql` asserts the same thing, so the pipeline fails on a regression.

### Drive the agent's own sample questions live

```bash
node test-sample-questions.mjs                  # all 8, sequential
node test-sample-questions.mjs --only 7         # one
node test-sample-questions.mjs --parallel       # faster, noisier latency
node test-sample-questions.mjs --agent SUPERSTORE.PUBLIC.SUPERSTORE_SALES_AGENT
```

Reads `sample_questions` from the **live spec** rather than a hardcoded list, so
editing `06_agent.sql` cannot leave the test measuring prompts the agent no longer
offers. Per question it records wall-clock total, time to first text delta, tool
calls, and which tool types fired; then grades the answer — empty, zero-tool-call
(i.e. invented rather than measured), a blocking `tool_result` error, or prose that
admits failure (`"repeating the same action without making progress"`).

This is the test that found everything below. `capture-events.mjs` asks questions
*I* wrote to force specific SSE events, and all 8 of those passed throughout. The
sample questions are what a user actually clicks first, and three of them were
broken — including one that consumed the entire 300-second budget and returned no
text at all. **A green test suite over questions you chose yourself is not
evidence.**

The harness also requires `verified_query_used: true` for every starter prompt
whose complete structured answer belongs in the semantic layer. This makes the
VQR repository observable end to end rather than merely checking that SQL exists
in a file.

### Verified-query coverage

`SUPERSTORE_SALES_AGENT` uses the version-controlled
`superstore_semantic_model.yaml`. All five of its starter prompts are VQRs. Upload
that source after editing it:

```bash
./deploy-baseline-semantic-model.sh demo
```

`SUPERSTORE_360_AGENT` stores VQRs in the `AI_VERIFIED_QUERIES` clause of
`04_semantic_view.sql`, so a normal `run-all.sh` rebuild preserves them.

| Agent | Starter prompt | Coverage |
|---|---|---|
| Sales | Total sales and profit by region | Full-answer VQR |
| Sales | Product-category revenue | Full-answer VQR |
| Sales | Segment sales and profitability | Full-answer VQR |
| Sales | Return rate by region | Full-answer VQR |
| Sales | Quarterly sales trends for 2023 | Full-answer VQR |
| 360 | Sub-category sales, ratings and returns | Full-answer VQR |
| 360 | Region sales/profit and 2023 quarterly trend | Full-answer VQR |
| 360 | Why customers dislike bookcases | Search, not semantic SQL |
| 360 | Top products by revenue and rating | Full-answer VQR |
| 360 | North six-month projection | `forecast_sales`, not semantic SQL |
| 360 | Highest-spending customer health and reviews | Analyst lookup plus generic tool and Search |
| 360 | Regional return and negative-review rates | Full-answer VQR |
| 360 | Worst delivery-mode sentiment | Full-answer VQR |

Validate the baseline YAML's VQRs with Agent Studio, rebuild the 360 view, run
`09_verify.sql`, and then drive both live agents:

```bash
cortex agent-studio backend --tool validate_verified_queries \
  --parameters '{"semantic_model_file":"@SUPERSTORE.PUBLIC.SEMANTIC_MODELS_STAGE/superstore_semantic_model.yaml","warehouse":"XSMALL","is_semantic_view":false}' \
  --connection demo
./run-all.sh -c demo --only 04
./run-all.sh -c demo --only 08   # CREATE OR REPLACE drops semantic-view grants
./run-all.sh -c demo --only 09
node test-sample-questions.mjs --agent SUPERSTORE.PUBLIC.SUPERSTORE_SALES_AGENT
node test-sample-questions.mjs --agent SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT
```

Non-blocking validation errors are counted separately from blocking ones, because
Cortex distinguishes them: a `tool_result` can carry an error object alongside
`execution_status: "SQL was executed despite N non-blocking validation error(s)"`,
meaning the query ran and the agent got its data.

### Sample-question results, run by run

Wall clock from a laptop outside the account region, so treat the absolute numbers
as an upper bound and compare runs. `err` counts **blocking** `tool_result` errors.

| | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | clean | slowest |
|---|---|---|---|---|---|---|---|---|---|---|
| **1. as first built** | 225s | 45s | 48s | 27s | 17s | 45s | **300s ✗** | 109s | 5/8¹ | **300s** |
| 2. data + model fixed | 143s | 44s | 72s | 49s | 16s | 103s | 35s | 43s | 4/8 | 143s |
| 3. naming rule, wrong | 83s | 46s | 65s | 37s | 16s | 67s | **191s** | 43s | 3/8 | 191s |
| 4. naming rule, right | 89s | 41s | 34s | 35s | 17s | 41s | 39s | 43s | 5/8 | 89s |
| **5. metrics scoped** | **74s** | 44s | 46s | 39s | **17s** | 53s | 39s | 50s | **6/8** | **74s** |

¹ Run 1's 5/8 is generous: Q6 was counted clean while reporting a customer spend
**4.7× too high** (finding 12). Nothing in the harness or in `09_verify` could see
it, which is the whole reason value assertions now exist.

Blocking errors across all eight questions: **10 → 22 → 3 → 2**. The 22 is run 3,
where a plausible-but-wrong instruction ("always table-qualified") made things
markedly worse than no instruction at all — see finding 19.

The two remaining errors are both the outside-the-clause case, retried and
self-corrected within the same turn. **Every figure in all eight final answers was
verified against direct SQL and matched exactly**, including the four in Q6 that
were previously wrong. Q7 now volunteers that the two dissatisfaction signals move
in opposite directions across regions — Central worst on returns (6.32%) but *best*
on sentiment (18.30% negative) — which is the kind of finding the question was
written to surface and which it could not answer at all before.

### Capture the SSE event inventory

```bash
node capture-events.mjs                     # all 8 cases
node capture-events.mjs --only hybrid       # one case
```

Hits the public `:run` endpoint directly with `SNOWFLAKE_PAT`, bypassing our server
and edge, so a failure is Cortex's rather than ours. Full transcripts go to
`temp/superstore-360-events.json`.

Each case asserts three things: the event/tool types it was designed to provoke
**appeared**, the turn stayed **within a tool-call budget**, and there were **no
named-argument contract errors**. The budget is not cosmetic — a broken tool
contract shows up as call-count inflation while the prose still reads fine, so
counting calls is what makes it visible.

### Tool-call counts, before and after tightening

Two rounds of change: fixing the `input_schema` name contract (see finding 0), then
tightening `instructions.orchestration` to forbid re-deriving a tool's output and
to state that `data_to_chart` cannot chart JSON.

| case | before | after contract fix | final | budget | named-arg errors |
|---|---|---|---|---|---|
| `hybrid` | 6 | 6 | 9 | 10 | 0 |
| `analyst_chart` | 4 | 4 | 4 | 7 | 0 |
| `search_citations` | 1 | 2 | 1 | 4 | 0 |
| **`generic_forecast`** | **20** | 6 | **2** | 7 | 10 → 0 |
| **`generic_health`** | **14** | 8 | **2** | 7 | 4 → 0 |
| `code_execution` | 3 | 3 | 3 | 8 | 0 |
| `skill` | 9 | 8 | 9 | 12 | 0 |
| `web_search` | 4 | 5 | 4 | 7 | 0 |
| **total** | **61** | 42 | **34** | | **14 → 0** |

Final run: 8/8 cases pass, every case inside budget, `capture-events.mjs` exits 0.
Tool-call counts vary a little run to run (the orchestrator is not deterministic),
which is why the budgets have headroom rather than pinning exact numbers.

`generic_health` went from **1 text delta and a loop-guard abort** —
*"I detected that I was repeating the same action without making progress"* — to a
194-delta complete answer off two tool calls. The 20 → 2 collapse on
`generic_forecast` is mostly the contract fix removing 12 failed retries, with the
chart constraint removing the remaining wasted calls.

## The data story

> Review text is LLM-generated, so exact counts and averages differ on every rebuild.
> This section describes the shape of the result, not fixed numbers. `09_verify.sql`
> asserts the properties that matter.

The corpus is only useful if it has a real answer in it, so `RATING` is **derived
from real signals** in `ORDERS_V`/`RETURNS_V` — returned order, negative profit,
heavy discount — rather than being random:

Returned orders get a clearly lower average rating than orders that were not
returned (`09_verify.sql` requires a gap of at least 1.0).

The rating distribution is roughly bell-shaped, whereas real review distributions
are usually J-shaped (a big pile of 5-stars). That is a direct consequence of
deriving rating from returns/profit/discount rather than sampling a realistic
prior, and it is the right trade here because the *correlation* is what the demo
needs. Don't cite this corpus as representative of real review behaviour.

That gap is what makes the headline question answerable:

> *Which sub-categories have the highest sales but the worst review ratings, and
> are those the ones being returned?*

The answer is a table of `CATALOGUE_SUB_CATEGORY`, `TOTAL_SALES`, `AVG_RATING` and
`PCT_NEGATIVE_REVIEWS`, where the high-sales sub-categories with low ratings and high
negative-review rates are the ones to fix first.

`09_verify.sql` asserts the returned-vs-not rating gap stays ≥ 1.0, because if that
correlation ever breaks, every object still exists and the demo is quietly hollow.
It also asserts `TOTAL_DISCOUNT_GBP` is at least 2% of sales, which is what catches
a regression to summing the raw 0-1 rate.

Asked *"how much discount did we give in total, and what would our margin have been
without discounting?"*, the agent finds `estimated_discount_gbp` unaided, reproduces
both figures exactly, and volunteers that the margin uplift is an upper bound because it
ignores price elasticity.

## Things that cost real debugging time

Recorded because none of them are guessable from the docs, and each produced a
misleading error.

0. **A `generic` tool's `input_schema` property names must equal the SQL
   function's parameter names, exactly.** The agent invokes generic tools with
   **named** arguments taken from `input_schema` — never positionally. Our UDF
   parameters were `P_*` (to stop them shadowing column names) while the schema
   said `customer_id`/`region`/`months`, so *every* generic-tool call failed with:

   ```
   named arguments [CUSTOMER_ID] do not match any signature
   for function SUPERSTORE.AGENTS.CUSTOMER_HEALTH_SCORE
   ```

   This is the worst failure mode in the whole build, because it does not look
   like a failure. The orchestrator retried, fell back to hand-writing SQL that
   reimplemented the tool, and eventually tripped its own loop guard —
   *"I detected that I was repeating the same action without making progress, so
   I've stopped to avoid looping."* The turn still returned fluent prose. From the
   outside it read as a slow, over-eager agent; it was a broken contract.

   Measured: 10 failed calls in the forecast case, 4 in the health case, and
   **zero successful generic-tool invocations** across the whole baseline.

   It survived initial testing because `05`'s smoke tests called the functions
   **positionally**, which works fine. They now use named arguments, and
   `09_verify.sql` additionally compares `input_schema` property names against
   `INFORMATION_SCHEMA.FUNCTIONS.ARGUMENT_SIGNATURE`. That assertion was
   negative-tested by deliberately renaming a parameter, and it fails as intended.

0b. **`data_to_chart` can only chart a SQL result set.** Handed a `generic` tool's
   OBJECT output it fails with `no named result sets found for tool result`, and
   when it does emit a spec the data is nonsense — a column literally named
   `SUPERSTORE.AGENTS.FORECAST_SALES(P_MONTHS => ?, P_REGION => ?)` holding the raw
   JSON string. Cortex suppresses the broken chart rather than streaming it (0
   `response.chart` events), so nothing corrupt reaches the UI — but the agent
   burns half its turn discovering this. The orchestration instructions now say so
   explicitly.

0c. **Facts and their aggregate metrics were fighting over synonyms — and the
   discount column was mismodelled as money.** Snowsight's validator flagged 8
   synonyms claimed twice within one logical table, e.g. `revenue` on both
   `SALES_AMOUNT` (fact) and `TOTAL_SALES` (metric). This is a quiet quality
   problem rather than an error: Analyst still answers, it just may bind the word
   to the row-level fact instead of the aggregate and return a plausible wrong
   number. The rule now applied throughout is **bare business word → aggregate
   metric**, with facts keeping only explicitly line-level wording
   (`line sales`, `line profit`).

   Six of the eight were inherited from `SUPERSTORE_ANALYSIS`, which is left
   untouched as the baseline and still has them — `./check-synonyms.sh -c demo
   SUPERSTORE.PUBLIC.SUPERSTORE_ANALYSIS` shows all six.

   Chasing the `discount` collision turned up something worse. `ORDERS_V.DISCOUNT`
   is a **rate** (0.00–0.85, mean 0.103), but the inherited model exposed it as a
   fact called `DISCOUNT_AMOUNT` and summed it:

   | metric | before | after |
   |---|---|---|
   | `TOTAL_DISCOUNT` | the sum of 10,000 percentages (about 1,000) | `TOTAL_DISCOUNT_GBP`, a sum in pounds |
   | `NET_REVENUE` | GBP revenue minus a sum of rates, labelled "actual revenue" | replaced by `LIST_PRICE_SALES` |
   | `GROSS_PROFIT_MARGIN` | rates added to pounds | `MARGIN_BEFORE_DISCOUNT`, well above the actual margin |

   The fact is now `DISCOUNT_RATE` (rate synonyms only) plus a derived
   `ESTIMATED_DISCOUNT_GBP`. That derivation rests on an **assumption stated in the
   DDL**: `SALES` is net of discount, so discount given = `sales × rate / (1 − rate)`.
   If that convention is wrong for this dataset, one comment block and one
   expression need changing, not the whole model.

   The result is also a better demo: discounting cuts the margin sharply
   and the discount given away is comparable to the profit earned.

1. **`ALTER AGENT … SET SPECIFICATION` needs the `=`.** `CREATE AGENT` is
   `FROM SPECIFICATION <spec>` with no equals sign; `ALTER` is
   `SET SPECIFICATION = <spec>`. Omitting it gives a syntax error pointing at the
   start of the spec, which reads as though the spec were malformed.

2. **The spec must be dollar-quoted, never a single-quoted literal.** Snowflake
   interprets backslash escapes inside single-quoted strings, so `TO_JSON`'s `\"`
   and `\n` reach the parser as a bare quote and a real newline, corrupting the
   JSON. The symptom is a bafflingly selective `agent spec is invalid`:
   `instructions.response` round-trips fine while `instructions.system` and
   `instructions.orchestration` fail — purely because only the latter two happen to
   contain double quotes. Build the delimiter with `CHR(36)||CHR(36)` inside a
   scripting block.

3. **`SET SPECIFICATION` replaces the whole spec.** Omitted keys are deleted, so
   `07` reads the current spec via `DESCRIBE AGENT`, merges, and writes the entire
   document back. `09` asserts all six GA tools survived, because getting this
   wrong silently strips them.

4. **Custom dollar-quote tags do not exist.** `$CAP$ … $CAP$` is a syntax error;
   only `$$` works. And writing `$$` anywhere inside a `$$`-quoted block — *even in
   a comment* — terminates the block.

5. **The `skills` spec entry takes no `description`.** The docs show one; this
   account rejects it with `unrecognized field description`. The description lives
   in `SKILL.md` frontmatter.

6. **`GRANT USAGE ON MCP SERVER`, not `EXTERNAL MCP SERVER`.** Snowflake-managed
   (`CREATE MCP SERVER`, what `SUPERSTORE_DEMO_MCP` is) and remote-connector
   (`CREATE EXTERNAL MCP SERVER`, for something like a Jira or GitHub connector)
   are distinct object types with distinct grant keywords. The wrong keyword
   fails with `Agent Server '<name>' does not exist or not authorized`, which
   reads like a missing object rather than a wrong keyword. Only relevant again
   if this build grows an external connector — see `github_mcp_optional.sql`.

7. **A semantic-view `RELATIONSHIP` may only target a primary/unique key.**
   `REVIEWS(PRODUCT_ID) REFERENCES ORDERS(PRODUCT_ID)` is rejected outright, which
   is why `PRODUCTS` exists as a conformed dimension both fact tables point at.

8. **SQL UDF arguments shadow column names.** An argument named `region` makes
   `WHERE REGION = region` always true, silently returning the whole table instead
   of one region — plausible wrong numbers, not an error. Every argument here is
   prefixed `P_`, and `09` asserts `FORECAST_SALES('North', …)` differs from
   `FORECAST_SALES(NULL, …)` to catch a regression.

9. **`ROUND()` on a DOUBLE stays a DOUBLE**, and JSON-serialises as `9.83e+04`.
   Cast to `NUMBER(18,2)` or the agent reads scientific notation and reformats it.

10. **Ground LLM generation with real examples.** Asked to review the `Art`
    sub-category, the model wrote about *"digital art software"*, which then got
    stapled onto a box of highlighters. Passing the parent category plus three real
    product names fixed the referent.

11. **A Snowflake Scripting `FOR … IN (SELECT …)` cursor variable cannot be
    referenced inside a nested query** — it fails at compile time as
    `invalid identifier 'T.WANTED'`. Loop over an `ARRAY` with `GET()` instead.

12. **`LEFT JOIN RETURNS_V` fans out, and it is not obvious.** `RETURNS_V` holds
    **637 rows across only 284 distinct `ORDER_ID`s** — one `SP-20920` order fans to
    81 rows. Joining it before aggregating multiplies every money figure. This was
    live in three places at once:

    | Where | Symptom |
    |---|---|
    | `CUSTOMER_HEALTH_SCORE` | reported **£78,564.99** lifetime spend for `SP-20920` against a true **£16,564.15** |
    | `02_synthetic_reviews.sql` | produced **3,460** reviews from ~3,000 sampled lines, all surplus on *returned* orders |
    | `04_semantic_view.sql` | not affected — `ORDERS_TO_RETURNS` targets the declared key |

    The health-score case is the instructive one. The object shape was right, every
    field was populated, and the band stayed `"Healthy"` — because the monetary
    component caps at 25 points and £16.5k already exceeded the cap, so *no derived
    value moved*. `09` asserted only that `band` was non-null, so it passed on every
    run while the agent told users a number that was 4.7× too high. Fix is `EXISTS`
    or a separate `COUNT(DISTINCT …)`, never a join before a `SUM`.

13. **Snowflake does not enforce `PRIMARY KEY`, so a semantic view will happily
    trust a false one.** The view declared `PRIMARY KEY (REGION)` on `PEOPLE_V`,
    which has **6 rows for 3 regions** — a manager name *and* an email address each.
    Totalling sales by manager returned **£5,874,120** against a true **£2,938,091**.
    Nothing complained, because the key is advisory metadata. The generalised test is
    cheap: grouping by a dimension must not change the grand total, and `09` now
    asserts that across every dimension at once. Negative-tested by `INSERT`ing a
    duplicate region row — which succeeds despite the `PRIMARY KEY`, and is exactly
    why this class of bug survives.

14. **One conformed dimension is not enough — a shared key must reach *both* fact
    tables.** With `PRODUCTS` as the only bridge between `ORDERS` and `REVIEWS`,
    cross-grain questions worked by sub-category and were **rejected outright**
    otherwise:

    ```
    DIMENSIONS PRODUCTS.CATALOGUE_SUB_CATEGORY  METRICS TOTAL_SALES, AVG_RATING   -> ok
    DIMENSIONS ORDERS.REGION                   METRICS TOTAL_SALES, AVG_RATING   -> error
    DIMENSIONS ORDERS.CUSTOMER_ID               "                                -> error
    DIMENSIONS ORDERS.DELIVERY_MODE             "                                -> error
      The entities 'ORDERS' and 'REVIEWS' are not related.
    ```

    That gap was invisible to every SQL assertion — the one smoke test happened to
    group by sub-category — and only surfaced by driving the agent's **own sample
    questions** live. Adding `REGIONS`, `CUSTOMERS` and `DELIVERY_MODES` fixed it.

15. **A metric is only reachable from dimensions related to *its own* table.**
    Defining `RETURN_RATE` from a `RETURNS`-table metric put it out of reach of every
    conformed dimension: `the dimension entity 'REGIONS' is not directly related to
    the base metric entity 'RETURNS'`. `RETURNS` is reachable only from `ORDERS`.
    Fixed by denormalising `WAS_RETURNED` onto the order line (`ORDER_LINES`) so
    return rate became an `ORDERS`-grain metric, sliceable by anything.

16. **Reaching an order attribute through a product dimension silently destroys the
    signal.** "Which delivery mode has the worst sentiment" via `PRODUCTS` averages
    every review of a product against every mode that product ever shipped by:

    | grain | Second Class | Same Day | spread |
    |---|---|---|---|
    | product (via `PRODUCTS`) | 3.01 | 3.06 | **0.05 — noise** |
    | order line (denormalised) | 2.92 | 3.19 | **0.27 — real** |

    Both return a confident ranked table. Only one means anything. Fixed by carrying
    `DELIVERY_MODE` onto `PRODUCT_REVIEWS`.

17. **`CREATE OR REPLACE AGENT` drops every `USAGE` grant on the agent.** Re-running
    `06` without re-running `08` leaves both AGENTS roles unauthorised, and the client
    sees `HTTP 401 "the agent does not exist or access is not authorized"` — which
    reads like a bad token or a mistyped FQN, not a missing grant. `run-all.sh` orders
    the steps correctly; a hand-run of `06` will not. `09` now asserts the grant
    explicitly, because a *symmetric* loss passes the role-parity check. Note the
    `granted_on` value is **`CORTEX_AGENT`**, not `AGENT`.

19. **Whether a semantic-view name must be qualified depends on where it appears,
    and this caused more wasted tool calls than anything else.** Inside the
    `SEMANTIC_VIEW(...)` clause names must be **table-qualified**; in the enclosing
    `SELECT` / `WHERE` / `ORDER BY` they must be **bare**:

    ```sql
    SELECT ORDERS.TOTAL_SALES FROM SEMANTIC_VIEW(... METRICS ORDERS.TOTAL_SALES)
    -- invalid identifier 'ORDERS.TOTAL_SALES'
    SELECT TOTAL_SALES        FROM SEMANTIC_VIEW(... METRICS ORDERS.TOTAL_SALES)
    -- 42450.90
    ```

    Every identifier error observed across four live runs was this one rule, in one
    direction or the other — `invalid identifier 'O.RETURN_RATE'`,
    `'P.CATALOGUE_SUB_CATEGORY'`, `'R.AVG_RATING'`, bare `'CATALOGUE_SUB_CATEGORY'`
    inside the clause, and `'ORDERS.TOTAL_SALES'` outside it. Worth stressing that an
    intermediate lesson was wrong: an early `instructions.orchestration` fix said
    "always use table-qualified names", which fixed the inside case and **broke the
    outside case**. Measured cost of that wrong instruction, on the one question the
    conformed dimensions had just fixed:

    | `instructions.orchestration` | Q7 total | tool calls | blocking errors |
    |---|---|---|---|
    | no naming guidance | 34.9s | 2 | 0 |
    | "always table-qualified" (wrong) | **191.4s** | **22** | **15** |

    A plausible-sounding instruction made the agent six times slower. The rule had to
    be stated positionally, with a worked example, before the retries stopped — which
    is also why the instruction text is now asserted against a live `DESCRIBE AGENT`
    before any timing run is trusted.

    There is a second layer to it. A metric declared **without** a table prefix
    becomes *view-level* and must then be referenced **bare even inside the clause**,
    while its table-scoped neighbours must be qualified. Nine inherited metrics were
    view-level, and `PCT_NEGATIVE_REVIEWS` alone accounted for the last blocking
    error in three of eight questions — the agent qualified it, which is the obvious
    thing to do when every adjacent metric requires that, and got
    `invalid identifier 'REVIEWS.PCT_NEGATIVE_REVIEWS'`. Fixed by scoping all eight
    single-table metrics to their table so the rule is uniform, rather than
    documenting the exception. `SALES_PER_REVIEW` genuinely spans `ORDERS` and
    `REVIEWS`, so it stays view-level and is the one named exception in the
    instructions.

    None of this corrupted an answer — Analyst retried and recovered every time, and
    all figures were verified correct against direct SQL. It cost latency, which is
    why it was invisible until wall-clock time was measured.

18. **An `input_schema` name mismatch is not the only silent tool contract.** A
    skill's own `description` competes with `instructions.orchestration`. The
    `review_analyst` description said it would *"identify which ones are commercially
    important but poorly reviewed"* — which is verbatim sample question 1 — so the
    orchestrator loaded the sandbox for a question one Analyst call answers, turning
    a ~25s answer into **143–225s**. Telling the agent not to do that in
    `instructions.orchestration` was not enough; the skill description had to stop
    advertising it.

20. **`COMMIT` alone does not make a change visible.** `MODIFY LIVE VERSION SET
    SPECIFICATION` edits the mutable `LIVE` version; `COMMIT` snapshots it into a
    new immutable `VERSION$N`. Neither one moves `DEFAULT` — and `DESCRIBE AGENT`,
    every unversioned agent call, and `09_verify.sql` all resolve to `DEFAULT`, not
    `LIVE` or the newest `VERSION$N`. A commit that never repoints `DEFAULT` looks
    identical to a no-op: the run reports success, but every unversioned caller
    keeps serving the old spec. `07_agent_optional.sql` and `github_mcp_optional.sql`
    now follow every `COMMIT` with `ALTER AGENT … SET DEFAULT_VERSION = 'LAST'`.
    Check with `SHOW VERSIONS IN AGENT …` — the `is_default` column, not the
    version count, is the thing to trust.

## Grants

`08_grants.sql` grants `AGENTS_TEAMS_USER` access from one statement list.
`09_verify.sql` checks the role's real-time `SHOW GRANTS` output for the agent and
semantic view grants.

Verified per role, as the role:

- `SHOW AGENTS IN ACCOUNT` returns both Superstore agents (51 agents visible)
- the semantic view returns all 17 sub-categories
- `FORECAST_SALES` returns a region-specific trend
- `PRODUCT_REVIEWS` is readable

Three non-obvious grant facts, all commented in the file:

- **`SELECT ON SEMANTIC VIEW` is not sufficient** — agents also need `SELECT` on
  the tables the view reads.
- **Cortex Agents resolve permissions from the user's DEFAULT role**, not the
  active one, and that role needs a default warehouse with `USAGE`.
- **Verify grants directly, never infer them from a working turn.** Several of
  these failures are invisible at run time.

## Client-side gaps, from observed payloads

Every item below was found by running `capture-events.mjs` against the live agent
and reading `temp/superstore-360-events.json` — not from the docs. Nothing in
`packages/` has been changed; this is the input to that follow-on work.

Line references are against `packages/chat-core/src/api/sseParser.ts`, which is where
SSE parsing lives. All four findings were verified against that code.

### 1. Citations are parsed at the wrong nesting — visibly broken

`packages/chat-core/src/api/sseParser.ts:88`:

```ts
case 'response.text.annotation':
  return { kind: 'annotation', index: d.index ?? 0, docTitle: d.doc_title, url: d.url }
```

The actual payload:

```json
{"annotation": {"doc_id": "https://reviews.superstore.example/r/002777",
                "doc_title": "Adequate bookcase but assembly instructions lacking",
                "index": 652,
                "search_result_id": "cs_ec48fc32-…",
                "text": "Ordered the Bush Stackable Bookrack, Traditional. …"}}
```

So `d.doc_title`, `d.index` and `d.url` are all `undefined`. Every citation renders
with **no title, no link, and index 0** — and `url` does not exist at the API at
all; the URL arrives as `doc_id`. The fix is the same tolerant-nesting idiom the
file already uses elsewhere (`d.thinking?.text ?? d.text`, `d.metadata ?? d`):

```ts
const a = d.annotation ?? d
return { kind: 'annotation', index: a.index ?? 0,
         docTitle: a.doc_title, url: a.doc_id ?? a.url, text: a.text }
```

This is why the `id_column: REVIEW_URL` choice matters — Cortex is already handing
us a clickable URL and we drop it.

### 2. `response.tool_use.status` is not handled at all

Observed 2-4× per full run (in the tool-heavy cases). There is no `case` for it in
`parseSseEvent`, so it falls to `default: return null` and is discarded. It is the
per-tool-call progress signal, i.e. exactly the narration the UI derives from
`response.tool_result.status`.

### 3. `response.warning` is recognised but its payload is thrown away

`sseParser.ts:129` is `return { kind: 'warning' }` — no `code`, no `message`.
Observed on **every single turn** (8/8), carrying:

```
003001  User authentication required for MCP server
        'DEMO_DB.AGENTS.JIRA_MCP'.
        Complete OAuth flow to access all tools.
```

Worth correcting an assumption in the plan: a missing/unauthorised MCP server does
**not** fail silently — Cortex tells us, clearly and actionably. *We* are the ones
losing the message. Surfacing `code`/`message` would turn an invisible dead tool
into a "click here to connect Jira" prompt.

This finding came from `DEMO_DB.AGENTS.JIRA_MCP`, an external
connector this build no longer wires in by default (replaced by the native,
OAuth-free `SUPERSTORE_DEMO_MCP` — see "What gets built" above). The bug in
`sseParser.ts` is still real and still worth fixing; reproducing the 003001
warning itself now needs an external MCP server attached, which
`github_mcp_optional.sql` sets up using a free, self-service GitHub OAuth App
instead of an account-specific dependency.

### 4. Real tool types missing from `toolLabel.ts`

`toolLabel.ts` knows 6 tool types (5 plus `schedule_snowflake_task`, added by a
later phase). Observed in real streams:

Counts are from the final 8-case run (34 tool calls total).

| Tool type | Seen | In `toolLabel`? | Renders as |
|---|---|---|---|
| `data_to_chart` | 7 | yes | "Generating visualization..." |
| `server_skill` | 6 | **no** | "Running server_skill..." |
| `system_agentic_semantic_context` | 6 | **no** | "Running system_agentic_semantic_context..." |
| `system_execute_sql` | 6 | yes | "Executing SQL..." |
| `cortex_search` | 4 | yes | "Searching Cortex Search..." |
| `bash` | 2 | **no** | "Running bash..." |
| `forecast_sales` (`generic`) | 1 | **no** | "Running forecast_sales..." |
| `customer_health_score` (`generic`) | 1 | **no** | "Running customer_health_score..." |
| `web_search` | 1 | **no** | "Running web_search..." |

Two things worth knowing beyond the missing labels:

- **`code_execution` never appears as a tool type.** It is configured as
  `code_execution` in the spec but surfaces in the stream as **`bash`** (plus
  `server_skill` when a skill is loaded). This is the same
  spec-name-vs-stream-name split already documented for
  `cortex_analyst_text_to_sql` → `system_execute_sql`. Our capture script's
  original expectations were wrong here, not the agent.
- **`generic` tools surface under their own name**, not as `generic`, because
  the parser resolves `d.type ?? d.name`. Convenient, but it means the label
  map can never be complete — it needs a sensible fallback, e.g. humanising the
  name rather than `Running <raw>...`.

### 5. Untested, and why

`ask_user_question` and `permission_decision` never fired — expected, since every
tool here is read-only and `code_execution` uses
`permission_policy: always_allow`. The permission-prompt fallback UI remains unexercised;
covering it needs a side-effecting tool, which was explicitly out of scope.



## Deliberately out of scope

- `permission_decision` / `ask_user_question` stay unexercised — both need a
  side-effecting tool, and this build is read-only by decision.
- No email tool (`SYSTEM$SEND_EMAIL` wrapper), no write-back procedure, no
  external-API UDF.
- No `agent_toolset` composition agent (the capability probe confirms this
  account accepts it, so it's a small addition).
- Not exercised here (availability varies by account): `code_toolset_all` / Coding Agent, `CORTEX_EXTENSION` skills.
- Further corpora (support tickets, staged policy PDFs via `AI_PARSE_DOCUMENT`,
  rep call notes).
- All client-side rendering work — see the gap analysis above.
