-- Copyright 2026 Snowflake Inc.
-- SPDX-License-Identifier: Apache-2.0
-- The Analyst tool's semantic layer.
--
-- Derived from SUPERSTORE.PUBLIC.SUPERSTORE_ANALYSIS, which was already a good
-- semantic view (20 dimensions, 4 facts, 23 metrics including window metrics) and
-- which no agent was using -- SUPERSTORE_SALES_AGENT points at a stage YAML
-- instead. Rather than rewrite it, this is that view plus a fourth logical table
-- for reviews. SUPERSTORE_ANALYSIS itself is left in place, unmodified.
--
-- Two reasons the agent points at a semantic view rather than the stage YAML:
--   * no READ ON STAGE grant needed, so the grant tree is smaller;
--   * verified queries, which set verified_query_used on the tool result. The UI
--     already renders that as a badge (commit 3937ce9) and nothing has ever set it.
--
-- Adding REVIEWS makes this a four-grain model: ORDERS is line-item grain, RETURNS
-- is order grain, PEOPLE is region grain, REVIEWS is review grain. That is
-- deliberate -- cross-grain aggregation is where text-to-SQL most often gets it
-- wrong, so it is worth having in the test surface.

-- A conformed product dimension, which the semantic view needs for a structural
-- reason: a RELATIONSHIP may only reference the primary or unique key of the
-- target table. ORDERS is keyed on ROW_ID and REVIEWS on REVIEW_ID, so
-- REVIEWS(PRODUCT_ID) -> ORDERS(PRODUCT_ID) is rejected outright
-- ("the referenced key ... must be the primary or unique key"). Both fact tables
-- pointing at a real product dimension is also just the correct model.
--
-- MIN(PRODUCT_NAME) rather than ANY_VALUE because the source data is dirty: 1,915
-- distinct PRODUCT_IDs carry 1,938 distinct id/name pairs, so 23 ids have more
-- than one spelling of their name. MIN makes the collapse deterministic across
-- re-runs instead of letting the search index churn. SUB_CATEGORY is clean.
CREATE OR REPLACE TABLE SUPERSTORE.AGENTS.PRODUCTS AS
SELECT
  PRODUCT_ID,
  MIN(PRODUCT_NAME) AS PRODUCT_NAME,
  MIN(CATEGORY)     AS CATEGORY,
  MIN(SUB_CATEGORY) AS SUB_CATEGORY
FROM SUPERSTORE.PUBLIC.ORDERS_V
GROUP BY PRODUCT_ID;

ALTER TABLE SUPERSTORE.AGENTS.PRODUCTS
  ADD PRIMARY KEY (PRODUCT_ID);

-- ---------------------------------------------------------------------------
-- Three more conformed dimensions, for the same reason as PRODUCTS
-- ---------------------------------------------------------------------------
-- PRODUCTS alone was not enough. With it as the ONLY bridge between ORDERS and
-- REVIEWS, a cross-grain question works when it groups by a product attribute and
-- is rejected outright otherwise:
--
--   DIMENSIONS PRODUCTS.CATALOGUE_SUB_CATEGORY  METRICS TOTAL_SALES, AVG_RATING  -> ok
--   DIMENSIONS ORDERS.REGION                    METRICS TOTAL_SALES, AVG_RATING  -> "The
--   DIMENSIONS ORDERS.CUSTOMER_ID               ...                                 entities
--   DIMENSIONS ORDERS.DELIVERY_MODE             ...                                 'ORDERS' and
--                                                                                   'REVIEWS' are
--                                                                                   not related"
--
-- That is not a cosmetic gap. Three of the agent's own eight sample questions ask
-- for sales or returns alongside sentiment sliced by region, customer or delivery
-- mode. Live, one of them ran for the full 300s orchestration budget and returned
-- no text at all, and another was reduced to guessing. Giving each shared key a
-- real one-row-per-value dimension table is the standard fix and is what the
-- PRODUCTS comment above was already reaching for.
--
-- REGIONS also repairs a false key. The view used to join ORDERS(REGION) straight
-- to PEOPLE_V and declare PRIMARY KEY (REGION) on it, but PEOPLE_V holds 6 rows
-- for 3 regions - a real manager name plus an email address per region. The
-- declared key was simply untrue, so every region had two managers and totalling
-- sales by manager double counted: £5.87M against a true £2.94M. Collapsing to one
-- row per region makes the key honest; the manager name rides along as an
-- attribute. Human names are preferred over the email rows.
CREATE OR REPLACE TABLE SUPERSTORE.AGENTS.REGIONS AS
SELECT
  REGION,
  COALESCE(
    MIN(CASE WHEN PERSON_NAME NOT LIKE '%@%' THEN PERSON_NAME END),
    MIN(PERSON_NAME)
  ) AS MANAGER_NAME
FROM SUPERSTORE.PUBLIC.PEOPLE_V
GROUP BY REGION;

ALTER TABLE SUPERSTORE.AGENTS.REGIONS
  ADD PRIMARY KEY (REGION);

