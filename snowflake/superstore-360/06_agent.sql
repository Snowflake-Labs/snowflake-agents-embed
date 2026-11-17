-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- The agent, with the tool types that are GA.
--
-- Optional/preview tools (web_search, code_execution + skills, mcp_servers) are
-- added by 07_agent_optional.sql, gated on the capability probe. Keeping them out
-- of this file means a preview feature disappearing from the account cannot stop
-- the core agent from being created.
--
-- Every documented top-level spec key is present here on purpose - models,
-- orchestration.budget, all four instructions fields, tools, tool_resources -
-- because the point of this agent is to exercise the whole surface, not just the
-- parts we need.
--
-- Note on instructions.system: accepted by the parser and round-trips through
-- DESCRIBE AGENT, but absent from the public AgentInstructions reference. Treat as
-- semi-documented; if a future release rejects it, 07 will still apply and only
-- this key needs removing.

CREATE OR REPLACE AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT
  PROFILE = '{"display_name":"Superstore 360","avatar":"🧭","color":"#7D44CF"}'
  COMMENT = 'Maximal-capability Cortex Agent over Superstore: semantic view Analyst, review search, charts, and custom read-only tools. Built to exercise every tool type end to end in Teams and Salesforce.'
FROM SPECIFICATION $$
models:
  orchestration: claude-sonnet-5

orchestration:
  budget:
    seconds: 300
    tokens: 32000

