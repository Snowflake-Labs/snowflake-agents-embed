-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Custom tools, exposed to the agent as tool_spec type "generic".
--
-- This is the escape hatch for everything Snowflake does not ship as a native
-- agent tool. All three are READ-ONLY scalar functions, so no permission_decision
-- prompt is expected from them (see the README for what that leaves untested).
--
-- Every argument is prefixed P_ for a reason that is not cosmetic. A SQL UDF
-- argument named `region` shadows the column `REGION`, so `WHERE REGION = region`
-- compiles happily, is always true, and silently returns the whole table instead
-- of one region. That mistake produces plausible wrong numbers rather than an
-- error, which is the worst kind. Prefixing removes the collision entirely.
--
-- Scalar functions returning OBJECT/ARRAY rather than table functions: `generic`
-- tool_resources take type `function` or `procedure`, and a UDTF's fit there is
-- not documented. A scalar function returning semi-structured data is
-- unambiguous, and it also exercises how the agent narrates non-tabular output.

-- ---------------------------------------------------------------------------
-- FORECAST_SALES - trend extrapolation over monthly history
-- ---------------------------------------------------------------------------
-- Ordinary least squares via REGR_SLOPE/REGR_INTERCEPT rather than
-- SNOWFLAKE.ML.FORECAST: the latter needs a model object to be created, which is
-- a write, and this whole layer is deliberately read-only.
CREATE OR REPLACE FUNCTION SUPERSTORE.AGENTS.FORECAST_SALES(
  P_REGION VARCHAR,
  P_MONTHS NUMBER
)
RETURNS OBJECT
COMMENT = 'Linear-trend sales forecast for a region (or all regions when P_REGION is null), up to 12 months ahead. Read-only.'
AS
$$
WITH hist AS (
  SELECT DATE_TRUNC('month', ORDER_DATE) AS M, SUM(SALES) AS S
  FROM SUPERSTORE.PUBLIC.ORDERS_V
  WHERE P_REGION IS NULL OR REGION = P_REGION
  GROUP BY 1
),
idx AS (
  SELECT M, S, ROW_NUMBER() OVER (ORDER BY M) AS T FROM hist
),
fit AS (
  SELECT REGR_SLOPE(S, T)     AS SL,
         REGR_INTERCEPT(S, T) AS IC,
         COUNT(*)             AS N,
         MAX(M)               AS LAST_M,
         AVG(S)               AS AVG_S
  FROM idx
),
horizon AS (
  SELECT COLUMN1 AS H
  FROM VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12)
)
SELECT OBJECT_CONSTRUCT(
  'region',              COALESCE(P_REGION, 'ALL REGIONS'),
  'currency',            'GBP',
  'method',              'ordinary least squares on monthly sales totals',
  'history_months',      f.N,
  'last_actual_month',   TO_VARCHAR(f.LAST_M, 'YYYY-MM'),
  'trend_gbp_per_month', ROUND(f.SL, 2)::NUMBER(18,2),
  'avg_monthly_sales',   ROUND(f.AVG_S, 2)::NUMBER(18,2),
  'forecast',            ARRAY_AGG(
                           OBJECT_CONSTRUCT(
                             'month', TO_VARCHAR(ADD_MONTHS(f.LAST_M, h.H), 'YYYY-MM'),
                             'forecast_sales_gbp', ROUND(f.IC + f.SL * (f.N + h.H), 2)::NUMBER(18,2)
                           )
                         ) WITHIN GROUP (ORDER BY h.H),
  'caveat',              'Linear extrapolation only. No seasonality, and the source data ends in 2023.'
)
FROM fit f, horizon h
-- Clamp instead of validating: the agent will pass whatever the user said, and an
-- out-of-range month count should degrade rather than error mid-turn.
WHERE h.H <= LEAST(GREATEST(COALESCE(P_MONTHS, 3), 1), 12)
GROUP BY f.N, f.SL, f.IC, f.LAST_M, f.AVG_S
$$;