-- MIN() again for determinism: CUSTOMER_ID is not perfectly clean on name or
-- segment in the source, exactly as PRODUCT_ID is not clean on name.
CREATE OR REPLACE TABLE SUPERSTORE.AGENTS.CUSTOMERS AS
SELECT
  CUSTOMER_ID,
  MIN(CUSTOMER_NAME) AS CUSTOMER_NAME,
  MIN(SEGMENT)       AS SEGMENT,
  MIN(REGION)        AS HOME_REGION
FROM SUPERSTORE.PUBLIC.ORDERS_V
GROUP BY CUSTOMER_ID;

ALTER TABLE SUPERSTORE.AGENTS.CUSTOMERS
  ADD PRIMARY KEY (CUSTOMER_ID);

-- ORDER_LINES is ORDERS_V with one column added: whether the order was returned.
-- Without it, RETURN_RATE has to divide a RETURNS-table metric by an ORDERS-table
-- metric, and RETURNS is reachable ONLY from ORDERS - no conformed dimension
-- touches it. So "compare return rates across regions" fails with "the dimension
-- entity 'REGIONS' is not directly related to the base metric entity 'RETURNS'",
-- which is precisely the question that burned the whole 300s budget and returned
-- nothing. Carrying the flag on the line makes return rate an ORDERS-grain metric,
-- reachable by region, customer, product and delivery mode alike.
--
-- EXISTS rather than a join, for the same fan-out reason as everywhere else in
-- this pipeline: RETURNS_V has 637 rows over 284 order ids.
CREATE OR REPLACE TABLE SUPERSTORE.AGENTS.ORDER_LINES AS
SELECT
  o.*,
  EXISTS (
    SELECT 1 FROM SUPERSTORE.PUBLIC.RETURNS_V r
    WHERE r.ORDER_ID = o.ORDER_ID AND r.IS_RETURNED
  ) AS WAS_RETURNED
FROM SUPERSTORE.PUBLIC.ORDERS_V o;

ALTER TABLE SUPERSTORE.AGENTS.ORDER_LINES
  ADD PRIMARY KEY (ROW_ID);

-- Four rows. Trivial, but it is what lets sales and sentiment meet at delivery
-- mode instead of being averaged across every mode a product ever shipped by.
CREATE OR REPLACE TABLE SUPERSTORE.AGENTS.DELIVERY_MODES AS
SELECT DISTINCT DELIVERY_MODE
FROM SUPERSTORE.PUBLIC.ORDERS_V
WHERE DELIVERY_MODE IS NOT NULL;

ALTER TABLE SUPERSTORE.AGENTS.DELIVERY_MODES
  ADD PRIMARY KEY (DELIVERY_MODE);

