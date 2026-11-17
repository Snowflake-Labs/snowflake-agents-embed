-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Cortex Search service over the review corpus.
--
-- This is the object that makes the agent emit event types nothing in this repo
-- has ever received from a live stream: response.text.annotation (citations) and
-- a cortex_search tool_use. packages/chat-core/src/api/agentRun.ts already parses
-- both; until now no configured tool could produce them.
--
-- EMBEDDING_MODEL is pinned rather than left to default because analytical search
-- (Open Preview) needs both a TEXT and a VECTOR index, and arctic-embed-l-v2.0 is
-- the model documented for it. The capability probe confirmed this account accepts
-- max_results up to 1000, which is the other analytical-search prerequisite; that
-- is set in the agent spec, not here.
--
-- ATTRIBUTES are the filterable columns. Anything the agent might reasonably want
-- to filter on has to be listed here or the filter is silently unavailable.

CREATE OR REPLACE CORTEX SEARCH SERVICE SUPERSTORE.AGENTS.PRODUCT_REVIEWS_SEARCH
  ON REVIEW_TEXT
  -- PRODUCT_NAME is an ATTRIBUTE as well as searchable text. The tool description
  -- promises the corpus is "filterable by product", and users name products rather
  -- than quoting ids, so the agent tried to filter on it and got back
  -- "Invalid filter query: Column PRODUCT_NAME does not exist as a filter" - then
  -- told the user the corpus does not support that filter, which was our fault.
  ATTRIBUTES PRODUCT_ID, PRODUCT_NAME, CATEGORY, SUB_CATEGORY, RATING, REGION,
             COUNTRY_REGION, VERIFIED_PURCHASE, PERSONA, WAS_RETURNED, DELIVERY_MODE
  WAREHOUSE = XSMALL
  TARGET_LAG = '1 hour'
  EMBEDDING_MODEL = 'snowflake-arctic-embed-l-v2.0'
  COMMENT = 'Synthetic Superstore product reviews. Backs the Review_Search tool on SUPERSTORE_360_AGENT.'
  AS
SELECT
  REVIEW_TEXT,
  REVIEW_TITLE,
  -- REVIEW_URL exists purely so the agent spec can set id_column to a URL, which
  -- is what turns citations into clickable links instead of opaque ids.
  REVIEW_URL,
  REVIEW_ID,
  PRODUCT_ID,
  PRODUCT_NAME,
  CATEGORY,
  SUB_CATEGORY,
  CUSTOMER_NAME,
  REGION,
  COUNTRY_REGION,
  RATING,
  PERSONA,
  REVIEW_DATE,
  VERIFIED_PURCHASE,
  HELPFUL_VOTES,
  WAS_RETURNED,
  -- Filterable so that "what do people say about same-day deliveries" can narrow
  -- the corpus before ranking, rather than hoping the phrase appears in the text.
  DELIVERY_MODE
FROM SUPERSTORE.AGENTS.PRODUCT_REVIEWS;

-- Indexing is asynchronous. 09_verify.sql asserts ACTIVE; this is just the
-- first look, and a PENDING here immediately after creation is expected.
SHOW CORTEX SEARCH SERVICES LIKE 'PRODUCT_REVIEWS_SEARCH' IN SCHEMA SUPERSTORE.AGENTS;