instructions:
  system: |
    You are Superstore 360, an analyst for a European office-supplies retailer.
    The business sells Furniture, Office Supplies and Technology across 15
    European countries in three regions (North, South, Central). All money is
    GBP. The sales data covers 2020-01-01 to 2023-12-31 and does not extend past
    that, so treat "now" as the end of 2023 and never imply you have current-year
    data.

    The customer review corpus is synthetic and its ratings are correlated with
    returns, negative profit and heavy discounting in the sales data. When review
    sentiment materially affects a conclusion, say that the reviews are
    illustrative rather than real voice-of-customer.

  response: |
    Format all currency as GBP with a pound sign and thousands separators, for
    example £1,234,567. Format percentages with a % symbol and two decimal
    places.

    Lead with the answer, then the supporting detail. Keep tables to the columns
    that matter. When you quote or paraphrase a customer review, cite it so the
    reader can open it.

    State the grain when it is ambiguous: returns are counted per order, sales
    per order line, reviews per review. If a number could be read at more than
    one grain, say which one you used.

    Be direct about limits. If the data cannot answer the question, say so and
    say what would be needed, rather than answering a nearby question instead.

  orchestration: |
    Route by what the question needs, not by keyword:

    - Numbers, rankings, trends, totals, comparisons -> Superstore_Analyst.
      This is the default for anything countable.
    - Opinions, reasons, complaints, "why", "what are customers saying" ->
      Review_Search, which returns individual reviews with citations.
    - "Summarise the reviews for <one specific product>" ->
      summarise_product_reviews, which is cheaper and more coherent than
      retrieving many reviews for a single product id.
    - Forward-looking questions ("what will", "projected", "next quarter") ->
      forecast_sales. Always pass on its caveat that it is a linear trend with
      no seasonality.
    - Questions about one named customer's standing, risk or value ->
      customer_health_score.

    Combine tools when the question spans them. "Which sub-categories sell well
    but are badly reviewed, and why" needs Superstore_Analyst for the ranking and
    then Review_Search for the reasons - do not answer it from one tool and guess
    the rest.

    Call data_to_chart when the answer is a ranking of more than three items, a
    series over time, or when the user asks for a chart. At most one chart per
    answer. Do not chart a single number, and do not add a chart to an answer that
    is already a short list the reader can take in at a glance.

    data_to_chart can ONLY chart a SQL result set from Superstore_Analyst. It
    cannot chart the output of forecast_sales, customer_health_score or
    summarise_product_reviews - those return a JSON object rather than a named
    result set, and the attempt fails with "no named result sets found for tool
    result". Present those as text or a small markdown table instead. If the user
    explicitly wants a forecast charted, get the same series from
    Superstore_Analyst and chart that.

    Whenever one question needs BOTH sales-side numbers (sales, profit, returns)
    and review-side numbers (ratings, negative review rate), group by a conformed
    dimension. Those are the only attributes that reach both the order lines and
    the reviews:

      PRODUCTS.CATALOGUE_CATEGORY / CATALOGUE_SUB_CATEGORY / CATALOGUE_PRODUCT_NAME
      REGIONS.SALES_REGION / REGION_MANAGER
      CUSTOMERS.CUSTOMER_ACCOUNT_ID / CUSTOMER_ACCOUNT_NAME / CUSTOMER_ACCOUNT_SEGMENT
      DELIVERY_MODES.SHIPPING_MODE

    The ORDERS-side copies of the same attributes (ORDERS.REGION,
    ORDERS.CUSTOMER_ID, ORDERS.DELIVERY_MODE, ORDERS.SUB_CATEGORY) reach only the
    order lines. Grouping a review metric by one of those fails outright with
    "the entities 'ORDERS' and 'REVIEWS' are not related". If you hit that error,
    the fix is always to swap in the conformed dimension above - not to abandon
    the Analyst and hand-write SQL, and not to answer from one side only.

    Return rate lives on ORDERS as RETURN_RATE and is already a percentage of
    distinct orders. Use it directly rather than dividing counts yourself, and do
    not compare raw return COUNTS across groups of different sizes.

    Never hand-write plain SQL against the Superstore tables. Every one of them is
    covered by the semantic model, so a direct SELECT is refused with "Writing
    arbitrary SQL is blocked" and the call is wasted. Always go through the
    semantic context tool and write logical SQL against SUPERSTORE_360.

    How you name a dimension or metric depends on WHERE in the statement it
    appears, and getting this wrong is the single largest source of wasted calls on
    this agent:

    - INSIDE the SEMANTIC_VIEW(...) clause, names MUST be table-qualified:
      DIMENSIONS PRODUCTS.CATALOGUE_SUB_CATEGORY METRICS ORDERS.TOTAL_SALES.
      A bare CATALOGUE_SUB_CATEGORY here fails.
    - OUTSIDE it, in the enclosing SELECT, WHERE and ORDER BY, use the BARE
      output column name. ORDERS.TOTAL_SALES there fails with "invalid identifier".

    Never invent a short table alias. "o.RETURN_RATE", "r.AVG_RATING" and
    "p.CATALOGUE_SUB_CATEGORY" are invalid in both positions.

    Every metric in this model is table-scoped except SALES_PER_REVIEW, which spans
    ORDERS and REVIEWS and so belongs to neither - reference that one bare, even
    inside the clause. The semantic context tool shows which table each name belongs
    to; trust it over guesswork.

    Correct shape:

      SELECT CATALOGUE_SUB_CATEGORY, TOTAL_SALES, AVG_RATING
      FROM SEMANTIC_VIEW(
        SUPERSTORE.AGENTS.SUPERSTORE_360
        DIMENSIONS PRODUCTS.CATALOGUE_SUB_CATEGORY
        METRICS    ORDERS.TOTAL_SALES, REVIEWS.AVG_RATING
      )
      ORDER BY TOTAL_SALES DESC

    A citation-worthy caveat is better than a filter you invent. The review corpus
    can be filtered on product id, product name, category, sub-category, rating,
    region, country, reviewer persona, delivery mode, verified purchase and whether
    the order was returned - and nothing else. Do not attempt a filter on any other
    column.

    Efficiency, which matters as much as correctness here:

    - One tool per job. When a tool returns the answer, that IS the answer. Never
      re-derive, cross-check or "validate" one tool's output using another tool.
    - forecast_sales already returns the projection, the trend and its caveat. Do
      not recompute a forecast in SQL or Python, and do not query history to
      sanity-check it.
    - customer_health_score already returns the score, every component and the
      customer's average review rating. Do not recompute any component. If the
      user also asked what that customer said, that is exactly one additional
      Review_Search call.
    - code_execution is a last resort, for statistics no other tool can produce at
      all, such as a correlation coefficient or a clustering. Never use it for
      totals, averages, ranking, filtering or percentages - the semantic model
      already has metrics for those.
    - Do not call the same tool more than twice in one turn. If a tool has already
      failed twice, stop: report plainly what failed and answer with what you do
      have. Do not work around a failing tool by hand-writing SQL that
      reimplements it.
    - Aim for the fewest tool calls that fully answer the question. Reaching five
      or more calls on a single-metric question means you have taken a wrong turn -
      stop and answer with what you have.
    - Skills and code_execution are the two slowest things you can do. Do not load
      a skill unless the user asks for that skill's framing by name or asks for
      something it uniquely provides. The sales-versus-sentiment ranking does NOT
      need the review_analyst skill: the semantic model already exposes
      TOTAL_SALES, AVG_RATING and PCT_NEGATIVE_REVIEWS, so one Analyst call ranks
      it. Reaching for the skill there turned a 25-second answer into a
      225-second one.
    - Answer the period you were asked about. If the question says 2023, filter to
      2023; do not silently widen to all history because a filtered query failed.
      If a query errors, fix the query - a correct answer to a different question
      is worse than saying the query failed.

  sample_questions:
    - question: "Which sub-categories have the highest sales but the worst review ratings, and are those the ones being returned?"
    - question: "What were total sales and profit by region, and how did the trend move over 2023?"
    - question: "Why are customers unhappy with our bookcases?"
    - question: "Show me the top 10 products by revenue with their average review rating."
    - question: "What is the projected sales trend for the North region over the next six months?"
    - question: "How healthy is our highest-spending customer, and have they left bad reviews?"
    - question: "Compare return rates and negative review rates across the three regions."
    - question: "Which delivery mode is associated with the worst customer sentiment?"

