-- 0079: on-hand stock at period ends (2026-11-16) -- the SKU Trend's Product Status per Weekly / Monthly / Yearly period.
--   product_stock_period_end   one row per Odoo product + company + period end date (a Friday = week end, the last day of
--                              a month, 31 Dec): the quantity on hand at the end of that day (Africa/Tripoli).
--     source = 'backfill'      data/etl/scripts/backfill_stock_period_end.py (run once by hand): Odoo stock.valuation.layer
--                              quantities created up to that date, summed per product + company (read_group, read-only)
--     source = 'snapshot'      the ETL, on a refresh whose inventory snapshot date is a period end: the snapshot's on hand
--                              (fact_sales_inventory_snapshot, the Product Status cards' On Hand). Wins over 'backfill'.
-- A product with no row at a date had no stock movement yet (or no stock): counted as 0 on hand.
-- Additive and idempotent.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS product_stock_period_end (
    product_id BIGINT NOT NULL COMMENT 'Odoo product.product id (= ProductKey)',
    company_id BIGINT NOT NULL COMMENT 'Odoo res.company id (= CompanyKey)',
    period_end_date DATE NOT NULL COMMENT 'week end (Friday), month end or year end',
    qty_on_hand DECIMAL(20,6) NOT NULL DEFAULT 0,
    source ENUM('backfill', 'snapshot') NOT NULL,
    loaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC',
    PRIMARY KEY (product_id, company_id, period_end_date),
    KEY ix_product_stock_period_end_date (period_end_date, company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
