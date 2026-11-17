-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Assertions. Every check raises on failure rather than printing something a
-- reader has to interpret, so `snow sql -f 09_verify.sql` exiting 0 means the
-- whole stack is intact.
--
-- Deliberately asserts GRANTS EXIST rather than inferring health from a working
-- agent turn. Several of these failures are silent at run time: a missing MCP
-- grant just makes the server invisible, and a missing search-service grant makes
-- the agent answer from the Analyst alone. Both look like success.

EXECUTE IMMEDIATE $$
DECLARE
  problems ARRAY := [];
  n        INT;
  v        VARCHAR;
  spec     VARIANT;
BEGIN
  -- ---- data ----
  SELECT COUNT(*) INTO :n FROM SUPERSTORE.AGENTS.REVIEW_SEEDS;
  IF (n <> 680) THEN
    problems := ARRAY_APPEND(:problems, ('REVIEW_SEEDS has ' || n || ' rows, expected 680')::VARIANT);
  END IF;

  SELECT COUNT(*) INTO :n FROM SUPERSTORE.AGENTS.REVIEW_SEEDS
   WHERE REVIEW_TITLE IS NULL OR REVIEW_TEXT IS NULL OR LENGTH(REVIEW_TEXT) < 40;
  IF (n > 0) THEN
    problems := ARRAY_APPEND(:problems, (n || ' review seeds have a null or stub body')::VARIANT);
  END IF;

  SELECT COUNT(*) INTO :n FROM SUPERSTORE.AGENTS.PRODUCT_REVIEWS;
  IF (n < 2900) THEN
    problems := ARRAY_APPEND(:problems, ('PRODUCT_REVIEWS has only ' || n || ' rows, expected 2900+')::VARIANT);
  END IF;

  -- Exactly one review per sampled order line. This started as 3,460 rows from
  -- ~3,000 sampled lines because a LEFT JOIN to RETURNS_V (637 rows over 284 order
  -- ids) duplicated every line of a returned order. The surplus was entirely on
  -- returned orders, which are the negative ones, so it quietly exaggerated the
  -- returned-vs-not rating gap that the hybrid questions are built on.
  LET sampled INT := (
    SELECT COUNT(*) FROM SUPERSTORE.PUBLIC.ORDERS_V WHERE (ABS(HASH(ROW_ID)) % 10) < 3
  );
  IF (n <> sampled) THEN
    problems := ARRAY_APPEND(:problems,
      ('PRODUCT_REVIEWS has ' || n || ' rows for ' || sampled
       || ' sampled order lines - a join is fanning out, most likely RETURNS_V')::VARIANT);
  END IF;

  -- Every review must name its product in the body, or product-name search breaks.
  SELECT COUNT(*) INTO :n FROM SUPERSTORE.AGENTS.PRODUCT_REVIEWS
   WHERE POSITION(PRODUCT_NAME IN REVIEW_TEXT) = 0;
  IF (n > 0) THEN
    problems := ARRAY_APPEND(:problems, (n || ' reviews do not mention their product name')::VARIANT);
  END IF;

  -- The correlation between real returns and low ratings is the thing that makes
  -- the hybrid questions answerable. If it has gone, the demo is hollow even
  -- though every object exists.
  LET gap FLOAT := (
    SELECT AVG(IFF(NOT WAS_RETURNED, RATING, NULL)) - AVG(IFF(WAS_RETURNED, RATING, NULL))
    FROM SUPERSTORE.AGENTS.PRODUCT_REVIEWS
  );
  IF (gap < 1.0) THEN
    problems := ARRAY_APPEND(:problems,
      ('returned-vs-not rating gap is only ' || ROUND(gap, 2)
       || ', expected >= 1.0 - the satisfaction model is no longer tied to real data')::VARIANT);
  END IF;

  -- ---- search service ----
  SHOW CORTEX SEARCH SERVICES LIKE 'PRODUCT_REVIEWS_SEARCH' IN SCHEMA SUPERSTORE.AGENTS;
  SELECT COUNT(*) INTO :n FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
  IF (n <> 1) THEN
    problems := ARRAY_APPEND(:problems, 'PRODUCT_REVIEWS_SEARCH does not exist'::VARIANT);
  END IF;

  -- ---- semantic view: the cross-grain path ----
  BEGIN
    SELECT COUNT(*) INTO :n FROM (
      SELECT * FROM SEMANTIC_VIEW(
        SUPERSTORE.AGENTS.SUPERSTORE_360
        DIMENSIONS PRODUCTS.CATALOGUE_SUB_CATEGORY
        METRICS    ORDERS.TOTAL_SALES, REVIEWS.AVG_RATING, REVIEWS.PCT_NEGATIVE_REVIEWS
      ));
    IF (n < 17) THEN
      problems := ARRAY_APPEND(:problems,
        ('semantic view returned ' || n || ' sub-categories, expected 17')::VARIANT);
    END IF;
  EXCEPTION WHEN OTHER THEN
    problems := ARRAY_APPEND(:problems, ('semantic view query failed: ' || SQLERRM)::VARIANT);
  END;

  -- CREATE OR REPLACE silently drops VQRs when AI_VERIFIED_QUERIES is omitted.
  -- Keep the five Analyst-backed starter prompts attached to the rebuilt view.
  SELECT SYSTEM$READ_YAML_FROM_SEMANTIC_VIEW('SUPERSTORE.AGENTS.SUPERSTORE_360') INTO :v;
  LET expected_vqr_questions ARRAY := [
    'Which sub-categories have the highest sales but the worst review ratings, and are those the ones being returned?',
    'What were total sales and profit by region, and how did the trend move over 2023?',
    'Show me the top 10 products by revenue with their average review rating.',
    'Compare return rates and negative review rates across the three regions.',
    'Which delivery mode is associated with the worst customer sentiment?'
  ];
  FOR vi IN 0 TO ARRAY_SIZE(:expected_vqr_questions) - 1 DO
    IF (POSITION(GET(:expected_vqr_questions, :vi)::VARCHAR IN COALESCE(v, '')) = 0) THEN
      problems := ARRAY_APPEND(:problems,
        ('semantic view is missing VQR for: '
         || GET(:expected_vqr_questions, :vi)::VARCHAR)::VARIANT);
    END IF;
  END FOR;

  -- ---- semantic view: no ambiguous synonyms within a table ----
  -- Facts, dimensions and metrics share ONE synonym namespace per logical table.
  -- A word claimed by both a fact and its aggregate metric ('revenue' on both
  -- SALES_AMOUNT and TOTAL_SALES) is ambiguous: Analyst still answers, it just may
  -- bind to the row-level fact instead of the aggregate and return a plausible
  -- wrong number. Snowsight's validator warns about this; nothing in this pipeline
  -- did until it bit us, so it is asserted here.
  LET syn ARRAY := [];
  FOR ki IN 0 TO 2 DO
    LET kind VARCHAR := GET(['DIMENSIONS','FACTS','METRICS'], :ki)::VARCHAR;
    EXECUTE IMMEDIATE 'SHOW SEMANTIC ' || :kind
                      || ' IN SUPERSTORE.AGENTS.SUPERSTORE_360';
    LET batch ARRAY;
    -- Synonyms come back as a JSON array in a string column, so flatten it.
    SELECT COALESCE(ARRAY_AGG("table_name" || '|' || LOWER(TRIM(f.value::VARCHAR))
                              || '|' || LOWER("name")), [])
      INTO :batch
    FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())),
         LATERAL FLATTEN(input => TRY_PARSE_JSON("synonyms")) f;
    syn := ARRAY_CAT(:syn, :batch);
  END FOR;

  LET dupes ARRAY;
  SELECT COALESCE(ARRAY_AGG(k), []) INTO :dupes FROM (
    SELECT SPLIT_PART(s.value::VARCHAR, '|', 1) || ' "'
           || SPLIT_PART(s.value::VARCHAR, '|', 2) || '" -> '
           || ARRAY_TO_STRING(ARRAY_AGG(DISTINCT SPLIT_PART(s.value::VARCHAR, '|', 3)), ', ') AS k
    FROM TABLE(FLATTEN(input => :syn)) s
    GROUP BY SPLIT_PART(s.value::VARCHAR, '|', 1), SPLIT_PART(s.value::VARCHAR, '|', 2)
    HAVING COUNT(DISTINCT SPLIT_PART(s.value::VARCHAR, '|', 3)) > 1
  );
  IF (ARRAY_SIZE(:dupes) > 0) THEN
    problems := ARRAY_APPEND(:problems,
      ('ambiguous synonyms in SUPERSTORE_360: ' || ARRAY_TO_STRING(:dupes, '; '))::VARIANT);
  END IF;

  -- ---- no dimension may fan out the facts ----
  -- The generalised regression test for the whole class of bug found by driving the
  -- agent's own sample questions live. Grouping by a dimension must never change
  -- the grand total. It did: ORDERS joined straight to PEOPLE_V and declared
  -- PRIMARY KEY (REGION) on it, but PEOPLE_V has 6 rows for 3 regions - a manager
  -- name plus an email address each - so totalling sales by manager returned
  -- £5,874,120 against a true £2,938,091. The declared key was simply false, and
  -- nothing here checked it. One assertion covers every dimension at once.
  LET grand FLOAT := (SELECT TOTAL_SALES FROM SEMANTIC_VIEW(
    SUPERSTORE.AGENTS.SUPERSTORE_360 METRICS ORDERS.TOTAL_SALES));
  LET slices ARRAY := ['REGIONS.SALES_REGION','REGIONS.REGION_MANAGER',
                       'CUSTOMERS.CUSTOMER_ACCOUNT_ID','DELIVERY_MODES.SHIPPING_MODE',
                       'PRODUCTS.CATALOGUE_SUB_CATEGORY','ORDERS.REGION'];
  FOR si IN 0 TO ARRAY_SIZE(:slices) - 1 DO
    LET dim VARCHAR := GET(:slices, :si)::VARCHAR;
    LET summed FLOAT;
    EXECUTE IMMEDIATE
      'SELECT SUM(TOTAL_SALES) FROM (SELECT * FROM SEMANTIC_VIEW('
      || 'SUPERSTORE.AGENTS.SUPERSTORE_360 DIMENSIONS ' || :dim
      || ' METRICS ORDERS.TOTAL_SALES))';
    SELECT $1 INTO :summed FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
    IF (ABS(COALESCE(summed, 0) - grand) > 1) THEN
      problems := ARRAY_APPEND(:problems,
        ('grouping by ' || :dim || ' totals ' || ROUND(COALESCE(summed, 0), 2)
         || ' against a grand total of ' || ROUND(grand, 2)
         || ' - that dimension fans out the facts, so its declared key is not unique')::VARIANT);
    END IF;
  END FOR;

  -- ---- every conformed dimension must reach BOTH fact tables ----
  -- A shared key is only usable cross-grain if ORDERS and REVIEWS both relate to
  -- it. When PRODUCTS was the only bridge, three of the agent's eight sample
  -- questions were unanswerable: asking for sales or returns alongside sentiment by
  -- region, customer or delivery mode failed with "the entities 'ORDERS' and
  -- 'REVIEWS' are not related". Live, that showed up as one starter prompt
  -- consuming the entire 300s budget and returning no text whatsoever.
  LET bridges ARRAY := ['REGIONS.SALES_REGION','CUSTOMERS.CUSTOMER_ACCOUNT_ID',
                        'DELIVERY_MODES.SHIPPING_MODE','PRODUCTS.CATALOGUE_SUB_CATEGORY'];
  FOR bi IN 0 TO ARRAY_SIZE(:bridges) - 1 DO
    LET dim VARCHAR := GET(:bridges, :bi)::VARCHAR;
    BEGIN
      EXECUTE IMMEDIATE
        'SELECT COUNT(*) FROM (SELECT * FROM SEMANTIC_VIEW('
        || 'SUPERSTORE.AGENTS.SUPERSTORE_360 DIMENSIONS ' || :dim
        || ' METRICS ORDERS.TOTAL_SALES, ORDERS.RETURN_RATE, REVIEWS.AVG_RATING,'
        || ' REVIEWS.PCT_NEGATIVE_REVIEWS))';
    EXCEPTION WHEN OTHER THEN
      problems := ARRAY_APPEND(:problems,
        ('cannot combine sales, returns and review sentiment by ' || :dim
         || ' - ' || SQLERRM)::VARIANT);
    END;
  END FOR;

  -- ---- discount is a rate, not money ----
  -- Guard against the inherited bug where TOTAL_DISCOUNT summed a 0-1 rate column
  -- and the result (1031.05 for the whole dataset) was then subtracted from GBP
  -- revenue. A genuine discount total has to be a substantial fraction of sales.
  LET disc FLOAT := (SELECT TOTAL_DISCOUNT_GBP FROM SEMANTIC_VIEW(
    SUPERSTORE.AGENTS.SUPERSTORE_360 METRICS ORDERS.TOTAL_DISCOUNT_GBP));
  LET sales FLOAT := (SELECT TOTAL_SALES FROM SEMANTIC_VIEW(
    SUPERSTORE.AGENTS.SUPERSTORE_360 METRICS ORDERS.TOTAL_SALES));
  IF (disc / NULLIF(sales, 0) < 0.02) THEN
    problems := ARRAY_APPEND(:problems,
      ('TOTAL_DISCOUNT_GBP is only ' || ROUND(disc, 2) || ' against sales of '
       || ROUND(sales, 2) || ' - it is probably summing the 0-1 rate again '
       || 'rather than the derived GBP fact')::VARIANT);
  END IF;

  -- ---- generic tools ----
  BEGIN
    SELECT SUPERSTORE.AGENTS.FORECAST_SALES('North', 3):forecast[0]:month::VARCHAR INTO :v;
    IF (v IS NULL) THEN
      problems := ARRAY_APPEND(:problems, 'FORECAST_SALES returned no forecast array'::VARIANT);
    END IF;
  EXCEPTION WHEN OTHER THEN
    problems := ARRAY_APPEND(:problems, ('FORECAST_SALES failed: ' || SQLERRM)::VARIANT);
  END;

  -- Regression guard for the argument-shadowing bug: if a UDF argument ever again
  -- collides with a column name, the region filter stops binding and every region
  -- returns the all-regions total.
  LET north FLOAT := SUPERSTORE.AGENTS.FORECAST_SALES('North', 1):avg_monthly_sales::FLOAT;
  LET allr  FLOAT := SUPERSTORE.AGENTS.FORECAST_SALES(NULL, 1):avg_monthly_sales::FLOAT;
  IF (north >= allr) THEN
    problems := ARRAY_APPEND(:problems,
      ('FORECAST_SALES ignores its region argument (North ' || north
       || ' >= all regions ' || allr || ') - likely an argument/column name collision')::VARIANT);
  END IF;

  BEGIN
    SELECT SUPERSTORE.AGENTS.CUSTOMER_HEALTH_SCORE('SP-20920'):band::VARCHAR INTO :v;
    IF (v IS NULL) THEN
      problems := ARRAY_APPEND(:problems, 'CUSTOMER_HEALTH_SCORE returned no band'::VARIANT);
    END IF;
  EXCEPTION WHEN OTHER THEN
    problems := ARRAY_APPEND(:problems, ('CUSTOMER_HEALTH_SCORE failed: ' || SQLERRM)::VARIANT);
  END;

  -- Check the VALUES the UDF returns, not just that it returns something. Asserting
  -- only that `band` was non-null is why this shipped reporting £78,564.99 of
  -- lifetime spend for SP-20920 against a true £16,564.15 - a LEFT JOIN to
  -- RETURNS_V inside the function multiplied every money figure by ~4.7. The band
  -- stayed "Healthy" throughout, because the monetary component caps at 25 points
  -- and £16.5k already exceeded the cap, so no derived field moved and the answer
  -- read as correct. Compared against a direct aggregate over three customers, so
  -- one lucky value cannot pass it.
  LET hc ARRAY := ['SP-20920','DL-13315','PO-18865'];
  FOR hi IN 0 TO ARRAY_SIZE(:hc) - 1 DO
    LET cid VARCHAR := GET(:hc, :hi)::VARCHAR;
    LET h VARIANT := SUPERSTORE.AGENTS.CUSTOMER_HEALTH_SCORE(P_CUSTOMER_ID => :cid);
    LET true_sales  FLOAT;
    LET true_orders INT;
    SELECT ROUND(SUM(SALES), 2), COUNT(DISTINCT ORDER_ID)
      INTO :true_sales, :true_orders
    FROM SUPERSTORE.PUBLIC.ORDERS_V WHERE CUSTOMER_ID = :cid;

    IF (ABS(:h:total_sales_gbp::FLOAT - true_sales) > 0.01) THEN
      problems := ARRAY_APPEND(:problems,
        ('CUSTOMER_HEALTH_SCORE(' || :cid || ') reports total_sales_gbp '
         || :h:total_sales_gbp::VARCHAR || ' against a true ' || true_sales
         || ' - a join inside the function is fanning out')::VARIANT);
    END IF;
    IF (:h:orders::INT <> true_orders) THEN
      problems := ARRAY_APPEND(:problems,
        ('CUSTOMER_HEALTH_SCORE(' || :cid || ') reports ' || :h:orders::VARCHAR
         || ' orders against a true ' || true_orders)::VARIANT);
    END IF;
    -- Return rate is a percentage of orders, so it cannot exceed 100.
    IF (:h:return_rate_pct::FLOAT > 100) THEN
      problems := ARRAY_APPEND(:problems,
        ('CUSTOMER_HEALTH_SCORE(' || :cid || ') reports a return rate of '
         || :h:return_rate_pct::VARCHAR || '% - returned orders exceed total orders')::VARIANT);
    END IF;
  END FOR;

  -- ---- agent spec ----
  DESCRIBE AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT;
  SELECT PARSE_JSON("agent_spec") INTO :spec FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

  IF (ARRAY_SIZE(:spec:tools::ARRAY) < 6) THEN
    problems := ARRAY_APPEND(:problems,
      ('agent has only ' || ARRAY_SIZE(:spec:tools::ARRAY)
       || ' tools, expected at least the 6 GA ones - did 07 replace the spec instead of merging it?')::VARIANT);
  END IF;

  -- The six GA tool names must all survive whatever 07 did.
  -- Array loop rather than a FOR..IN cursor: a cursor variable cannot be
  -- referenced from inside a nested query, which fails as "invalid identifier
  -- 'T.WANTED'" at compile time.
  LET wanted ARRAY := ['Superstore_Analyst','Review_Search','data_to_chart',
                       'forecast_sales','customer_health_score','summarise_product_reviews'];
  LET have ARRAY;
  SELECT COALESCE(ARRAY_AGG(f.value:tool_spec:name::VARCHAR), []) INTO :have
  FROM TABLE(FLATTEN(input => :spec:tools)) f;

  FOR i IN 0 TO ARRAY_SIZE(:wanted) - 1 DO
    IF (NOT ARRAY_CONTAINS(GET(:wanted, :i), :have)) THEN
      problems := ARRAY_APPEND(:problems,
        ('agent is missing tool ' || GET(:wanted, :i)::VARCHAR)::VARIANT);
    END IF;
  END FOR;

  IF (:spec:instructions:sample_questions IS NULL) THEN
    problems := ARRAY_APPEND(:problems, 'agent has no sample_questions - starter prompts will be empty in both hosts'::VARIANT);
  END IF;

  IF (:spec:tool_resources:Superstore_Analyst:semantic_view IS NULL) THEN
    problems := ARRAY_APPEND(:problems, 'Analyst tool is not pointed at a semantic view'::VARIANT);
  END IF;

  IF (:spec:tool_resources:Review_Search:id_column IS NULL) THEN
    problems := ARRAY_APPEND(:problems, 'Review_Search has no id_column - citations will not be clickable'::VARIANT);
  END IF;

  -- ---- native MCP server ----
  -- Only asserted when 07 recorded the field as supported - an account that
  -- rejects mcp_servers entirely legitimately has neither the spec entry nor
  -- the server object attached, and that is not a build failure.
  IF (:spec:mcp_servers IS NOT NULL) THEN
    IF (GET(:spec:mcp_servers::ARRAY, 0):server_spec:name::VARCHAR <> 'SUPERSTORE.AGENTS.SUPERSTORE_DEMO_MCP') THEN
      problems := ARRAY_APPEND(:problems,
        ('agent mcp_servers points at '
         || GET(:spec:mcp_servers::ARRAY, 0):server_spec:name::VARCHAR
         || ', expected SUPERSTORE.AGENTS.SUPERSTORE_DEMO_MCP')::VARIANT);
    END IF;

    BEGIN
      DESCRIBE MCP SERVER SUPERSTORE.AGENTS.SUPERSTORE_DEMO_MCP;
      LET mcp_tool_count INT;
      SELECT ARRAY_SIZE(PARSE_JSON("server_spec"):tools::ARRAY) INTO :mcp_tool_count
      FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
      IF (:mcp_tool_count <> 2) THEN
        problems := ARRAY_APPEND(:problems,
          ('SUPERSTORE_DEMO_MCP has ' || :mcp_tool_count
           || ' tools, expected 2 (product_review_search, superstore_analyst)')::VARIANT);
      END IF;
    EXCEPTION WHEN OTHER THEN
      problems := ARRAY_APPEND(:problems, ('DESCRIBE MCP SERVER failed: ' || SQLERRM)::VARIANT);
    END;
  END IF;

  -- ---- generic tool contracts: input_schema names vs SQL parameter names ----
  -- The highest-value assertion in this file. The agent calls a generic tool with
  -- NAMED arguments taken from input_schema, so if a property name and the SQL
  -- parameter name disagree, every invocation fails at run time with
  -- "named arguments [X] do not match any signature", the orchestrator retries,
  -- reimplements the tool in raw SQL, and eventually trips its loop guard. The
  -- turn still returns prose, so it reads as a slow-but-working agent rather than
  -- a broken tool. Comparing the two name sets here catches it at build time.
  FOR gi IN 0 TO ARRAY_SIZE(:spec:tools::ARRAY) - 1 DO
    LET tspec VARIANT := GET(:spec:tools::ARRAY, :gi):tool_spec;
    IF (:tspec:type::VARCHAR = 'generic') THEN
      LET tname   VARCHAR := :tspec:name::VARCHAR;
      LET ident   VARCHAR := GET(:spec:tool_resources, :tname):identifier::VARCHAR;
      LET fname   VARCHAR := SPLIT_PART(:ident, '.', 3);

      LET schema_args ARRAY;
      -- :tspec, not tspec - a scripting LET variable must be bind-referenced
      -- inside a nested query or it compiles as "invalid identifier 'TSPEC'".
      SELECT COALESCE(ARRAY_AGG(UPPER(f.key)), []) INTO :schema_args
      FROM TABLE(FLATTEN(input => :tspec:input_schema:properties)) f;

      -- ARGUMENT_SIGNATURE looks like "(P_REGION VARCHAR, P_MONTHS NUMBER)";
      -- take the name from each comma-separated pair.
      LET sql_args ARRAY;
      SELECT COALESCE(ARRAY_AGG(UPPER(TRIM(SPLIT_PART(TRIM(s.value::VARCHAR), ' ', 1)))), [])
        INTO :sql_args
      FROM SUPERSTORE.INFORMATION_SCHEMA.FUNCTIONS fn,
           TABLE(FLATTEN(input => SPLIT(TRIM(fn.ARGUMENT_SIGNATURE, '()'), ','))) s
      WHERE fn.FUNCTION_SCHEMA = 'AGENTS' AND fn.FUNCTION_NAME = :fname;

      IF (ARRAY_SIZE(:sql_args) = 0) THEN
        problems := ARRAY_APPEND(:problems,
          ('generic tool ' || :tname || ' points at ' || :ident
           || ' which has no signature in INFORMATION_SCHEMA')::VARIANT);
      ELSEIF (ARRAY_SIZE(ARRAY_EXCEPT(:schema_args, :sql_args)) > 0) THEN
        problems := ARRAY_APPEND(:problems,
          ('generic tool ' || :tname || ': input_schema names ['
           || ARRAY_TO_STRING(:schema_args, ',') || '] do not exist on '
           || :ident || ' [' || ARRAY_TO_STRING(:sql_args, ',')
           || '] - every agent call will fail with a named-argument error')::VARIANT);
      END IF;
    END IF;
  END FOR;

  -- And prove it end to end, calling exactly as the agent does.
  BEGIN
    SELECT SUPERSTORE.AGENTS.FORECAST_SALES(P_REGION => 'North', P_MONTHS => 3)
             :forecast[0]:month::VARCHAR INTO :v;
    IF (v IS NULL) THEN
      problems := ARRAY_APPEND(:problems, 'FORECAST_SALES named-argument call returned no forecast'::VARIANT);
    END IF;
  EXCEPTION WHEN OTHER THEN
    problems := ARRAY_APPEND(:problems, ('FORECAST_SALES named-argument call failed: ' || SQLERRM)::VARIANT);
  END;

  BEGIN
    SELECT SUPERSTORE.AGENTS.CUSTOMER_HEALTH_SCORE(P_CUSTOMER_ID => 'SP-20920')
             :band::VARCHAR INTO :v;
    IF (v IS NULL) THEN
      problems := ARRAY_APPEND(:problems, 'CUSTOMER_HEALTH_SCORE named-argument call returned no band'::VARIANT);
    END IF;
  EXCEPTION WHEN OTHER THEN
    problems := ARRAY_APPEND(:problems, ('CUSTOMER_HEALTH_SCORE named-argument call failed: ' || SQLERRM)::VARIANT);
  END;

  -- ---- grants: the Teams role must hold the agent, semantic view and tool grants ----
  -- SHOW GRANTS, not SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES: the latter lags by
  -- up to ~2 hours, so immediately after 08 it reports absences that are not real.
  --
  -- Matching is on exact object names rather than a substring pattern. A pattern
  -- like '%PRODUCT_REVIEWS%' also catches N_BROWN_DEMO_DB.AGENTS.PRODUCT_REVIEWS_SEARCH
  -- - a bare LIKE 'SUPERSTORE.AGENTS.%' plus the bare schema name avoids that.
  LET scope VARCHAR :=
    '"name" LIKE ''SUPERSTORE.AGENTS.%'' OR "name" = ''SUPERSTORE.AGENTS''';
  LET teams ARRAY;

  SHOW GRANTS TO ROLE AGENTS_TEAMS_USER;
  EXECUTE IMMEDIATE
    'SELECT COALESCE(ARRAY_AGG("privilege" || '' '' || "granted_on" || '' '' || "name"), []) '
    || 'FROM TABLE(RESULT_SCAN(''' || LAST_QUERY_ID() || ''')) WHERE ' || :scope;
  SELECT $1 INTO :teams FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

  IF (ARRAY_SIZE(:teams) = 0) THEN
    problems := ARRAY_APPEND(:problems,
      'AGENTS_TEAMS_USER holds no grant on SUPERSTORE.AGENTS - did 08 run?'::VARIANT);
  END IF;

  -- Checked explicitly, and not left to the parity test above, because the failure
  -- mode is silent: CREATE OR REPLACE AGENT in 06 DROPS every USAGE grant on the
  -- agent, so re-running 06 without re-running 08 leaves the role unauthorised. From the client that surfaces as
  -- HTTP 401 "the agent does not exist or access is not authorized", which reads
  -- like a bad token or a typo'd name rather than a missing grant. 08 must always
  -- follow 06; run-all.sh orders them correctly, a hand-run may not.
  --
  -- The granted_on value is CORTEX_AGENT, not AGENT. Getting that wrong makes this
  -- assertion fail against a perfectly healthy grant tree.
  IF (NOT ARRAY_CONTAINS('USAGE CORTEX_AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT'::VARIANT, :teams)) THEN
    problems := ARRAY_APPEND(:problems,
      ('USAGE ON AGENT SUPERSTORE_360_AGENT is missing for AGENTS_TEAMS_USER - '
       || 'CREATE OR REPLACE AGENT drops it, so 08 must be re-run after 06')::VARIANT);
  END IF;

  -- CREATE OR REPLACE SEMANTIC VIEW drops SELECT grants in the same way.
  IF (NOT ARRAY_CONTAINS('SELECT SEMANTIC_VIEW SUPERSTORE.AGENTS.SUPERSTORE_360'::VARIANT, :teams)) THEN
    problems := ARRAY_APPEND(:problems,
      ('SELECT ON SEMANTIC VIEW SUPERSTORE_360 is missing for AGENTS_TEAMS_USER - '
       || 'CREATE OR REPLACE SEMANTIC VIEW drops it, so 08 must be re-run after 04')::VARIANT);
  END IF;

  IF (ARRAY_SIZE(:problems) > 0) THEN
    RETURN 'FAILED (' || ARRAY_SIZE(:problems) || '): ' || ARRAY_TO_STRING(:problems, ' | ');
  END IF;
  RETURN 'ALL CHECKS PASSED';
END;
$$;

-- Reference output, printed regardless, for eyeballing after a change.

SELECT FEATURE, SUPPORTED, LEFT(COALESCE(ERROR_MESSAGE,''), 120) AS ERROR_MESSAGE
FROM SUPERSTORE.AGENTS.CAPABILITY_PROBE ORDER BY FEATURE;

-- Search-service health.
SHOW CORTEX SEARCH SERVICES LIKE 'PRODUCT_REVIEWS_SEARCH' IN SCHEMA SUPERSTORE.AGENTS;
SELECT "name", "indexing_state", "serving_state", "source_data_num_rows"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- What each sub-category looks like on the two axes the demo leans on.
SELECT * FROM SEMANTIC_VIEW(
  SUPERSTORE.AGENTS.SUPERSTORE_360
  DIMENSIONS PRODUCTS.CATALOGUE_SUB_CATEGORY
  METRICS    ORDERS.TOTAL_SALES, REVIEWS.AVG_RATING,
             REVIEWS.PCT_NEGATIVE_REVIEWS, REVIEWS.REVIEW_COUNT
)
ORDER BY TOTAL_SALES DESC;
