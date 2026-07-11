> **Vendored into this monorepo** from the standalone `powerbi_sales_pipeline` project so the whole
> reporting system (web app + ETL) is one deployable project — see
> `backend/src/etl/` for the Node orchestration layer that now schedules, queues, and invokes this
> package (replacing the old Windows Task Scheduler + `scheduler.py` combo, which is intentionally
> **not** vendored here). Nothing under `config/`/`src/`/`tests/` was changed as part of that move;
> this package's own business logic, validation, and Odoo retry handling are unmodified. Credentials
> and settings now come entirely from the Node backend's `.env`, injected into this process's
> environment at spawn time (see `pythonRunner.ts`) — this directory should never have its own
> `.env` file. See `07ps-sales-dashboard-app/docs/etl-deployment.md` for how to run/operate it.

# Power BI Sales and CRM Pipeline

This project replaces the old Odoo web scraping export plus cleaning script with an API-first Python pipeline. It reads `sale.report` from Odoo using an API key, loads the Excel reference files from `Input`, applies the existing cleaning and enrichment rules, and exports the Power BI-compatible workbook.

It also extracts CRM pipeline data from Odoo API models for pipeline health, trend, and activity momentum dashboards.

## Architecture And Outputs

Odoo XML-RPC sources and Excel reference masters are staged/cleaned, transformed into sales and CRM facts/dimensions, validated, then exported to Excel, MySQL, or both. The primary workbook is `Exports/SalesModel_OneOutput.xlsx`; SQL uses the configured `DB_NAME`/`DB_SCHEMA`.

On `excel`/`both` runs, `Exports/Inventory_Validation.xlsx` is also produced: a row-level QA export flagging `Fact_Inventory` rows that need manual review (raw-materials/in-transit warehouses, unmatched products, negative stock, missing cost, non-official product mapping) before they're trusted in stock/velocity reporting. See `InventoryValidationExporter` in `src/sales_pipeline/export/inventory_validation_exporter.py`.

Pipeline modes:

- Full: reads complete Odoo source models and rebuilds outputs.
- Incremental SQL: reads changed Odoo rows using an overlap window, upserts raw staging, and refreshes modeled SQL safely.
- Fast incremental: SQL-only incremental run with QA exports and full mirror validation skipped.

## Folder Structure

```text
powerbi_sales_pipeline/
  config/settings.py
  src/sales_pipeline/
    main.py
    odoo/
    loaders/
    cleaning/
    dimensions/
    facts/
    qa/
    export/
    crm/
    pipeline.py
  docs/
```

The detailed business transformation code is preserved in `src/sales_pipeline/legacy_transform.py` and exposed through smaller modules so Power BI-facing behavior does not drift.

## Install

```powershell
cd C:\Users\Lenovo\Desktop\PowerBIData\powerbi_sales_pipeline
pip install -r requirements.txt
```

## Configure

Create `.env` from `.env.example` and set the API key:

```powershell
Copy-Item .env.example .env
notepad .env
```

Required values:

```text
ODOO_URL=https://your-instance.odoo.com
ODOO_DB=your_odoo_database
ODOO_USER=your_odoo_user@example.com
ODOO_API_KEY=your_real_api_key
```

Odoo API datetime values are converted from UTC to the configured business timezone before date keys are created. `order_date` keeps the local timestamp, while `order_date_date` is normalized to midnight and should be used for Power BI date relationships and YTD filters.

## Run

```powershell
cd C:\Users\Lenovo\Desktop\PowerBIData\powerbi_sales_pipeline
python -m sales_pipeline.main
```

The workbook is exported to:

```text
C:\Users\Lenovo\Desktop\PowerBIData\Exports\SalesModel_OneOutput.xlsx
```

SQL export is also supported:

```powershell
python -m sales_pipeline.main
python -m sales_pipeline.main --output sql
python -m sales_pipeline.main --output both
```

Recommended production commands:

