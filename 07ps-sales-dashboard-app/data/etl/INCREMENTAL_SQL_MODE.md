# Incremental SQL Mode

## Purpose And Usage

Incremental SQL mode minimizes Odoo reads and SQL writes while preserving the same modeled outputs. Use it for scheduled SQL refreshes. Do not use it when staging is missing/corrupt, historical deletions must be reconciled, source schemas changed unexpectedly, or a formal full reconciliation is required; use `--full-refresh` instead.

```powershell
python -m sales_pipeline.main --output sql --load-mode incremental
python -m sales_pipeline.main --output sql --load-mode incremental --fast
```

## Window Selection

The pipeline finds the greatest latest timestamp across `Fact_Orders`, `Fact_SalesLines`, and `Fact_Sales`, subtracts `INCREMENTAL_OVERLAP_DAYS` (minimum 7), converts it to UTC, and sends it to Odoo `write_date`/`create_date` domains. If no safe timestamp exists, the pipeline falls back to a full staging sync.

## Refresh Strategy

Incremental/upserted raw tables: `raw_sale_order`, `raw_sale_order_line`, `raw_stock_picking`, `raw_stock_move`.

Fully refreshed raw tables: `raw_crm_lead`, `raw_crm_stage`, `raw_crm_lost_reason`.

Window-refreshed cache: `raw_sale_report_api`, where rows at or after the local overlap cutoff are deleted and the complete changed date window is inserted.

Final SQL behavior:

- Date-window replace: `Fact_SalesLines`, `Fact_Orders`.
- Fingerprint skip/full replace: `Fact_Sales`, `Fact_Delivery`.
- Stable-key delete/insert: dimensions, `Fact_Lead`, `Fact_Opportunity`.
- Stale-key cleanup: `Fact_Lead`, `Fact_Opportunity`.
- Skip when already present: `Fact_Targets`, `Fact_OffDays`.
- QA tables are skipped in fast mode unless explicitly enabled.

## Safety And Recovery

Changed parent orders trigger full line refresh for those orders; changed pickings trigger move refresh. Full sales refresh includes a catch-up query for rows changed during extraction. The latest Odoo order is checked directly. Row counts, affected windows/keys, duplicate order numbers, date coverage, model keys, and latest sales freshness are validated.

Force recovery:

```powershell
python -m sales_pipeline.main --output sql --full-refresh --strict
python -m sales_pipeline.main --output sql --force-sales-full-refresh
```

Compare a full baseline with a later incremental run:

```powershell
python -m sales_pipeline.main --output sql --full-refresh --strict --write-validation-baseline logs/full-baseline.json
python -m sales_pipeline.main --output sql --load-mode incremental --strict --validation-baseline logs/full-baseline.json
```

The comparison covers output schemas, row counts, and configured core KPI totals.

## Recommended Indexes

The code creates needed key/date indexes where practical. Recommended production indexes:

```sql
CREATE INDEX ix_raw_sale_report_api_order_date ON raw_sale_report_api (`Order Date`);
CREATE INDEX ix_raw_sale_order_write_date ON raw_sale_order (write_date);
CREATE INDEX ix_raw_sale_order_line_write_date ON raw_sale_order_line (write_date);
CREATE INDEX ix_raw_sale_order_line_order_id ON raw_sale_order_line (order_id_id);
CREATE INDEX ix_raw_stock_picking_write_date ON raw_stock_picking (write_date);
CREATE INDEX ix_raw_stock_move_write_date ON raw_stock_move (write_date);
CREATE INDEX ix_raw_stock_move_picking_id ON raw_stock_move (picking_id_id);
CREATE INDEX ix_fact_saleslines_order_date ON Fact_SalesLines (order_date);
CREATE INDEX ix_fact_orders_order_datetime ON Fact_Orders (OrderDateTime);
```

Before applying manually, inspect existing indexes and actual MySQL column types/names.

## Performance Expectations

Warm incremental runs avoid unchanged Excel parsing and full `raw_sale_report_api` rewrites. Local benchmark: main reference parsing reduced from 8.28 seconds cold to 0.42 seconds warm. End-to-end improvement depends on Odoo/SQL latency and changed-window size; use `--profile` and stage timing logs for production measurements.