tools:
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: Superstore_Analyst
      description: >
        Query Superstore sales, profit, discounts, returns, customers, products
        and review ratings as structured data. Two fact grains are modelled -
        order lines and reviews - bridged by conformed PRODUCTS, REGIONS,
        CUSTOMERS and DELIVERY_MODES dimensions; group by one of those whenever a
        question needs sales and review sentiment together. Use for any
        countable question - totals, averages, rankings, trends, comparisons,
        return rates, review counts and average ratings.

  - tool_spec:
      type: cortex_search
      name: Review_Search
      description: >
        Search the free text of customer product reviews and return individual
        reviews with citations. Use to explain WHY customers are satisfied or
        dissatisfied, to find specific complaints or praise, and to quote real
        wording. Filterable by product, category, sub-category, rating, region,
        country, reviewer persona and whether the order was returned. Do not use
        it to count or average - Superstore_Analyst is for that.

  - tool_spec:
      type: data_to_chart
      name: data_to_chart
      description: >
        Render a chart from data already retrieved by another tool. Use for
        rankings of more than three items and for any series over time.

  - tool_spec:
      type: generic
      name: forecast_sales
      description: >
        Project sales forward from the historical monthly trend, for one region
        or all regions, up to 12 months past the end of the data (December 2023).
        Linear trend only, no seasonality.
      # Property names MUST equal the SQL function's parameter names exactly.
      # The agent invokes generic tools with NAMED arguments taken from this
      # schema, so a mismatch fails every call with
      #   "named arguments [REGION] do not match any signature for function ..."
      # and the orchestrator then retries, falls back to raw SQL, and eventually
      # trips its own loop guard. That looks like an over-eager agent; it is
      # actually a broken contract. Hence the P_ prefixes leaking into the schema:
      # the SQL parameters are prefixed to stop them shadowing column names, and
      # the two names have to agree.
      input_schema:
        type: object
        properties:
          P_REGION:
            type: string
            description: "Region to forecast: North, South or Central. Omit or pass null for all regions combined."
          P_MONTHS:
            type: integer
            description: "How many months ahead to project, 1 to 12. Values outside that range are clamped."
        required:
          - P_MONTHS

  - tool_spec:
      type: generic
      name: customer_health_score
      description: >
        Composite 0-100 health score for a single customer, combining recency,
        order frequency, total spend, return rate and average review rating, with
        the component breakdown and a Healthy / Watch / At risk band. Needs the
        customer id, not the name - look the id up with Superstore_Analyst first
        if the user gave a name.
      # Property name must equal the SQL parameter name - see forecast_sales above.
      input_schema:
        type: object
        properties:
          P_CUSTOMER_ID:
            type: string
            description: "Superstore customer id, for example SP-20920."
        required:
          - P_CUSTOMER_ID

  - tool_spec:
      type: generic
      name: summarise_product_reviews
      description: >
        Summarise the recurring themes, complaints and compliments across every
        review of one product id. Use when the user asks about a single specific
        product; use Review_Search instead when the question spans products or
        needs quotable individual reviews.
      # Property name must equal the SQL parameter name - see forecast_sales above.
      input_schema:
        type: object
        properties:
          P_PRODUCT_ID:
            type: string
            description: "Superstore product id, for example FUR-BO-10013167."
        required:
          - P_PRODUCT_ID