CREATE OR REPLACE SEMANTIC VIEW SUPERSTORE.AGENTS.SUPERSTORE_360
  TABLES (
    ORDERS AS SUPERSTORE.AGENTS.ORDER_LINES
      PRIMARY KEY (ROW_ID)
      WITH SYNONYMS = ('sales orders','transactions','order data','sales data')
      COMMENT = 'Core sales transaction data with customer, product, location and financial details - line item grain',
    REGIONS AS SUPERSTORE.AGENTS.REGIONS
      PRIMARY KEY (REGION)
      WITH SYNONYMS = ('regions','sales regions','territories','sales managers','regional managers')
      COMMENT = 'One row per sales region with its manager. The conformed dimension joining sales to reviews by region. Replaces a direct join to PEOPLE_V, which has two rows per region and so double counted.',
    CUSTOMERS AS SUPERSTORE.AGENTS.CUSTOMERS
      PRIMARY KEY (CUSTOMER_ID)
      WITH SYNONYMS = ('customers','accounts','buyers','customer master')
      COMMENT = 'One row per customer. The conformed dimension joining sales to reviews by customer.',
    DELIVERY_MODES AS SUPERSTORE.AGENTS.DELIVERY_MODES
      PRIMARY KEY (DELIVERY_MODE)
      WITH SYNONYMS = ('delivery modes','shipping modes','ship modes','delivery options')
      COMMENT = 'One row per delivery mode. The conformed dimension joining sales to reviews by how the order shipped.',
    RETURNS AS SUPERSTORE.PUBLIC.RETURNS_V
      PRIMARY KEY (ORDER_ID)
      WITH SYNONYMS = ('returned orders','product returns','return data','refunds')
      COMMENT = 'Product return information at order grain - which orders had returns',
    PRODUCTS AS SUPERSTORE.AGENTS.PRODUCTS
      PRIMARY KEY (PRODUCT_ID)
      WITH SYNONYMS = ('products','product catalogue','items','SKUs','product master')
      COMMENT = 'One row per product. The conformed dimension joining sales to reviews.',
    REVIEWS AS SUPERSTORE.AGENTS.PRODUCT_REVIEWS
      PRIMARY KEY (REVIEW_ID)
      WITH SYNONYMS = ('reviews','product reviews','customer reviews','ratings','feedback','review data')
      COMMENT = 'Customer product reviews at review grain. One row per review, joined to orders by PRODUCT_ID. Star ratings 1-5. Free-text bodies are searchable via the Review_Search tool; use this table for counts and averages, not for reading review text.'
  )
  -- Both fact tables point at every conformed dimension. That symmetry is the
  -- whole point: a shared key is only usable cross-grain if BOTH sides reach it.
  RELATIONSHIPS (
    ORDERS_TO_RETURNS   AS ORDERS(ORDER_ID)      REFERENCES RETURNS(ORDER_ID),
    ORDERS_TO_PRODUCTS  AS ORDERS(PRODUCT_ID)    REFERENCES PRODUCTS(PRODUCT_ID),
    ORDERS_TO_REGIONS   AS ORDERS(REGION)        REFERENCES REGIONS(REGION),
    ORDERS_TO_CUSTOMERS AS ORDERS(CUSTOMER_ID)   REFERENCES CUSTOMERS(CUSTOMER_ID),
    ORDERS_TO_MODES     AS ORDERS(DELIVERY_MODE) REFERENCES DELIVERY_MODES(DELIVERY_MODE),
    REVIEWS_TO_PRODUCTS  AS REVIEWS(PRODUCT_ID)    REFERENCES PRODUCTS(PRODUCT_ID),
    REVIEWS_TO_REGIONS   AS REVIEWS(REGION)        REFERENCES REGIONS(REGION),
    REVIEWS_TO_CUSTOMERS AS REVIEWS(CUSTOMER_ID)   REFERENCES CUSTOMERS(CUSTOMER_ID),
    REVIEWS_TO_MODES     AS REVIEWS(DELIVERY_MODE) REFERENCES DELIVERY_MODES(DELIVERY_MODE)
  )
  FACTS (
    -- Synonym ownership rule used throughout this view: a bare business word
    -- ('revenue', 'profit', 'discount', 'rating') belongs to the AGGREGATE METRIC,
    -- because that is what someone asking "what was revenue" means. The row-level
    -- fact keeps only explicitly line-level wording. Facts, dimensions and metrics
    -- share one synonym namespace per logical table, so a word on both sides is
    -- ambiguous -- Analyst still answers, it just may bind to the wrong one and
    -- return a plausible wrong number. check-synonyms.sh enforces this.
    ORDERS.SALES_AMOUNT AS orders.SALES
      WITH SYNONYMS = ('sales amount','sale value','line sales','line item sales')
      COMMENT = 'Revenue for a single order line. Already NET of any discount - see ESTIMATED_DISCOUNT_GBP.',
    ORDERS.QUANTITY AS orders.QUANTITY
      WITH SYNONYMS = ('units','units ordered','line quantity')
      COMMENT = 'Number of product units on a single order line',
    -- Renamed from DISCOUNT_AMOUNT, which was actively misleading: the source
    -- column is a RATE on a 0-1 scale (observed 0.00 to 0.85, mean 0.103), not a
    -- money amount. Every synonym implying money has moved to
    -- ESTIMATED_DISCOUNT_GBP below.
    ORDERS.DISCOUNT_RATE AS orders.DISCOUNT
      WITH SYNONYMS = ('discount percentage','discount percent','percentage off','line discount rate')
      COMMENT = 'Discount RATE applied to the order line, 0 to 1 (0.2 = 20% off). Not a currency amount.',
    -- 'margin' removed as well as the aggregate words: an absolute profit amount
    -- is not a margin, and PROFIT_MARGIN below is the ratio.
    ORDERS.PROFIT_AMOUNT AS orders.PROFIT
      WITH SYNONYMS = ('profit amount','line profit','line item profit')
      COMMENT = 'Profit for a single order line, after costs and discount',

    -- The money value of the discount, which the source data does not carry.
    -- ASSUMPTION: SALES is net of discount (the standard Superstore convention,
    -- i.e. sales = list x (1 - discount)), so list = sales / (1 - discount) and the
    -- discount given = sales x rate / (1 - rate). Stated explicitly because every
    -- currency metric involving discount depends on it. The guard is belt-and-braces:
    -- the observed maximum rate is 0.85, so the denominator cannot reach zero.
    ORDERS.ESTIMATED_DISCOUNT_GBP AS
      IFF(orders.DISCOUNT >= 1, NULL,
          orders.SALES * orders.DISCOUNT / NULLIF(1 - orders.DISCOUNT, 0))
      WITH SYNONYMS = ('discount amount','discount value','money discounted','discount in pounds')
      COMMENT = 'Estimated discount given on the line, in GBP. Derived, assuming SALES is already net of discount.',
    PRIVATE ORDERS.ROW_COUNT AS 1
      COMMENT = 'Internal counter for aggregation calculations',
    REVIEWS.RATING_VALUE AS reviews.RATING
      WITH SYNONYMS = ('stars','score','review score','rating value')
      COMMENT = 'Star rating on a single review, 1 (worst) to 5 (best). Aggregate with AVG_RATING.',
    REVIEWS.HELPFUL_VOTES AS reviews.HELPFUL_VOTES
      WITH SYNONYMS = ('helpful votes','upvotes','helpfulness')
      COMMENT = 'Number of other customers who marked this review helpful',
    PRIVATE REVIEWS.REVIEW_ROW_COUNT AS 1
      COMMENT = 'Internal counter for review aggregation',
    PRIVATE REVIEWS.IS_NEGATIVE AS IFF(reviews.RATING <= 2, 1, 0)
      COMMENT = 'Internal flag: review is 1 or 2 stars'
  )
  DIMENSIONS (
    ORDERS.ORDER_DATE AS orders.ORDER_DATE
      WITH SYNONYMS = ('order date','purchase date','transaction date','sale date','date ordered')
      COMMENT = 'Date when the order was placed by the customer',
    ORDERS.ORDER_YEAR AS YEAR(orders.ORDER_DATE)
      WITH SYNONYMS = ('year','order year','sales year','transaction year')
      COMMENT = 'Calendar year extracted from the order date',
    ORDERS.ORDER_MONTH AS MONTH(orders.ORDER_DATE)
      WITH SYNONYMS = ('month','order month','sales month','calendar month')
      COMMENT = 'Calendar month number (1-12) extracted from the order date',
    ORDERS.ORDER_QUARTER AS QUARTER(orders.ORDER_DATE)
      WITH SYNONYMS = ('quarter','fiscal quarter','Q','order quarter')
      COMMENT = 'Calendar quarter (1-4) extracted from the order date',
    ORDERS.DISPATCH_DATE AS orders.DISPATCH_DATE
      WITH SYNONYMS = ('ship date','shipment date','dispatch date','shipping date','sent date')
      COMMENT = 'Date when the order was dispatched for delivery',
    ORDERS.CUSTOMER_ID AS orders.CUSTOMER_ID
      WITH SYNONYMS = ('customer ID','customer identifier','customer code','client ID')
      COMMENT = 'Unique identifier for the customer who placed the order',
    ORDERS.CUSTOMER_NAME AS orders.CUSTOMER_NAME
      WITH SYNONYMS = ('customer','customer name','client name','client','buyer name')
      COMMENT = 'Full name of the customer who placed the order',
    ORDERS.CUSTOMER_SEGMENT AS orders.SEGMENT
      WITH SYNONYMS = ('segment','customer segment','customer type','market segment','customer category')
      COMMENT = 'Customer segment classification: Consumer, Corporate, or Home Office',
    ORDERS.REGION AS orders.REGION
      WITH SYNONYMS = ('region','sales region','territory','geographic region','area')
      COMMENT = 'Geographic sales region: North, South, or Central',
    ORDERS.STATE_PROVINCE AS orders.STATE_PROVINCE
      WITH SYNONYMS = ('state','province','state/province','state or province')
      COMMENT = 'State or province where the order was shipped',
    ORDERS.CITY AS orders.CITY
      WITH SYNONYMS = ('city','location','city name','municipality')
      COMMENT = 'City where the order was shipped',
    ORDERS.COUNTRY_REGION AS orders.COUNTRY_REGION
      WITH SYNONYMS = ('country','country/region','nation','country name')
      COMMENT = 'Country where the order was shipped. This dataset covers 15 European countries.',
    ORDERS.PRODUCT_ID AS orders.PRODUCT_ID
      WITH SYNONYMS = ('product ID','SKU','product code','item ID','product identifier')
      COMMENT = 'Unique identifier for the product ordered',
    ORDERS.PRODUCT_NAME AS orders.PRODUCT_NAME
      WITH SYNONYMS = ('product','product name','item name','item','product description')
      COMMENT = 'Full descriptive name of the product ordered',
    ORDERS.CATEGORY AS orders.CATEGORY
      WITH SYNONYMS = ('category','product category','product type','main category')
      COMMENT = 'Primary product category: Furniture, Office Supplies, or Technology',
    ORDERS.SUB_CATEGORY AS orders.SUB_CATEGORY
      WITH SYNONYMS = ('subcategory','sub-category','product subcategory','sub category','subtype')
      COMMENT = 'Detailed product subcategory within the main category',
    ORDERS.DELIVERY_MODE AS orders.DELIVERY_MODE
      WITH SYNONYMS = ('shipping mode','delivery method','ship mode','shipping method','delivery type')
      COMMENT = 'Method used to ship the order to the customer',
    -- Product attributes are exposed on both ORDERS (as they have always been) and
    -- PRODUCTS. The PRODUCTS copies are what a review-only question groups by,
    -- since reaching ORDERS.CATEGORY from REVIEWS would otherwise fan out through
    -- the line-item grain and inflate the counts.
    PRODUCTS.CATALOGUE_PRODUCT_NAME AS products.PRODUCT_NAME
      WITH SYNONYMS = ('product','product name','item','catalogue product')
      COMMENT = 'Product name from the conformed product dimension - one value per product id',
    PRODUCTS.CATALOGUE_CATEGORY AS products.CATEGORY
      WITH SYNONYMS = ('category','product category')
      COMMENT = 'Product category from the conformed product dimension',
    PRODUCTS.CATALOGUE_SUB_CATEGORY AS products.SUB_CATEGORY
      WITH SYNONYMS = ('subcategory','sub-category','product subcategory')
      COMMENT = 'Product sub-category from the conformed product dimension. Prefer this when grouping reviews by sub-category.',
    -- Backs the ORDERS.RETURN_RATE metric. Distinct synonyms from
    -- RETURNS.IS_RETURNED so the two cannot be confused: this one is line grain and
    -- reachable from every conformed dimension, that one is order grain and only
    -- reachable from ORDERS.
    ORDERS.ORDER_WAS_RETURNED AS orders.WAS_RETURNED
      WITH SYNONYMS = ('order was returned','line was returned','returned order flag')
      COMMENT = 'Whether the order this line belongs to was returned. Denormalised onto the line so return rate can be sliced by any conformed dimension.',
    -- Conformed keys. Prefer these over the ORDERS-side copies whenever a question
    -- needs sales or returns AND review sentiment in the same result, because only
    -- these reach both fact tables.
    REGIONS.SALES_REGION AS regions.REGION
      WITH SYNONYMS = ('sales region','territory')
      COMMENT = 'Sales region from the conformed region dimension. Use this when combining sales or returns with review sentiment by region.',
    REGIONS.REGION_MANAGER AS regions.MANAGER_NAME
      WITH SYNONYMS = ('manager','regional manager','sales manager','person','manager name')
      COMMENT = 'Name of the sales manager responsible for the region - exactly one per region',
    CUSTOMERS.CUSTOMER_ACCOUNT_ID AS customers.CUSTOMER_ID
      WITH SYNONYMS = ('customer account','account id','conformed customer id')
      COMMENT = 'Customer id from the conformed customer dimension. Use this when combining spend with review sentiment for the same customer.',
    CUSTOMERS.CUSTOMER_ACCOUNT_NAME AS customers.CUSTOMER_NAME
      WITH SYNONYMS = ('customer account name','account name')
      COMMENT = 'Customer name from the conformed customer dimension - one value per customer id',
    CUSTOMERS.CUSTOMER_ACCOUNT_SEGMENT AS customers.SEGMENT
      WITH SYNONYMS = ('account segment','conformed segment')
      COMMENT = 'Customer segment from the conformed customer dimension',
    DELIVERY_MODES.SHIPPING_MODE AS delivery_modes.DELIVERY_MODE
      WITH SYNONYMS = ('shipping mode','ship mode','delivery option','shipping method')
      COMMENT = 'Delivery mode from the conformed dimension. Use this when combining sales or returns with review sentiment by delivery mode.',
    RETURNS.ORDER_ID AS returns.ORDER_ID
      WITH SYNONYMS = ('returned order ID','return order identifier')
      COMMENT = 'Order ID for the returned order - links to orders',
    RETURNS.IS_RETURNED AS returns.IS_RETURNED
      WITH SYNONYMS = ('returned','is returned','return status','returned flag','was returned')
      COMMENT = 'Boolean flag indicating whether this order was returned',
    REVIEWS.REVIEW_RATING AS reviews.RATING
      WITH SYNONYMS = ('star rating','rating band','stars given','review rating')
      COMMENT = 'Star rating as a dimension, for grouping reviews into 1-5 star bands',
    REVIEWS.REVIEW_DATE AS reviews.REVIEW_DATE
      WITH SYNONYMS = ('review date','date reviewed','feedback date')
      COMMENT = 'Date the review was submitted, 1 to 30 days after the order date',
    REVIEWS.REVIEW_YEAR AS YEAR(reviews.REVIEW_DATE)
      WITH SYNONYMS = ('review year','year reviewed')
      COMMENT = 'Calendar year the review was submitted',
    REVIEWS.VERIFIED_PURCHASE AS reviews.VERIFIED_PURCHASE
      WITH SYNONYMS = ('verified','verified purchase','confirmed buyer')
      COMMENT = 'Whether the reviewer is a confirmed purchaser of the product',
    REVIEWS.REVIEWER_PERSONA AS reviews.PERSONA
      WITH SYNONYMS = ('persona','reviewer type','reviewer role','buyer type')
      COMMENT = 'Role the reviewer occupies, e.g. Office manager, IT administrator, Procurement lead',
    REVIEWS.REVIEW_SUB_CATEGORY AS reviews.SUB_CATEGORY
      WITH SYNONYMS = ('reviewed subcategory','review sub-category')
      COMMENT = 'Product sub-category the review refers to',
    REVIEWS.REVIEW_PRODUCT_ID AS reviews.PRODUCT_ID
      WITH SYNONYMS = ('reviewed product','reviewed product ID','reviewed SKU')
      COMMENT = 'Product the review refers to - joins to orders'
  )
  METRICS (
    -- Every metric below is TABLE-SCOPED, deliberately, including the derived ones
    -- inherited from SUPERSTORE_ANALYSIS. A metric declared without a table prefix
    -- becomes view-level and must then be referenced BARE inside the
    -- SEMANTIC_VIEW(... METRICS ...) clause, while table-scoped ones must be
    -- qualified. That split is invisible in the DDL and cost three of eight sample
    -- questions a failed call each: the agent qualified PCT_NEGATIVE_REVIEWS - the
    -- obvious thing to do, given every neighbouring metric requires it - and got
    -- "invalid identifier 'REVIEWS.PCT_NEGATIVE_REVIEWS'". Scoping them all removes
    -- the special case instead of documenting it. SALES_PER_REVIEW is the sole
    -- exception: it spans ORDERS and REVIEWS, so it cannot belong to either.
    ORDERS.TOTAL_SALES AS SUM(orders.sales_amount)
      WITH SYNONYMS = ('sales','revenue','total revenue','gross sales','total sales','sales total')
      COMMENT = 'Total revenue across all order lines, net of discount',
    ORDERS.AVERAGE_SALES AS AVG(orders.sales_amount)
      WITH SYNONYMS = ('average revenue','avg sales','mean sales','average sale')
      COMMENT = 'Average revenue per order line',
    -- Inherited from SUPERSTORE_ANALYSIS, where this claimed 'order count' and
    -- 'number of orders'. It counts LINES, and the dataset averages ~2 lines per
    -- order, so binding "how many orders did we take" here overstates by ~2x.
    -- Those two phrases now belong to UNIQUE_ORDERS, which actually counts orders.
    ORDERS.SALES_COUNT AS COUNT(orders.row_count)
      WITH SYNONYMS = ('transaction count','line count','order line count','sale count','number of order lines')
      COMMENT = 'Total number of sales transaction LINES, not orders. For orders use UNIQUE_ORDERS.',
    ORDERS.TOTAL_PROFIT AS SUM(orders.profit_amount)
      WITH SYNONYMS = ('profit','total earnings','net profit','total profit','earnings')
      COMMENT = 'Total profit across all orders',
    ORDERS.AVERAGE_PROFIT AS AVG(orders.profit_amount)
      WITH SYNONYMS = ('avg profit','mean profit','average profit per order')
      COMMENT = 'Average profit per order line',
    ORDERS.PROFIT_MARGIN AS (orders.total_profit / NULLIF(orders.total_sales, 0)) * 100
      WITH SYNONYMS = ('margin','profit margin percentage','profitability','margin percent','profit %')
      COMMENT = 'Profit as a percentage of sales',
    ORDERS.TOTAL_QUANTITY AS SUM(orders.quantity)
      WITH SYNONYMS = ('units sold','total units','quantity sold','total quantity','items sold')
      COMMENT = 'Total number of product units sold',
    ORDERS.AVERAGE_QUANTITY AS AVG(orders.quantity)
      WITH SYNONYMS = ('avg quantity','average units','mean quantity','avg units per order')
      COMMENT = 'Average units per order line',
    -- Was SUM(discount_amount), i.e. a sum of PERCENTAGES: it returned 1031.05 for
    -- the whole dataset and was then subtracted from GBP revenue by NET_REVENUE as
    -- though it were money. Now sums the derived GBP fact.
    ORDERS.TOTAL_DISCOUNT_GBP AS SUM(orders.estimated_discount_gbp)
      WITH SYNONYMS = ('discount','total discount','discount total','total discounts given','discount given')
      COMMENT = 'Estimated total discount given, in GBP. Derived - see ESTIMATED_DISCOUNT_GBP for the assumption.',
    ORDERS.AVERAGE_DISCOUNT_RATE AS AVG(orders.discount_rate)
      WITH SYNONYMS = ('avg discount','discount rate','average discount','mean discount','average discount rate')
      COMMENT = 'Average discount RATE per order line, 0 to 1',
    ORDERS.UNIQUE_CUSTOMERS AS COUNT(DISTINCT orders.customer_id)
      WITH SYNONYMS = ('customer count','number of customers','distinct customers','customer base')
      COMMENT = 'Count of distinct customers',
    ORDERS.AVERAGE_ORDER_VALUE AS orders.total_sales / NULLIF(orders.sales_count, 0)
      WITH SYNONYMS = ('AOV','avg order value','average transaction value','average basket')
      COMMENT = 'Average revenue per order line',
    ORDERS.CUMULATIVE_SALES AS SUM(orders.total_sales) OVER (
        PARTITION BY EXCLUDING orders.order_date
        ORDER BY orders.order_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      )
      WITH SYNONYMS = ('running total','cumulative revenue','running sales total','YTD sales')
      COMMENT = 'Running total of sales over time',
    ORDERS.MOVING_AVG_SALES_7D AS AVG(orders.total_sales) OVER (
        PARTITION BY EXCLUDING orders.order_date
        ORDER BY orders.order_date
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
      )
      WITH SYNONYMS = ('moving average','7-day average','rolling average','MA7')
      COMMENT = '7-day moving average of sales',
    ORDERS.PROFIT_VS_PREVIOUS_MONTH AS orders.total_profit - LAG(orders.total_profit) OVER (
        PARTITION BY EXCLUDING orders.order_month
        ORDER BY orders.order_month
      )
      WITH SYNONYMS = ('profit change','month over month profit','MoM profit','profit variance')
      COMMENT = 'Change in profit versus the previous month',
    RETURNS.RETURN_COUNT AS COUNT(returns.is_returned)
      WITH SYNONYMS = ('returned orders','number of returns','return count','returns','orders returned')
      COMMENT = 'Count of orders that were returned (order grain, not line-item)',
    RETURNS.DISTINCT_RETURNED_ORDERS AS COUNT(DISTINCT returns.order_id)
      WITH SYNONYMS = ('unique returned orders','distinct returns','unique return orders')
      COMMENT = 'Count of distinct returned orders',
    -- Replaces NET_REVENUE (total_sales - total_discount), which was wrong twice
    -- over: it subtracted a sum of rates from a sum of pounds, and SALES is already
    -- net of discount, so "revenue after discount" is simply TOTAL_SALES. The
    -- useful figure in the other direction is what we would have billed at list.
    ORDERS.LIST_PRICE_SALES AS orders.total_sales + orders.total_discount_gbp
      WITH SYNONYMS = ('list price sales','sales before discount','undiscounted sales','gross billing')
      COMMENT = 'Estimated revenue at list price, before discount. TOTAL_SALES is already the net figure.',
    ORDERS.MARGIN_BEFORE_DISCOUNT AS (orders.total_profit + orders.total_discount_gbp)
                               / NULLIF(orders.total_sales + orders.total_discount_gbp, 0) * 100
      WITH SYNONYMS = ('gross margin','gross margin %','gross profitability','margin before discount','pre-discount margin')
      COMMENT = 'Margin that would have been earned at list price, i.e. adding the discount back to both profit and revenue',
    ORDERS.REVENUE_PER_CUSTOMER AS orders.total_sales / NULLIF(orders.unique_customers, 0)
      WITH SYNONYMS = ('customer lifetime value','CLV','revenue per unique customer','avg customer revenue')
      COMMENT = 'Average revenue per unique customer',
    ORDERS.PROFIT_PER_UNIT AS orders.total_profit / NULLIF(orders.total_quantity, 0)
      WITH SYNONYMS = ('unit profitability','profit per item','per unit profit')
      COMMENT = 'Average profit per unit sold',
    ORDERS.DISCOUNT_IMPACT_ON_PROFIT AS (orders.total_discount_gbp / NULLIF(orders.total_profit, 0)) * 100
      WITH SYNONYMS = ('discount to profit ratio','discount impact %','promotional cost ratio')
      COMMENT = 'Estimated discount given as a percentage of profit earned',
    -- Review metrics. AVG_RATING and PCT_NEGATIVE_REVIEWS are the two that make the
    -- hybrid "high sales but bad reviews" question answerable in SQL alone, so the
    -- agent can rank on them and then use Review_Search to explain why.
    REVIEWS.AVG_RATING AS AVG(reviews.rating_value)
      WITH SYNONYMS = ('average rating','mean rating','average stars','avg review score','rating')
      COMMENT = 'Average star rating, 1 to 5. Lower is worse.',
    REVIEWS.REVIEW_COUNT AS COUNT(reviews.review_row_count)
      WITH SYNONYMS = ('number of reviews','review count','how many reviews','total reviews')
      COMMENT = 'Number of reviews',
    REVIEWS.NEGATIVE_REVIEW_COUNT AS SUM(reviews.is_negative)
      WITH SYNONYMS = ('bad reviews','negative reviews','one and two star reviews','complaints')
      COMMENT = 'Number of reviews rated 1 or 2 stars',
    REVIEWS.PCT_NEGATIVE_REVIEWS AS (reviews.negative_review_count / NULLIF(reviews.review_count, 0)) * 100
      WITH SYNONYMS = ('negative review rate','percent negative','bad review percentage','complaint rate')
      COMMENT = 'Percentage of reviews rated 1 or 2 stars - the headline dissatisfaction measure',
    REVIEWS.AVG_HELPFUL_VOTES AS AVG(reviews.helpful_votes)
      WITH SYNONYMS = ('average helpful votes','avg helpfulness')
      COMMENT = 'Average number of helpful votes per review',
    SALES_PER_REVIEW AS orders.total_sales / NULLIF(reviews.review_count, 0)
      WITH SYNONYMS = ('sales per review','revenue per review','review coverage')
      COMMENT = 'Cross-grain metric: revenue divided by review count. Spans the line-item and review grains, so treat with care.',
    -- RETURN_RATE exists because the view previously offered only return COUNTS.
    -- Asked to "compare return rates across regions", the agent had to divide two
    -- metrics itself, and since Central has both the most orders and the most
    -- returns, a raw count comparison inverts the answer: Central looks worst on
    -- volume while South is actually worst on rate in some cuts. Denominator is
    -- DISTINCT orders, because RETURNS is order grain and ORDERS is line grain.
    ORDERS.UNIQUE_ORDERS AS COUNT(DISTINCT orders.order_id)
      WITH SYNONYMS = ('number of orders','order count','distinct orders','how many orders')
      COMMENT = 'Number of distinct orders, as opposed to order lines',
    ORDERS.RETURNED_ORDER_COUNT AS COUNT(DISTINCT IFF(orders.was_returned, orders.order_id, NULL))
      WITH SYNONYMS = ('returned orders','number returned','count of returns')
      COMMENT = 'Number of distinct orders that were returned',
    ORDERS.RETURN_RATE AS (orders.returned_order_count / NULLIF(orders.unique_orders, 0)) * 100
      WITH SYNONYMS = ('return rate','percent returned','returns rate','return percentage')
      COMMENT = 'Percentage of distinct orders that were returned. Pair with PCT_NEGATIVE_REVIEWS to compare dissatisfaction signals.'
  )
  COMMENT = 'Superstore sales analytics across two fact grains - ORDERS (line item) and REVIEWS (review) - plus RETURNS at order grain, bridged by four conformed dimensions: PRODUCTS, REGIONS, CUSTOMERS and DELIVERY_MODES. To combine sales or returns with review sentiment, group by one of those conformed dimensions; the ORDERS-side copies of the same attributes do not reach REVIEWS. Extends SUPERSTORE.PUBLIC.SUPERSTORE_ANALYSIS with the synthetic review corpus so that sales performance and customer sentiment can be analysed together. Currency is GBP; the dataset covers 15 European countries over 2020-2023.'
  AI_VERIFIED_QUERIES (
    SUBCATEGORY_SALES_SENTIMENT_RETURNS AS (
      QUESTION 'Which sub-categories have the highest sales but the worst review ratings, and are those the ones being returned?'
      VERIFIED_AT 1788451200
      ONBOARDING_QUESTION TRUE
      SQL $$
        SELECT CATALOGUE_SUB_CATEGORY, TOTAL_SALES, AVG_RATING,
               PCT_NEGATIVE_REVIEWS, RETURN_RATE
        FROM SEMANTIC_VIEW(
          SUPERSTORE.AGENTS.SUPERSTORE_360
          DIMENSIONS PRODUCTS.CATALOGUE_SUB_CATEGORY
          METRICS ORDERS.TOTAL_SALES, REVIEWS.AVG_RATING,
                  REVIEWS.PCT_NEGATIVE_REVIEWS, ORDERS.RETURN_RATE
        )
        ORDER BY TOTAL_SALES DESC, AVG_RATING ASC
      $$
    ),
    REGION_SALES_PROFIT_2023_QUARTERS AS (
      QUESTION 'What were total sales and profit by region, and how did the trend move over 2023?'
      VERIFIED_AT 1788451200
      ONBOARDING_QUESTION TRUE
      SQL $$
        SELECT SALES_REGION, ORDER_QUARTER, TOTAL_SALES, TOTAL_PROFIT
        FROM SEMANTIC_VIEW(
          SUPERSTORE.AGENTS.SUPERSTORE_360
          DIMENSIONS REGIONS.SALES_REGION, ORDERS.ORDER_QUARTER, ORDERS.ORDER_YEAR
          METRICS ORDERS.TOTAL_SALES, ORDERS.TOTAL_PROFIT
        )
        WHERE ORDER_YEAR = 2023
        ORDER BY SALES_REGION, ORDER_QUARTER
      $$
    ),
    TOP_PRODUCTS_WITH_RATINGS AS (
      QUESTION 'Show me the top 10 products by revenue with their average review rating.'
      VERIFIED_AT 1788451200
      ONBOARDING_QUESTION TRUE
      SQL $$
        SELECT CATALOGUE_PRODUCT_NAME, TOTAL_SALES, AVG_RATING
        FROM SEMANTIC_VIEW(
          SUPERSTORE.AGENTS.SUPERSTORE_360
          DIMENSIONS PRODUCTS.CATALOGUE_PRODUCT_NAME
          METRICS ORDERS.TOTAL_SALES, REVIEWS.AVG_RATING
        )
        ORDER BY TOTAL_SALES DESC
        LIMIT 10
      $$
    ),
    REGION_RETURN_AND_NEGATIVE_REVIEW_RATES AS (
      QUESTION 'Compare return rates and negative review rates across the three regions.'
      VERIFIED_AT 1788451200
      ONBOARDING_QUESTION TRUE
      SQL $$
        SELECT SALES_REGION, RETURN_RATE, PCT_NEGATIVE_REVIEWS
        FROM SEMANTIC_VIEW(
          SUPERSTORE.AGENTS.SUPERSTORE_360
          DIMENSIONS REGIONS.SALES_REGION
          METRICS ORDERS.RETURN_RATE, REVIEWS.PCT_NEGATIVE_REVIEWS
        )
        ORDER BY SALES_REGION
      $$
    ),
    DELIVERY_MODE_SENTIMENT AS (
      QUESTION 'Which delivery mode is associated with the worst customer sentiment?'
      VERIFIED_AT 1788451200
      ONBOARDING_QUESTION TRUE
      SQL $$
        SELECT SHIPPING_MODE, AVG_RATING, PCT_NEGATIVE_REVIEWS, REVIEW_COUNT
        FROM SEMANTIC_VIEW(
          SUPERSTORE.AGENTS.SUPERSTORE_360
          DIMENSIONS DELIVERY_MODES.SHIPPING_MODE
          METRICS REVIEWS.AVG_RATING, REVIEWS.PCT_NEGATIVE_REVIEWS,
                  REVIEWS.REVIEW_COUNT
        )
        ORDER BY AVG_RATING ASC, PCT_NEGATIVE_REVIEWS DESC
      $$
    )
  );

-- Smoke test: the cross-grain join is the part most likely to be wrong, so query
-- it here rather than discovering it through a failed agent turn.
SELECT * FROM SEMANTIC_VIEW(
  SUPERSTORE.AGENTS.SUPERSTORE_360
  DIMENSIONS PRODUCTS.CATALOGUE_SUB_CATEGORY
  METRICS    ORDERS.TOTAL_SALES, REVIEWS.AVG_RATING, REVIEWS.PCT_NEGATIVE_REVIEWS
)
ORDER BY TOTAL_SALES DESC
LIMIT 5;
