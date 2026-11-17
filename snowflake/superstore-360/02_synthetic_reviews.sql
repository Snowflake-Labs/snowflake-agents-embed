-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Synthetic product-review corpus for the Cortex Search tool.
--
-- Two tables, on purpose:
--
--   REVIEW_SEEDS    ~680 LLM-generated reviews, one per
--                   (sub-category x rating x persona) combination.
--   PRODUCT_REVIEWS ~3,000 rows, seeds expanded across REAL order lines.
--
-- Generating 3,000 individual AI_COMPLETE calls would be slow and would re-bill
-- on every replay of this script. Generating 680 and expanding them keeps the
-- text varied enough for retrieval to be meaningful while making the expensive
-- step small and cacheable. REVIEW_SEEDS is only populated when empty; pass
-- FORCE_RESEED=1 to run-all.sh to rebuild it.
--
-- The important design point is that RATING is DERIVED FROM REAL SIGNALS in
-- ORDERS_V and RETURNS_V (returned, negative profit, heavy discount) rather than
-- being random. That is what makes a question like "which sub-categories have the
-- highest sales but the worst review ratings, and are those the ones being
-- returned?" have a real answer -- and that question is the one that forces
-- Analyst + Search + chart into a single turn, which is the whole point of this
-- agent.

-- ---------------------------------------------------------------------------
-- 1. Seed corpus
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS SUPERSTORE.AGENTS.REVIEW_SEEDS (
  SEED_ID       NUMBER        NOT NULL,
  SUB_CATEGORY  VARCHAR       NOT NULL,
  RATING        NUMBER        NOT NULL,
  PERSONA       VARCHAR       NOT NULL,
  PERSONA_IDX   NUMBER        NOT NULL,
  REVIEW_TITLE  VARCHAR,
  REVIEW_TEXT   VARCHAR,
  GENERATED_AT  TIMESTAMP_LTZ NOT NULL
);

EXECUTE IMMEDIATE $$
DECLARE
  existing INT;
  made     INT;