-- ---------------------------------------------------------------------------
-- CUSTOMER_HEALTH_SCORE - RFM plus returns and sentiment
-- ---------------------------------------------------------------------------
-- Recency is measured against the latest order date in the dataset, not
-- CURRENT_DATE. The data stops at 2023-12-31, so "days since last order" against
-- today would make every customer look equally dormant and the score meaningless.
CREATE OR REPLACE FUNCTION SUPERSTORE.AGENTS.CUSTOMER_HEALTH_SCORE(
  P_CUSTOMER_ID VARCHAR
)
RETURNS OBJECT
COMMENT = 'Composite health score (0-100) for one customer from recency, frequency, spend, return rate and average review rating. Read-only.'
AS
$$
WITH bounds AS (
  SELECT MAX(ORDER_DATE) AS DATASET_END FROM SUPERSTORE.PUBLIC.ORDERS_V
),
-- Sales and profit are summed WITHOUT joining RETURNS_V. That join used to live
-- here and inflated every money figure: RETURNS_V holds 637 rows across only 284
-- distinct ORDER_IDs, so an order can fan out many times over (one SP-20920 order
-- fans to 81 rows) and SUM(o.SALES) then counts the same line repeatedly. It
-- reported £78,564.99 for SP-20920 against a true £16,564.15, and because the
-- shape of the object was right and the score still landed in a sensible band,
-- it read as correct in the agent's answer. Returns are counted separately below.
cust AS (
  SELECT
    o.CUSTOMER_ID,
    ANY_VALUE(o.CUSTOMER_NAME)     AS CUSTOMER_NAME,
    ANY_VALUE(o.SEGMENT)           AS SEGMENT,
    ANY_VALUE(o.REGION)            AS REGION,
    COUNT(DISTINCT o.ORDER_ID)     AS ORDERS,
    SUM(o.SALES)                   AS SALES,
    SUM(o.PROFIT)                  AS PROFIT,
    MAX(o.ORDER_DATE)              AS LAST_ORDER
  FROM SUPERSTORE.PUBLIC.ORDERS_V o
  WHERE o.CUSTOMER_ID = P_CUSTOMER_ID
  GROUP BY o.CUSTOMER_ID
),
-- DISTINCT first, so a duplicated return row cannot inflate the count either.
returned AS (
  SELECT COUNT(DISTINCT r.ORDER_ID) AS RETURNED_ORDERS
  FROM SUPERSTORE.PUBLIC.RETURNS_V r
  WHERE r.IS_RETURNED
    AND r.ORDER_ID IN (
      SELECT ORDER_ID FROM SUPERSTORE.PUBLIC.ORDERS_V
      WHERE CUSTOMER_ID = P_CUSTOMER_ID
    )
),
sentiment AS (
  SELECT AVG(RATING) AS AVG_RATING, COUNT(*) AS REVIEWS
  FROM SUPERSTORE.AGENTS.PRODUCT_REVIEWS
  WHERE CUSTOMER_ID = P_CUSTOMER_ID
),
scored AS (
  SELECT
    c.*,
    rt.RETURNED_ORDERS,
    s.AVG_RATING,
    s.REVIEWS,
    DATEDIFF(DAY, c.LAST_ORDER, b.DATASET_END)                      AS DAYS_SINCE_LAST_ORDER,
    rt.RETURNED_ORDERS / NULLIF(c.ORDERS, 0)                        AS RETURN_RATE,
    -- Four equally weighted components, each normalised to 0-25.
    GREATEST(0, 25 - DATEDIFF(DAY, c.LAST_ORDER, b.DATASET_END) / 14.6) AS RECENCY_PTS,
    LEAST(25, c.ORDERS * 2.5)                                       AS FREQUENCY_PTS,
    LEAST(25, c.SALES / 400)                                        AS MONETARY_PTS,
    GREATEST(0, 25 * (1 - rt.RETURNED_ORDERS / NULLIF(c.ORDERS, 0))) AS LOYALTY_PTS
  FROM cust c, bounds b, sentiment s, returned rt
)
SELECT OBJECT_CONSTRUCT(
  'customer_id',            P_CUSTOMER_ID,
  'customer_name',          CUSTOMER_NAME,
  'segment',                SEGMENT,
  'region',                 REGION,
  'health_score',           ROUND(RECENCY_PTS + FREQUENCY_PTS + MONETARY_PTS + LOYALTY_PTS, 1)::NUMBER(5,1),
  'band',                   CASE
                              WHEN RECENCY_PTS + FREQUENCY_PTS + MONETARY_PTS + LOYALTY_PTS >= 70 THEN 'Healthy'
                              WHEN RECENCY_PTS + FREQUENCY_PTS + MONETARY_PTS + LOYALTY_PTS >= 45 THEN 'Watch'
                              ELSE 'At risk'
                            END,
  'components',             OBJECT_CONSTRUCT(
                              'recency',   ROUND(RECENCY_PTS, 1)::NUMBER(5,1),
                              'frequency', ROUND(FREQUENCY_PTS, 1)::NUMBER(5,1),
                              'monetary',  ROUND(MONETARY_PTS, 1)::NUMBER(5,1),
                              'loyalty',   ROUND(LOYALTY_PTS, 1)::NUMBER(5,1)
                            ),
  'orders',                 ORDERS,
  'total_sales_gbp',        ROUND(SALES, 2)::NUMBER(18,2),
  'total_profit_gbp',       ROUND(PROFIT, 2)::NUMBER(18,2),
  'last_order_date',        TO_VARCHAR(LAST_ORDER, 'YYYY-MM-DD'),
  'days_since_last_order',  DAYS_SINCE_LAST_ORDER,
  'returned_orders',        RETURNED_ORDERS,
  'return_rate_pct',        ROUND(COALESCE(RETURN_RATE, 0) * 100, 1)::NUMBER(5,1),
  'reviews_written',        COALESCE(REVIEWS, 0),
  'avg_review_rating',      ROUND(AVG_RATING, 2)::NUMBER(5,2),
  'note',                   'Recency is measured against the last order date in the dataset (2023-12-31), not today.'
)
FROM scored
$$;

