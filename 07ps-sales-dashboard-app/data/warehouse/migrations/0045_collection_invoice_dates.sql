-- Collections exclude same-day sales: compare invoice date with payment date, independently of due date.
-- Paid invoices are absent from the open-receivables dimension. Keep their dates independently so
-- refreshing/replacing collection allocations never removes the historical invoice dates.
CREATE TABLE IF NOT EXISTS dim_finance_collection_invoice_date (
    move_id BIGINT NOT NULL PRIMARY KEY COMMENT 'Odoo customer invoice or receipt id',
    invoice_date DATE NULL COMMENT 'account.move.invoice_date; unknown dates are never counted as earlier invoices',
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed known dates. scripts/finance/backfill_collection_invoice_dates.py reads the remaining
-- historical dates from Odoo using the guarded read-only source; it never changes Odoo.
INSERT INTO dim_finance_collection_invoice_date (move_id, invoice_date, updated_at_utc)
SELECT DISTINCT i.move_id, i.invoice_date, UTC_TIMESTAMP()
FROM dim_finance_invoice i
JOIN fact_finance_collection_invoice m ON m.move_id = i.move_id
WHERE i.invoice_date IS NOT NULL AND m.move_type IN ('out_invoice', 'out_receipt')
ON DUPLICATE KEY UPDATE invoice_date = COALESCE(dim_finance_collection_invoice_date.invoice_date, VALUES(invoice_date));