BEGIN
  existing := (SELECT COUNT(*) FROM SUPERSTORE.AGENTS.REVIEW_SEEDS);
  IF (existing > 0) THEN
    RETURN 'REVIEW_SEEDS already holds ' || existing
           || ' rows - skipping generation. FORCE_RESEED=1 to rebuild.';
  END IF;

  INSERT INTO SUPERSTORE.AGENTS.REVIEW_SEEDS
    (SEED_ID, SUB_CATEGORY, RATING, PERSONA, PERSONA_IDX,
     REVIEW_TITLE, REVIEW_TEXT, GENERATED_AT)
  -- Carry the parent CATEGORY and a few real product names into the prompt. The
  -- sub-category name alone is not enough to ground the model: asked about "Art",
  -- it wrote a review of "digital art software", which then got stapled onto a box
  -- of highlighters. Three real examples fix the referent.
  WITH sub_categories AS (
    SELECT
      SUB_CATEGORY,
      ANY_VALUE(CATEGORY)                                AS CATEGORY,
      ARRAY_TO_STRING(ARRAY_SLICE(ARRAY_AGG(DISTINCT PRODUCT_NAME), 0, 3), '; ')
                                                         AS EXAMPLES
    FROM SUPERSTORE.PUBLIC.ORDERS_V
    GROUP BY SUB_CATEGORY
  ),
  ratings AS (
    SELECT COLUMN1 AS RATING FROM VALUES (1), (2), (3), (4), (5)
  ),
  -- Eight voices, so the same (sub-category, rating) cell does not read as one
  -- person writing eight times. Tone is set per persona; the rating drives
  -- sentiment independently.
  personas AS (
    SELECT COLUMN1 AS PERSONA_IDX, COLUMN2 AS PERSONA, COLUMN3 AS VOICE
    FROM VALUES
      (0, 'Office manager',        'practical, focused on bulk orders, staff feedback and value for money'),
      (1, 'Small business owner',  'cost-conscious, mentions cashflow and whether it was worth the spend'),
      (2, 'Home office worker',    'personal and chatty, talks about daily use at a desk at home'),
      (3, 'Facilities coordinator','procedural, mentions delivery, assembly, and fitting out meeting rooms'),
      (4, 'IT administrator',      'technical, mentions setup, compatibility and reliability under load'),
      (5, 'Executive assistant',   'brisk and exacting, mentions how it reflects on the office and on clients'),
      (6, 'Procurement lead',      'formal, mentions supplier terms, lead times and specification compliance'),
      (7, 'Freelance designer',    'expressive, mentions look and feel, finish and whether it inspires work')
  ),
  grid AS (
    SELECT
      ROW_NUMBER() OVER (ORDER BY s.SUB_CATEGORY, r.RATING, p.PERSONA_IDX) AS SEED_ID,
      s.SUB_CATEGORY, s.CATEGORY, s.EXAMPLES,
      r.RATING, p.PERSONA, p.PERSONA_IDX, p.VOICE
    FROM sub_categories s CROSS JOIN ratings r CROSS JOIN personas p
  ),
  generated AS (
    SELECT
      g.*,
      AI_COMPLETE(
        model  => 'claude-sonnet-4-5',
        prompt =>
          'Write one customer product review for a European office-supplies retailer.'
          || ' Product category: ' || g.CATEGORY || '.'
          || ' Product sub-category: ' || g.SUB_CATEGORY || '.'
          || ' Real products sold in this sub-category, to fix what you are reviewing: '
          || g.EXAMPLES || '.'
          || ' The review must be about that kind of physical product. Do not review'
          || ' software or a service unless the examples above are software.'
          || ' Star rating: ' || g.RATING || ' out of 5 - the sentiment must clearly match this rating.'
          || ' Reviewer persona: ' || g.PERSONA || ', whose voice is ' || g.VOICE || '.'
          || ' Write in British English. Use GBP and the pound sign for any prices.'
          || ' Do not invent a brand name and do not name a specific product model.'
          || ' Title: at most 8 words. Body: 35 to 60 words, one paragraph, no bullet points.',
        model_parameters => {'temperature': 0.9, 'max_tokens': 400},
        -- response_format keeps this out of markdown code fences, which the plain
        -- prompt form wraps its JSON in.
        response_format => {
          'type': 'json',
          'schema': {
            'type': 'object',
            'properties': {'title': {'type': 'string'}, 'body': {'type': 'string'}},
            'required': ['title', 'body']
          }
        }
      ) AS RAW
    FROM grid g
  )
  SELECT
    SEED_ID, SUB_CATEGORY, RATING, PERSONA, PERSONA_IDX,
    TRY_PARSE_JSON(RAW):title::VARCHAR,
    TRY_PARSE_JSON(RAW):body::VARCHAR,
    CURRENT_TIMESTAMP()
  FROM generated;

  made := SQLROWCOUNT;

  -- A null title or body means the model returned something unparseable. Better
  -- to fail loudly here than to ship holes into the search index.
  LET bad INT := (SELECT COUNT(*) FROM SUPERSTORE.AGENTS.REVIEW_SEEDS
                  WHERE REVIEW_TITLE IS NULL OR REVIEW_TEXT IS NULL);
  IF (bad > 0) THEN
    RETURN 'WARNING: generated ' || made || ' seeds but ' || bad
           || ' have a null title or body - inspect before running 03.';
  END IF;

  RETURN 'generated ' || made || ' review seeds';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Expand to the review corpus
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE SUPERSTORE.AGENTS.PRODUCT_REVIEWS AS
WITH order_lines AS (
  SELECT
    o.ROW_ID, o.ORDER_ID, o.ORDER_DATE, o.PRODUCT_ID, o.PRODUCT_NAME,
    o.CATEGORY, o.SUB_CATEGORY, o.CUSTOMER_ID, o.CUSTOMER_NAME,
    o.REGION, o.COUNTRY_REGION, o.DELIVERY_MODE, o.SALES, o.PROFIT, o.DISCOUNT,
    -- EXISTS, not LEFT JOIN. RETURNS_V holds 637 rows across only 284 distinct
    -- ORDER_IDs, so joining it duplicates every line of a returned order - one
    -- order fans to 81 rows. That silently produced 3,460 reviews from ~3,000
    -- sampled lines, all of the surplus on RETURNED orders, which biased the
    -- returned-vs-not rating gap that the demo's hybrid questions rest on.
    EXISTS (
      SELECT 1 FROM SUPERSTORE.PUBLIC.RETURNS_V r
      WHERE r.ORDER_ID = o.ORDER_ID AND r.IS_RETURNED
    ) AS WAS_RETURNED,
    -- Deterministic in place of RANDOM(), so a re-run reproduces the same corpus
    -- and the search index does not churn for no reason.
    (ABS(HASH(o.ROW_ID, o.PRODUCT_ID)) % 1000) / 1000.0 AS JITTER,
    ABS(HASH(o.PRODUCT_ID, o.ORDER_ID)) AS H
  FROM SUPERSTORE.PUBLIC.ORDERS_V o
  -- ~30% of 10,000 line items. Sampling by hash rather than SAMPLE() keeps it
  -- reproducible.
  WHERE (ABS(HASH(o.ROW_ID)) % 10) < 3
),
scored AS (
  SELECT
    *,
    -- Satisfaction model. Base 3.4, pushed down by the real dissatisfaction
    -- signals in the source data and up by healthy margin, then spread by
    -- JITTER so each cell is not a single value.
    3.4
      - IFF(WAS_RETURNED, 1.7, 0)
      - IFF(PROFIT < 0, 0.9, 0)
      - IFF(DISCOUNT >= 0.3, 0.6, 0)
      + IFF(SALES > 0 AND PROFIT / NULLIF(SALES, 0) > 0.25, 0.5, 0)
      + (JITTER * 1.6 - 0.8)                                AS RAW_SCORE
  FROM order_lines
),
rated AS (
  SELECT *, LEAST(5, GREATEST(1, ROUND(RAW_SCORE))) AS RATING FROM scored
)
SELECT
  ROW_NUMBER() OVER (ORDER BY t.ORDER_DATE, t.ROW_ID)             AS REVIEW_ID,
  'https://reviews.superstore.example/r/'
    || LPAD(ROW_NUMBER() OVER (ORDER BY t.ORDER_DATE, t.ROW_ID), 6, '0')
                                                                  AS REVIEW_URL,
  t.ORDER_ID,
  t.PRODUCT_ID,
  t.PRODUCT_NAME,
  t.CATEGORY,
  t.SUB_CATEGORY,
  t.CUSTOMER_ID,
  t.CUSTOMER_NAME,
  t.REGION,
  t.COUNTRY_REGION,
  -- Denormalised from the order line so that "which delivery mode has the worst
  -- sentiment" is answerable at ORDER-LINE grain. Reaching DELIVERY_MODE from
  -- REVIEWS through the PRODUCTS conformed dimension instead averages every
  -- review of a product against every mode that product ever shipped by, which
  -- flattens a real 2.92-to-3.19 spread into a meaningless 3.01-to-3.06.
  t.DELIVERY_MODE,
  t.RATING,
  s.PERSONA,
  DATEADD(DAY, 1 + (t.H % 30), t.ORDER_DATE)                      AS REVIEW_DATE,
  s.REVIEW_TITLE,
  -- Weave the real product name into the seed body. The seed is written about the
  -- sub-category and never names a product, so this is the only place the actual
  -- PRODUCT_NAME enters the searchable text -- which is what lets a user search
  -- for a product by name and get its reviews back. Four openers, chosen by hash,
  -- to stop every row reading identically.
  CASE t.H % 4
    WHEN 0 THEN 'Ordered the ' || t.PRODUCT_NAME || '. '
    WHEN 1 THEN 'We bought the ' || t.PRODUCT_NAME || ' for the office. '
    WHEN 2 THEN 'Review of the ' || t.PRODUCT_NAME || ': '
    ELSE        'This is about the ' || t.PRODUCT_NAME || '. '
  END || s.REVIEW_TEXT                                            AS REVIEW_TEXT,
  (t.H % 7) <> 0                                                  AS VERIFIED_PURCHASE,
  (t.H % 47)                                                      AS HELPFUL_VOTES,
  t.WAS_RETURNED,
  t.SALES,
  t.PROFIT
FROM rated t
JOIN SUPERSTORE.AGENTS.REVIEW_SEEDS s
  ON  s.SUB_CATEGORY = t.SUB_CATEGORY
  AND s.RATING       = t.RATING
  -- One of the eight personas per row, deterministically.
  AND s.PERSONA_IDX  = (t.H % 8);

-- Sanity output: row count, and the rating distribution split by whether the
-- underlying order was actually returned. Returned orders should skew low. If
-- they do not, the satisfaction model above is not wired to the real data and the
-- hybrid questions will not have a coherent answer.
SELECT
  WAS_RETURNED,
  COUNT(*)                        AS REVIEWS,
  ROUND(AVG(RATING), 2)           AS AVG_RATING,
  MIN(RATING)                     AS MIN_RATING,
  MAX(RATING)                     AS MAX_RATING
FROM SUPERSTORE.AGENTS.PRODUCT_REVIEWS
GROUP BY WAS_RETURNED
ORDER BY WAS_RETURNED;