-- ---------------------------------------------------------------------------
-- SUMMARISE_PRODUCT_REVIEWS - AI_AGG over the corpus
-- ---------------------------------------------------------------------------
-- Deliberately overlaps with the Cortex Search tool. Search retrieves individual
-- reviews with citations; this collapses every review for one product into a
-- themed summary. Having both means the orchestration instructions have to
-- actually choose between them, which is a routing behaviour worth testing.
CREATE OR REPLACE FUNCTION SUPERSTORE.AGENTS.SUMMARISE_PRODUCT_REVIEWS(
  P_PRODUCT_ID VARCHAR
)
RETURNS VARCHAR
COMMENT = 'AI_AGG summary of recurring themes across all reviews for one product id. Read-only.'
AS
$$
  SELECT AI_AGG(
    REVIEW_TEXT,
    'These are customer reviews of a single office product sold in Europe. '
    || 'In British English, give: one sentence of overall verdict, then the two '
    || 'most common complaints and the two most common compliments as short '
    || 'bullet points. Be specific and do not invent details not present in the reviews.'
  )
  FROM SUPERSTORE.AGENTS.PRODUCT_REVIEWS
  WHERE PRODUCT_ID = P_PRODUCT_ID
$$;

-- Smoke tests, deliberately using NAMED arguments.
--
-- This is not a style choice. The agent invokes a generic tool with named
-- arguments taken from the tool's input_schema, never positionally. Testing these
-- positionally is exactly how a name mismatch survived to the agent: every call
-- failed with "named arguments [CUSTOMER_ID] do not match any signature", the
-- orchestrator retried, fell back to hand-written SQL, and finally tripped its own
-- loop guard - while these positional smoke tests passed happily.
--
-- So the argument names below MUST match 06_agent.sql's input_schema properties.
-- 09_verify.sql asserts that correspondence structurally against
-- INFORMATION_SCHEMA rather than trusting it.
SELECT SUPERSTORE.AGENTS.FORECAST_SALES(P_REGION => 'North', P_MONTHS => 3)
       AS forecast_north_3m;
SELECT SUPERSTORE.AGENTS.FORECAST_SALES(P_REGION => NULL, P_MONTHS => 6)
       AS forecast_all_6m;
SELECT SUPERSTORE.AGENTS.CUSTOMER_HEALTH_SCORE(P_CUSTOMER_ID => 'SP-20920')
       AS health_named_arg;
SELECT LEFT(SUPERSTORE.AGENTS.SUMMARISE_PRODUCT_REVIEWS(
         P_PRODUCT_ID => (SELECT PRODUCT_ID FROM SUPERSTORE.AGENTS.PRODUCT_REVIEWS
                          GROUP BY PRODUCT_ID ORDER BY COUNT(*) DESC LIMIT 1)), 200)
       AS summary_named_arg;
