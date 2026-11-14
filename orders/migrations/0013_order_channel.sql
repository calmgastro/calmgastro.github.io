-- 0013: which website page took an order. NULL = the main page (and every admin order); 'AD_PAGE' = the ads order page /offer/.
-- source stays WEBSITE for both, so reports, stock and every existing filter treat ad-page orders as website orders.
-- No CHECK: a later page or campaign gets its own value without rebuilding the orders table (only the server writes it).
ALTER TABLE orders ADD COLUMN channel TEXT;