```powershell
python -m sales_pipeline.main --output sql --load-mode incremental --fast
python -m sales_pipeline.main --output sql --full-refresh --strict --write-validation-baseline logs/full-baseline.json
python -m sales_pipeline.main --output sql --load-mode incremental --strict --validation-baseline logs/full-baseline.json
python -m sales_pipeline.main --output sql --load-mode incremental --profile
```

## Inputs And Environment

Required files: `sales_targets.xlsx`, `SalesTeam.xlsx`, `OffDays.xlsx`, and `PRODUCTS.xlsx`. `BlockedCustomers.xlsx` is optional and an empty template is created when absent.

Required Odoo variables: `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_API_KEY`.

SQL variables: either `DB_URL`, or `DB_TYPE`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`; optional `DB_SCHEMA`, `DB_RELOAD_MODE`, `DB_CHUNKSIZE`.

Runtime variables: `INPUT_DIR`, `OUTPUT_DIR`, `OUTPUT_FILE`, `INVENTORY_VALIDATION_FILE`, `BATCH_SIZE`, `TIMEZONE`, `ASSUME_UTC_FOR_NAIVE`, `INCREMENTAL_OVERLAP_DAYS`, `ODOO_TIMEOUT_SECONDS`, `ODOO_MAX_RETRIES`, `CRM_INACTIVE_DAYS_THRESHOLD`, `CRM_RECENT_ACTIVITY_DAYS`, `INCLUDE_UNINVOICED_SALES_LINES`, `FORCE_SALES_FULL_REFRESH`.

## Documentation

- [Business logic](BUSINESS_LOGIC.md)
- [Technical documentation](TECHNICAL_DOCUMENTATION.md)
- [Data dictionary](DATA_DICTIONARY.md)
- [Incremental SQL mode](INCREMENTAL_SQL_MODE.md)
- [Performance optimization](docs/PERFORMANCE_OPTIMIZATION.md)
- [Changelog](CHANGELOG.md)

Configure database settings in `.env`; see [DATABASE_OUTPUT.md](docs/DATABASE_OUTPUT.md).

For a sales-only staging refresh:

```powershell
python -m sales_pipeline.main --output sql --force-sales-full-refresh
```

Windows Task Scheduler automation is documented in [AUTOMATION.md](docs/AUTOMATION.md).

Incremental SQL loading and manual commands are documented in [INCREMENTAL_LOADING.md](docs/INCREMENTAL_LOADING.md).

## Troubleshooting

- Missing `ODOO_API_KEY`: create `.env` and set the API key.
- Authentication failed: verify `ODOO_DB`, `ODOO_USER`, and the API key.
- Missing Excel input: place the required files in `C:\Users\Lenovo\Desktop\PowerBIData\Input`.
- Missing `BlockedCustomers.xlsx`: the pipeline creates an empty template automatically.
- Date shifts in Power BI: use `order_date_date` / `DateKey` for date relationships. Avoid filtering `order_date <= CURRENT_DATE`, because that excludes today's rows after midnight.
- Products present in sales but absent from the manual master: check `Exports\QA_UnmappedProducts.xlsx`.
- CRM missing links: check the `QA_CRM_MissingLinks` sheet.
- CRM optional fields: check the `QA_CRM_FieldAvailability` sheet.
- Incremental cache issue: run with `--full-refresh`.
- Unexpected schema/KPI change: create a full baseline with `--write-validation-baseline`, then compare using `--validation-baseline --strict`.
- Performance investigation: use `--profile`; reports are written to `logs/pipeline_profile.prof` and `logs/pipeline_profile.txt`.

## Known Limitations

- Incremental mode still rebuilds modeled pandas facts/dimensions from cached raw data to preserve exact business logic.
- CRM raw data is fully refreshed because optional/custom Odoo fields can change shape.
- Deleted Odoo records outside the overlap window require a periodic full refresh.
- Excel export is inherently slower and memory-heavy; use SQL-only fast incremental mode for scheduled refreshes.