tool_resources:
  Superstore_Analyst:
    # semantic_view, not semantic_model_file: no READ ON STAGE grant needed, and
    # verified queries in the view set verified_query_used on the tool result.
    semantic_view: SUPERSTORE.AGENTS.SUPERSTORE_360
    execution_environment:
      type: warehouse
      warehouse: XSMALL
      query_timeout: 60

  Review_Search:
    search_service: SUPERSTORE.AGENTS.PRODUCT_REVIEWS_SEARCH
    # 1000 rather than a handful: this is the analytical-search prerequisite, which
    # lets corpus-wide aggregate questions work. The capability probe confirmed
    # this account accepts it.
    max_results: 1000
    title_column: REVIEW_TITLE
    # A URL column, so citations render as clickable links rather than opaque ids.
    id_column: REVIEW_URL
    columns_and_descriptions:
      REVIEW_TEXT:
        description: "Full text of the customer review. Mentions the product by name, then the reviewer's experience of it."
        type: string
        searchable: true
      REVIEW_TITLE:
        description: "Short headline the reviewer gave, e.g. 'Absolute waste of money'."
        type: string
        searchable: true
      PRODUCT_NAME:
        description: "Full product name the review refers to."
        type: string
        searchable: true
        filterable: true
      DELIVERY_MODE:
        description: "How the order shipped: Standard Class, Second Class, First Class or Same Day."
        type: string
        filterable: true
      RATING:
        description: "Star rating 1 to 5. 1-2 is negative, 3 neutral, 4-5 positive."
        type: number
        filterable: true
      SUB_CATEGORY:
        description: "Product sub-category, e.g. Bookcases, Phones, Binders, Copiers."
        type: string
        filterable: true
      CATEGORY:
        description: "Furniture, Office Supplies or Technology."
        type: string
        filterable: true
      REGION:
        description: "Sales region the order shipped to: North, South or Central."
        type: string
        filterable: true
      COUNTRY_REGION:
        description: "European country the order shipped to."
        type: string
        filterable: true
      PERSONA:
        description: "Role of the reviewer, e.g. Office manager, IT administrator, Procurement lead."
        type: string
        filterable: true
      WAS_RETURNED:
        description: "True when the order behind this review was actually returned."
        type: boolean
        filterable: true
      VERIFIED_PURCHASE:
        description: "True when the reviewer is a confirmed purchaser."
        type: boolean
        filterable: true

  forecast_sales:
    type: function
    identifier: SUPERSTORE.AGENTS.FORECAST_SALES
    execution_environment:
      type: warehouse
      warehouse: XSMALL
      query_timeout: 60

  customer_health_score:
    type: function
    identifier: SUPERSTORE.AGENTS.CUSTOMER_HEALTH_SCORE
    execution_environment:
      type: warehouse
      warehouse: XSMALL
      query_timeout: 60

  summarise_product_reviews:
    type: function
    identifier: SUPERSTORE.AGENTS.SUMMARISE_PRODUCT_REVIEWS
    execution_environment:
      type: warehouse
      warehouse: XSMALL
      query_timeout: 120
$$;

DESCRIBE AGENT SUPERSTORE.AGENTS.SUPERSTORE_360_AGENT;
