# Incremental Loading

The SQL pipeline now uses a hybrid incremental design.

## How It Works

Scheduled SQL runs no longer extract the full `sale.report` dataset from Odoo. Instead, they:

1. Pull new or changed records from Odoo using `write_date` / `create_date`.
2. Use a safety overlap window controlled by `INCREMENTAL_OVERLAP_DAYS`, default `7`.
3. Upsert changed rows into raw SQL staging tables.
4. Rebuild the final Power BI-compatible facts/dimensions from SQL staging.
5. Reload final modeled SQL tables and run scoped SQL row-count/window QA.

This keeps the final Power BI output structure unchanged while reducing Odoo extraction time.

SQL-only incremental runs skip the Excel workbook export and final Excel/SQL comparison. They also skip the largest QA exports by default: `QA_CRM_UnmappedKeys`, `QA_CRM_FieldAvailability`, `QA_CRM_DataQuality`, and `QA_UnmappedProducts`. Use `--include-qa` or `--full-validation` when those QA tables are needed.

## Raw Staging Tables

```text
raw_sale_order
raw_sale_order_line
raw_crm_lead
raw_crm_stage
raw_crm_lost_reason
raw_stock_picking
raw_stock_move
```

`raw_sale_order` and `raw_sale_order_line` replace the old dependency on full `sale.report` extraction for SQL runs. The pipeline reconstructs the same sales export shape expected by the existing cleaning/modeling layer.

## Commands

Normal scheduled SQL run:

```powershell
python -m sales_pipeline.main --output sql --scheduled-refresh-time 09:00
```

Fast repeat SQL incremental run:

```powershell
python -m sales_pipeline.main --output sql --load-mode incremental --fast
```

Fast mode forces SQL-only output, skips QA exports, skips final Excel/SQL validation, and uses scoped SQL validation. Final fact tables with unchanged fingerprints are skipped instead of being replaced.

Manual force update now:

```powershell
python -m sales_pipeline.main --output sql --force
```

Sales-only full refresh:

```powershell
python -m sales_pipeline.main --output sql --force-sales-full-refresh
```

Full refresh / reconciliation run:

```powershell
python -m sales_pipeline.main --output sql --full-refresh
```

Both SQL and Excel export:

```powershell
python -m sales_pipeline.main --output both --full-refresh
```

## Verification

Check the latest run:

```sql
SELECT run_id,
       scheduled_refresh_time,
       total_duration_minutes,
       status,
       odoo_extract_count,
       db_loaded_count,
       qa_issues_count,
       created_at
FROM public.pipeline_run_log
ORDER BY run_id DESC
LIMIT 10;
```

Check a table count:

```sql
SELECT COUNT(*) FROM public."Fact_SalesLines";
```

Check task logs:

```text
C:\Users\Lenovo\Desktop\PowerBIData\powerbi_sales_pipeline\logs
```

## Reconciliation

Use `--full-refresh` periodically, for example once daily or weekly, to rebuild staging from Odoo and catch unusual historical edits. Scheduled daytime runs should use normal incremental mode.

Use `--force-sales-full-refresh` when only `raw_sale_order` and `raw_sale_order_line` need to be fully reloaded.

By default, `invoice_status = "no"` sales lines are excluded to preserve the original Power BI behavior. Set `INCLUDE_UNINVOICED_SALES_LINES=true` only when the report should include draft/uninvoiced sales rows. Each run logs included and excluded totals.
