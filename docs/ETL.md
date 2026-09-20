# ETL — Promotion Dashboard (Ben Mussa Holding, BMH)

> Scope: everything that moves data from Odoo and the manual Excel workbooks into the MySQL warehouse the
> dashboard reads, how it is triggered, how it is monitored, and how "Last Refresh" is defined and checked.
> Every statement is taken from the code in this repository. Where something could not be verified from the
> code it is marked **ASSUMPTION** and listed in [Appendix D](#appendix-d--assumptions). Paths are relative to
> `07ps-sales-dashboard-app/` unless they start with `docs/`. Deployment is covered in
> [DEPLOYMENT.md](DEPLOYMENT.md).

**Contents**

1. [Purpose and overview](#1-purpose-and-overview) · 2. [Components](#2-components-and-where-they-live) · 3. [Data sources](#3-data-sources) ·
4. [Pipeline steps](#4-pipeline-steps) · 5. [Run modes](#5-run-modes) · 6. [Triggers and scheduling](#6-triggers-and-scheduling) ·
7. [Configuration reference](#7-configuration-reference) · 8. [Timestamps and timezones](#8-timestamps-and-timezones) ·
9. [Refresh log and freshness check](#9-the-refresh-log-and-freshness-check) · 10. [Logging and monitoring](#10-logging-and-monitoring) ·
11. [Failure modes](#11-failure-modes-and-troubleshooting) · 12. [Idempotency and recovery](#12-idempotency-recovery-and-rollback) ·
13. [Validation checks](#13-data-validation-checks) · 14. [Admin runbook](#14-admin-runbook-non-technical) · 15. [DevOps runbook](#15-devops-runbook) ·
16. [Performance](#16-performance-and-sizing) · 17. [Security](#17-security) · Appendices

---

## 1. Purpose and overview

The ETL builds the star-schema warehouse (`Fact_*`, `Dim_*`, plus `raw_*` staging and `QA_*` tables) in the MySQL
database `ps_warehouse` from two kinds of input:

* **Odoo ERP** (XML-RPC, API key): sales report, sale orders/lines, CRM leads/stages/lost reasons, stock pickings/moves,
  stock quants/locations, companies, product costs.
* **Manual Excel workbooks** maintained by the business: sales targets, sales team roster, off-days calendar, product
  master, blocked customers.

The dashboard (Next.js frontend → Express backend) only *reads* these tables. It never talks to Odoo.

**Who runs it.** Normally nobody: the backend API process schedules an incremental refresh five times a day and a full
refresh every night. An **Admin-role** user can also start, cancel and retry runs from *Admin → ETL Control Center*.
DevOps can run it from the CLI (§15).

```mermaid
flowchart LR
  subgraph Sources
    ODOO[(Odoo ERP<br/>XML-RPC)]
    XLS[/"Excel inputs (read-only mount)<br/>sales_targets · SalesTeam · OffDays<br/>PRODUCTS · BlockedCustomers"/]
  end
  subgraph Host["Docker host"]
    CRON["backend (API)<br/>node-cron schedules<br/>+ admin routes"] -->|enqueue| REDIS[(Redis<br/>BullMQ queue)]
    UI["Admin UI<br/>ETL Control Center"] -->|POST /admin/etl/start/*| CRON
    REDIS --> WORKER["etl-worker<br/>BullMQ worker, concurrency 1"]
    WORKER -->|"HTTP + Bearer key<br/>POST /etl/run, poll /etl/jobs/id"| API["etl-api<br/>Flask + gunicorn (1 worker)"]
    API -->|subprocess| PIPE["python -m sales_pipeline.main"]
  end
  ODOO --> PIPE
  XLS --> PIPE
  PIPE -->|"load + etl_run_log"| DB[(MySQL 8<br/>ps_warehouse)]
  DB --> BACK["backend (API)<br/>/tachometer, /filters, /meta/refresh-status ..."]
  BACK --> FE["frontend (Next.js)<br/>dashboards + Last Refresh banner"]
  CRON -. "reads etl_job_runs" .-> DB
```

---

## 2. Components and where they live

### 2.1 Python pipeline — `data/etl/`

| Module (`src/sales_pipeline/` unless noted) | Role |
|---|---|
| `main.py` | CLI entry point (`python -m sales_pipeline.main`). Parses arguments (table below), configures logging (timestamps in `TIMEZONE` with UTC offset), builds `Settings` and calls `PowerBISalesPipeline.run()`. Exit code 0 = success, 1 = any exception. |
| `pipeline.py` | `PowerBISalesPipeline` (~3,500 lines). `run()` orchestrates all steps (§4); also `transform()`, CRM transform, incremental cutoff selection, SQL validations, run summary logging. |
| `runtime.py` | `PipelineRunContext`: run start/end (**tz-aware UTC**), per-step timing (`step()` context manager), optional cProfile. |
| `../config/settings.py` | `Settings.from_env()` — every ETL environment variable (§7). `validate()` checks Odoo and DB settings. |
| `../config/input_check.py` | Locates and validates the Excel inputs. Shared by the run's first step **and** the Flask `/etl/preflight` endpoint, so the admin sees exactly what the run would verify. Rejects Windows paths (`C:/...`) inside Linux with an explanation. |
| `etl_run_log.py` | **New.** UTC run log (`etl_run_log` table): start row, atomic success/failure finish with watermark, timezone helpers (`to_utc`, `to_naive_utc`, `to_business_naive`). |
| `product_name_mapper.py` | `ProductNameMapper` — Odoo product name → clean name from `PRODUCTS.xlsx` (first sheet, columns `OdooProductName` + `ProductName`). Raises `ProductMappingError` if the file is missing/unreadable/lacks the columns. |
| `staging.py` | SQL staging layer for incremental mode: `raw_sale_order`, `raw_sale_order_line`, `raw_stock_picking`, `raw_stock_move` (upserted), `raw_crm_lead`, `raw_crm_stage`, `raw_crm_lost_reason` (fully refreshed), `raw_sale_report_api` (window-refreshed). |
| `reference_cache.py` | Caches parsed Excel reference data in `<ETL_OUTPUT_DIR>/.pipeline_cache` (cold parse ≈ 8.3 s, warm ≈ 0.4 s per `docs/PERFORMANCE_OPTIMIZATION.md`). |
| `odoo/` | `OdooClient` (auth, retries, timeouts) and one repository per Odoo model (`sales_report_repository`, `sale_order_repository`, `crm_repository`, `stock_*`, `product_cost_repository`). Odoo UTC datetimes are converted to the business timezone in `sales_report_repository.odoo_utc_datetime_to_local`. |
| `facts/`, `dimensions/`, `crm/`, `cleaning/` | Builders for every `Fact_*` / `Dim_*` table, CRM classification, text/product cleaning. |
| `loaders/`, `legacy_transform.py` | Excel loaders (targets, sales org, off-days, products, blocked customers). |
| `export/database_exporter.py` | SQL load (`export`, `export_incremental`), MySQL advisory lock, legacy run log/audit, load metadata, read-path indexes (`ensure_query_indexes`). |
| `export/workbook_exporter.py`, `inventory_validation_exporter.py` | Excel output (`--output excel|both` only). |
| `validation.py`, `qa/qa_service.py` | `ModelValidator` structural checks, QA tables. |
| `api/app.py`, `api/job_tracker.py`, `api/api_config.py`, `api/wsgi.py` | Flask API that wraps the pipeline as an HTTP service (§2.3). |
| `scripts/backfill_etl_run_log.py` | One-off backfill of legacy `pipeline_run_log` rows into `etl_run_log` (§9.6). |

`main.py` command-line options:

| Option | Default | Meaning |
|---|---|---|
| `--output excel\|sql\|both` | `sql` | Target. `excel` needs no DB; `incremental` requires `sql`/`both`. |
| `--load-mode full\|incremental` | `full` | See §5. |
| `--fast` | off | Incremental only: SQL output, skip QA exports, scoped validations. What every scheduled incremental uses. |
| `--full-refresh` | off | Forces `full` and rebuilds raw staging from Odoo. |
| `--force` | off | Run immediately in incremental mode with the normal overlap window. |
| `--force-sales-full-refresh` | off | Fully reload only `raw_sale_order` / `raw_sale_order_line`, then rebuild. |
| `--odoo-cutoff-utc "YYYY-MM-DD HH:MM:SS"` | none | Upper UTC bound for sales extraction. |
| `--full-validation`, `--include-qa`, `--strict` | off | Extra validation / QA; `--strict` turns null keys and validation warnings into failures. |
| `--scheduled-refresh-time`, `--profile`, `--validation-baseline`, `--write-validation-baseline` | — | Label stored in `pipeline_run_log`; cProfile output; full-vs-incremental manifest comparison. |

### 2.2 Backend orchestration — `backend/src/etl/`

| File | Role |
|---|---|
| `scheduler/registerSchedules.ts` | Registers the two cron jobs (node-cron) at API start. A tick only **enqueues** a job; a tick that finds a run already active is skipped, not queued. |
| `scheduler/nextRunTime.ts` | `computeNextRunTime(cron, tz)` (cron-parser) — the "Next Incremental Refresh" shown in the UI. |
| `queue/etlQueue.ts` | BullMQ queue `etl`. `enqueuePipelineRun` takes the MySQL lock `etl_enqueue_guard`, refuses if `etl_job_runs` has a queued/running row (`EtlAlreadyRunningError`), inserts the row, then adds the job (`attempts: 3`, exponential backoff 30 s, job id = row id). |
| `jobs/runPipelineJob.ts` | The worker (`concurrency: 1`). Marks the run started, calls `runPipeline`, forwards every log line into BullMQ job logs, correlates the run with `pipeline_run_log`, writes the terminal status (`success`/`failed`/`cancelled`), lets BullMQ retry non-cancelled failures. |
| `services/pythonRunner.ts` | HTTP client for the Flask API (`POST /etl/run`, poll `GET /etl/jobs/<id>?after=n`, `POST .../cancel`, `GET /etl/preflight`). |
| `services/etlRunTracker.ts` | `etl_job_runs` CRUD; force-reset (also kills the connection holding the pipeline's MySQL lock). |
| `services/etlReconciliation.ts` | At API start and every 5 min: marks orphaned/stale `queued`/`running` rows `failed` so a dead process can never block future runs. |
| `services/etlLogger.ts` | Orchestration log `etl.log` (winston; 10 MB × 5 files) + console. |
| `commands/*.ts` | `npm run etl:run|full|incremental|sql|excel|worker`. Default enqueues; `--sync` runs inline (no Redis/worker; not tracked in `etl_job_runs`). |
| `routes/admin/etlControl.ts`, `etlRuns.ts` | Admin-only API (`/admin/etl/*`, `/admin/etl-runs/*`). |

### 2.3 Flask ETL API — `data/etl/api/`

Runs under gunicorn with **one worker** (the job tracker is in-memory; more workers would each allow "one active job").
All routes except `/health` need `Authorization: Bearer <ETL_API_KEY>`.

| Route | Purpose |
|---|---|
| `GET /health` | Unauthenticated; reports the active job. Docker healthcheck. |
| `GET /etl/preflight` | Input files found/valid, output dir writable, **product mapping count**. Never raises for a bad environment: it returns `ok:false` with an explanation. |
| `POST /etl/run` | `{loadMode, outputMode, fast, extraArgs, label}` → 202 `{jobId}`; **409** if a job is already active. The `label` becomes `ETL_TRIGGER_SOURCE` for the subprocess. |
| `GET /etl/jobs/<id>?after=<n>` | Status + log lines after line `n`. |
| `POST /etl/jobs/<id>/cancel`, `POST /etl/reset` | Terminate the subprocess / clear a stuck slot. |

Job state and log lines are **in memory** in the Flask process: a restart loses them (the subprocess dies with it). The
durable records are `etl_run_log`, `pipeline_run_log`/`pipeline_run_audit` and `etl_job_runs` in MySQL and the BullMQ job logs in Redis.

### 2.4 Admin UI

`frontend/src/app/admin/etl-control` (start incremental/full/sql/excel, cancel, retry, force-reset, live log, scheduler
settings, input preflight) and `admin/etl-runs` (history from `pipeline_run_log`). Every `/admin/etl/*` route requires the
**Admin role** (`requireAdminRole`), not a delegable page permission.

| Button / route | `mode` | load mode | output | fast |
|---|---|---|---|---|
| `POST /admin/etl/start/incremental` | incremental | incremental | sql | yes |
| `POST /admin/etl/start/full` | full | full | sql | no |
| `POST /admin/etl/start/sql` | sql | incremental | sql | no (QA on) |
| `POST /admin/etl/start/excel` | excel | full | excel | no |

Start is refused with **503** if Redis is unreachable, **409** if a run is active, and **422** if the preflight says the
inputs are not ready (with the same explanation the panel shows).

---

## 3. Data sources

### 3.1 Odoo models read

`sale.report`, `sale.order`, `sale.order.line`, `crm.lead`, `crm.stage`, `crm.lost.reason`, `stock.picking`, `stock.move`,
`stock.quant`, `stock.location`, `res.company`, `product.product` (costs). Credentials: `ODOO_URL`, `ODOO_DB`, `ODOO_USER`,
`ODOO_API_KEY`. Odoo returns datetimes as **UTC** strings without a zone marker.

### 3.2 Warehouse tables written (target database `DB_NAME`, default `ps_warehouse`)

| Table | Meaning | Load behaviour in incremental mode |
|---|---|---|
| `Fact_SalesLines` | One row per sales/invoice line (`order_date`, `DateKey`, `CompanyKey`, `SegmentKey`, `SalespersonKey`, `CustomerKey`, …). The dashboard's main fact. | Delete-and-reinsert of the date window ≥ cutoff. |
| `Fact_Orders` | One row per order (`OrderKey`, `order_number`, `OrderDate`, `OrderDateTime`, customer/salesperson/team keys). Also `QuotationDate` (= Odoo `create_date`) **when `Fact_Sales` has rows to align it with** (`_align_fact_orders_with_fact_sales`). | Window replace by `OrderDateTime`, older duplicates removed by `order_number`. |
| `Fact_Sales` | CRM journey view: quotation → sales order → delivery (`SalesDocumentID`, `QuotationDate`, `SalesOrderDate`, …). | Fingerprint compare; replaced only if changed. |
| `Fact_Lead`, `Fact_Opportunity`, `Fact_Delivery`, `Fact_Inventory`, `Fact_BCGMatrix` | CRM / logistics / inventory facts. | Key delete-insert (+ stale-key cleanup) or full replace. |
| `Fact_Targets`, `Fact_OffDays` | From `sales_targets.xlsx` / `OffDays.xlsx`. | Skipped if the table exists. |
| `Dim_Date`, `Dim_Customer`, `Dim_Salesperson`, `Dim_SalesTeam`, `Dim_Company`, `Dim_Product`, `Dim_ProductCost`, `Dim_DistributionChannel`, `Dim_Segment`, `Dim_Invoice`, `Dim_CRMStage`, `Dim_LostReason` | Dimensions. | Stable-key delete/insert. |
| `QA_*` | Data-quality outputs. | Replaced; skipped in `--fast`. |
| `raw_*` | Staging (see `staging.py`). | Upsert / refresh as listed in §2.1. |
| `pipeline_run_log`, `pipeline_run_audit`, `pipeline_load_metadata` | Legacy run history / watermark audit / Excel fingerprints (Admin → ETL Runs reads them). | Insert. |
| **`etl_run_log`** | **UTC run log — source of truth for "Last Refresh"** (§9). | Insert + update. |
| `etl_job_runs` | Backend orchestration rows (who/when/status of each queued run). Written by the **backend**, not Python. | — |

The dashboard also reads app tables (`app_user`, roles, `admin_*`, MARCOM tables) that the ETL never touches.
Data dictionary: `data/etl/DATA_DICTIONARY.md`. Size reference: `Fact_Orders` had 36,969 rows when migration `0002` was written; `PRODUCTS.xlsx` holds ≈ 2,540 rows.

### 3.3 Excel inputs

All five live in **one folder**, `ETL_INPUT_DIR` as seen by the etl-api container (`/etl/input`, mounted **read-only** from
`ETL_INPUT_HOST_DIR`). File names are **case-sensitive on Linux**. Required (a run cannot start without them):
`sales_targets.xlsx`, `SalesTeam.xlsx`, `OffDays.xlsx`, `PRODUCTS.xlsx`. `BlockedCustomers.xlsx` is loaded on every run and
should also exist: if missing, the pipeline tries to create an empty template in the input folder, which **fails on a read-only
mount** (`BlockedCustomers.xlsx is missing and could not be created...`). The repository's `Input/` folder holds current samples.

**Owners and update frequency — ASSUMPTION** (the code does not record owners; confirm with the business, see DEPLOYMENT.md §12):
Sales Operations owns `SalesTeam.xlsx` and `sales_targets.xlsx`, HR owns `OffDays.xlsx`, the Product/Marketing team owns
`PRODUCTS.xlsx`, Credit/Finance owns `BlockedCustomers.xlsx`. Suggested cadence: targets — monthly/quarterly; sales team — on
every roster change; off-days — when HR announces; products — whenever a product or an Odoo product name is added or renamed.
The pipeline notices a change automatically (file size/mtime/checksum stored in `pipeline_load_metadata`).

Only the **first sheet** is read for `sales_targets`, `OffDays`, `PRODUCTS` and `BlockedCustomers`; only `SalesTeam.xlsx` selects sheets by name.

| File | Sheet(s) | Columns (as in the repository samples) | Notes / types |
|---|---|---|---|
| `sales_targets.xlsx` | first sheet (sample: `Targets`) | `Year`, `Month`, `YearMonth`, `TargetDate`, `TargetLevel`, `Company`, `SalesTeam`, `SalesTeamKey`, `Salesperson`, `SalesSegment`, `City`, `Currency`, `Target_Revenue`, `Target_Volume`, `ASP_LY`, `ASP_ThisYear`, `DistributionChannel`, `ChannelKey`, `SalespersonKey` | Missing columns are added empty. `Year`/`Month` integers; `Target_*`, `ASP_*` numeric (text numbers are normalised); `TargetDate` date (derived from Year/Month if blank). Example: `2025 | 12 | 2025-12 | 2025-12-01 | Salesperson | Majaal | <team> | MJ-BEN-BC-01 | Mohammad Al-Araibi | B2C | Benghazi | LYD | 750000 | 3953.75` |
| `SalesTeam.xlsx` | `salesperson` **and** `salesteam` (people sheet accepted names: `Salespersons`, `Salesperson`, `Sales People`, `People`; team sheet: `SalesTeams`, `SalesTeam`, `Teams`, `Sales Team`; case-insensitive) | People: `Name` (alias of `Salesperson`), `TeamKey`, `Status`, `DistributionChannel`. Teams: `TeamKey`, `TeamName`, `Company`, `City`, `Territory`, `Segment`, `Status` | **Required columns**: people `Salesperson`+`TeamKey`; teams `TeamKey`, `TeamName`, `Segment`, `City`, `Company`. Only `Status = Active` people are used. Example: `Abd Nasser Khair | TK-TRI-BC-03 | Active | Retail` |
| `OffDays.xlsx` | first sheet (sample `Sheet1`) | `Date`, `OffDayType`, `HolidayName`, `Reason`, `Country`, `Company`, `Branch`, `IsActive`, `Source`, `Notes` | **`Date` is required and parsed as `dd/mm/yyyy`** (text like `18/1/2026`). Only `IsActive` = 1/true/yes rows are kept; filtered to the configured country; duplicates on (Date, type, country, company, branch) dropped. Example: `18/1/2026 | Unexpected | <name> | <reason> | Libya | Majaal | MJ-BEN-BC-01 | 1 | HR` |
| `PRODUCTS.xlsx` | first sheet (sample `Sheet1`; the sample also has an unused `Sheet2`) | `ProductKey`, `Company`, `Category`, `Brand`, `SubBrand`, `Family`, `ProductName`, `OdooProductName`, `ProductLevel`, `SKU`, `Size`, `IsActive` | **`OdooProductName` and `ProductName` must both exist and be filled for the mapper**; header typos `Odoo Name`/`Odoo Nmae`/`OdooProduct Name` are tolerated. Rows without `ProductName` are dropped from the master. Example: `TIKA\|XT-TA-01-001\|1 \| Tika \| Ceramics Installation \| Xtreme \| … \| XtraCol One \| Xtreme - XtraCol ONE \| SKU \| XT-TA-01-001` |
| `BlockedCustomers.xlsx` | first sheet (`BlockedCustomers`) | `CustomerID`, `CustomerName`, `IsBlocked`, `BlockedDate`, `UnblockedDate`, `BlockedReason`, `Notes` | Example: `CUST-000015 \| DCI \| 1 \| 16/4/2026`. |

---

## 4. Pipeline steps

Steps run inside `PipelineRunContext.step(name)`; each logs `Pipeline step <name> started` and
`... completed duration_seconds=<s>` (or `failed`). **Failure behaviour is the same for every step**: the exception propagates,
the run is marked failed (`etl_run_log`, legacy tables), the process exits with code 1 and nothing already written is rolled back
(see §12). Durations: the only measurements in the repository (`docs/AUTOMATION.md`, 2026-04-29) are totals — **≈ 16.5 min for a full
SQL run** (step split: `extract_sale_report` 8.56, `extract_crm_models` 1.26, `transform_sales_model` 0.68, `transform_crm_model` 0.31,
`load_database_and_validate` 5.67 min) and **≈ 3.0 min for an incremental SQL run**. Re-measure on the production host.

| # | Step | Runs in | Reads | Writes | Notes / failure causes |
|---|---|---|---|---|---|
| 1 | `validate_config_and_inputs` | all | `ETL_INPUT_DIR`, env | creates `ETL_OUTPUT_DIR` | Order: input files → `Settings.validate()` (Odoo, DB) → `ProductNameMapper` (fails if the file is unreadable **or yields 0 mappings**, unless `ETL_ALLOW_EMPTY_PRODUCT_MAPPING=true`). Failure here (`FileNotFoundError`/`InputValidationError`, missing env, empty mapping) costs ≈ 0 s. **Still recorded** as a failed row in `etl_run_log`. |
| 1b | *(open run log)* | sql/both | DB | `etl_run_log` row `running` (also abandons `running` rows older than 6 h) | Runs right after step 1; best effort: if it fails the run continues but **will not update Last Refresh** (warning logged). `started_at_utc` is the run's start. |
| 2 | `read_sql_incremental_metadata` | sql/both or incremental | `Fact_Orders`, `Fact_SalesLines`, `Fact_Sales` (latest order), `pipeline_load_metadata` | — | Chooses the incremental watermark (§5.2) and audits Excel fingerprints. |
| 3 | `odoo_authenticate` | all | Odoo | — | Bad URL/DB/key fails here in ≈ 0.01 min. |
| 4 | `extract_product_cost_and_inventory` | all | `product.product`, `stock.quant`, `stock.location`, `res.company` (4 parallel fetches) | — | Parallel fetch: if one model fails the run fails ("Parallel Odoo extraction failed for: ..."). |
| 5a | `sync_incremental_staging` | incremental | Odoo rows changed since the cutoff (`write_date`/`create_date`) | `raw_*` staging tables, `raw_sale_report_api` window | Falls back to a full staging sync if no safe cutoff (§5.2). |
| 5b | `extract_sale_report`, `extract_crm_models` | full | `sale.report`; CRM/order/picking/move models (6 parallel) | (sql/both) `raw_sale_report_api` replaced | The long steps of a full run (≈ 10 min). |
| 6 | `transform_sales_model` | all | Excel reference data (cached), raw sales | in-memory frames | Applies `ProductNameMapper`, cleaning, product/cost attach, currency/quantity cleaning, dimensions and `Fact_SalesLines`/`Fact_Orders`. |
| 7 | `transform_crm_model` | all | CRM frames | in-memory frames | Builds CRM facts; aligns `Fact_Orders` with `Fact_Sales`; extends `Dim_Date`; runs `ModelValidator` (raises on ERROR issues; `--strict` also on warnings). |
| 8 | `export_excel_workbook`, `export_inventory_validation` | excel/both | frames | `SalesModel_OneOutput.xlsx`, inventory workbooks in `ETL_OUTPUT_DIR` | Not run for `--output sql`. |
| 9 | `load_database_and_validate` | sql/both | frames | all `Fact_*`/`Dim_*`/`QA_*` tables; read-path indexes | Takes the MySQL lock `sales_pipeline_full_load` (waits 30 s, then fails: "Could not acquire SQL load lock"). Then row-count validation (a mismatch raises), window/mirror validation, sales-date and **freshness validation against Odoo** (§13). |
| 10 | *(finish)* | sql/both | target `Fact_Orders` | `etl_run_log` → `success` + watermark (one transaction); then legacy `pipeline_run_audit` + `pipeline_run_log` | If `etl_run_log` cannot be written the run **fails** on purpose (so it is retried, not silently stale). Legacy-table write failures are warnings only. |

On any exception the same code path writes `etl_run_log` = `failed` (with `data_loaded=true` and the watermark if step 9 had already written tables),
then the legacy tables, then re-raises.

---

## 5. Run modes

| | **Full** (`--load-mode full`) | **Incremental** (`--load-mode incremental`, usually with `--fast`) |
|---|---|---|
| Odoo extraction | Whole `sale.report` + all CRM/stock models | Only rows with `write_date`/`create_date` ≥ cutoff (staging upsert) |
| Table load | Every table dropped and recreated (`DB_RELOAD_MODE=drop_recreate`, default) or truncated + reinserted (`truncate`) | Date-window delete/insert for `Fact_SalesLines`/`Fact_Orders`; key-based upsert for dimensions; skip unchanged |
| Typical duration | ≈ 16.5 min (measured Apr 2026) | ≈ 3 min (measured Apr 2026) |
| Schedule | `0 2 * * *` (nightly) | `50 8,11,14,17,20 * * *` (five times a day) |
| Output | `sql` | `sql` (scheduled: `--fast`) |

### 5.1 Choosing a mode

Use **incremental** for routine refreshes. Force a **full** refresh (`Admin → Start Full`, or `--full-refresh`) when: the staging
tables are missing/corrupt; historical Odoo records were **deleted** or reclassified (incremental never removes rows that are outside
its window); Odoo schema/fields changed; a product master or mapping change must be re-applied to history; after restoring a backup; or when
a formal reconciliation is required. `--force-sales-full-refresh` reloads only sale orders/lines when the rest is trusted.

### 5.2 How the incremental watermark is chosen

`PowerBISalesPipeline._latest_sql_order_tuple` reads the latest date from three tables and picks the greatest:

| Candidate | Order column | Date column |
|---|---|---|
| `Fact_Orders` | `order_number` | `OrderDateTime` |
| `Fact_SalesLines` | `order_number` | `order_date` |
| `Fact_Sales` | `OrderNumber` | `OrderDateTime` |

It logs each (`Latest SQL Fact_Orders: S01234 | 2026-09-20 14:42:00`), keeps those that are not `None`, takes the one with the maximum date,
cross-checks it against SQL `GREATEST(MAX(...), MAX(...), MAX(...))` (a disagreement raises "Incremental cutoff validation failed"), and logs
**`Selected incremental latest SQL order: <order> | <datetime> | source=<table>`**. Then `_incremental_cutoff_from_sql` subtracts
`INCREMENTAL_OVERLAP_DAYS` (default and minimum **7**), interprets the result as business-timezone wall-clock, converts it to UTC and sends it
to Odoo as the `write_date`/`create_date` lower bound; the SQL window cutoff is the same instant converted back to business time.

* **`Latest SQL Fact_Sales: None`** means `Fact_Sales` has no row with a date (empty table) **or the query failed** — the helper swallows every
  exception. It is harmless if another candidate has a value (the log then says `source=Fact_Orders`); if **all three** are `None` the log says
  `Latest SQL order: no existing final sales table found`, there is no cutoff and **staging falls back to a full sync** while the load mode stays
  "incremental" (`Incremental SQL requested without cutoff; falling back to full SQL export`). If all three are `None` although the tables have
  data, suspect the DB connection/permissions (§11).
* An **empty `Fact_Sales`** also means `Fact_Orders` has **no `QuotationDate` column** (it is only added by aligning with `Fact_Sales`); the freshness
  check and the run-log watermark treat that as "created-at unknown", not as an error.

---

## 6. Triggers and scheduling

| Trigger | How | `trigger_source` in `etl_job_runs` | `etl_run_log.trigger_source` |
|---|---|---|---|
| Scheduled incremental | cron `ETL_SCHEDULE_INCREMENTAL_CRON` (default `50 8,11,14,17,20 * * *`), `ETL_SCHEDULE_INCREMENTAL_ENABLED=true` | `scheduled` | `scheduled-incremental` |
| Scheduled full | cron `ETL_SCHEDULE_FULL_CRON` (default `0 2 * * *`), `ETL_SCHEDULE_FULL_ENABLED=true` | `scheduled` | `scheduled-full` |
| Admin UI | Control Center buttons (Admin role) | `manual` | `manual-incremental`, `manual-full`, `manual-sql`, `manual-excel` |
| CLI (queued) | `docker compose exec backend npm run etl:run` (`-- --full`) | `development` | label of the command |
| CLI (`--sync`) or `python -m sales_pipeline.main` | inline; not in `etl_job_runs` | — | `cli` |

* **Schedule ownership.** Cron runs inside the *backend API process* (`server.ts` → `registerEtlSchedules()`), in the zone `ETL_SCHEDULE_TIMEZONE`
  (compose sets it to `APP_TIMEZONE`). With the schedule times chosen to precede the Power-BI-style refresh points at 09:00/12:00/15:00/18:00/21:00
  (`docs/AUTOMATION.md`). Run **one** backend replica: several would each tick (the guard below would make the extras no-ops, but it is wasteful).
* **"Next Incremental Refresh"** = `computeNextRunTime(ETL_SCHEDULE_INCREMENTAL_CRON, ETL_SCHEDULE_TIMEZONE)`; returned by `GET /admin/etl/status` and
  `/admin/etl/scheduler-config`. It is computed, not read from a job queue; it is `null` when the schedule is disabled or the cron is invalid
  (an invalid cron is logged and **not registered**).
* **Change the schedule:** edit the variables in `backend/.env`, `docker compose up -d backend` (restart required; nothing re-reads them live).

### 6.1 Concurrency lock — four layers

1. **`etl_job_runs` + `etl_enqueue_guard`** (MySQL `GET_LOCK`, 10 s): only one queued/running row can exist; a second start gets `EtlAlreadyRunningError` (HTTP 409).
2. **BullMQ worker `concurrency: 1`**.
3. **Flask `JobTracker`**: one active job per process (HTTP 409 on `/etl/run`).
4. **MySQL `sales_pipeline_full_load`** held for the whole SQL write phase (`GET_LOCK`, wait 30 s). Covers runs started from a shell that bypass 1–3.
   The lock connection has `wait_timeout` = 2 h so MySQL frees it even if the process is SIGKILLed.

**Overlapping runs.** A scheduled tick while a run is active is logged (`Scheduled incremental ETL tick skipped`) and dropped (no backlog). A manual start
returns 409. A second direct CLI run waits 30 s for the SQL lock and then fails with "Could not acquire SQL load lock". A stuck lock: Admin → *Force reset*
(resets `etl_job_runs`, BullMQ, the Flask tracker and kills the lock-holding MySQL connection; the app DB user needs `SELECT` on `performance_schema.*` and `CONNECTION_ADMIN` for that last part, see DEPLOYMENT.md §4).
BullMQ retries a failed run twice (30 s, 60 s exponential); a *cancelled* run is not retried.

---

## 7. Configuration reference

### 7.1 ETL process (`data/etl/.env` → etl-api container; read by `config/settings.py`)

| Variable | Purpose | Default | Required | Example (placeholder) |
|---|---|---|---|---|
| `ODOO_URL` | Odoo base URL | — | **yes** | `https://CHANGE_ME.odoo.com` |
| `ODOO_DB` | Odoo database | — | **yes** | `CHANGE_ME` |
| `ODOO_USER` | Odoo API user | — | **yes** | `CHANGE_ME` |
| `ODOO_API_KEY` | Odoo API key (**secret**) | — | **yes** | `CHANGE_ME` |
| `ODOO_TIMEOUT_SECONDS` / `ODOO_MAX_RETRIES` | RPC timeout / retries | `60` / `5` | no | |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Target MySQL (**`DB_PASSWORD` secret**). Compose overrides `DB_HOST`. | `localhost`, `3306`, `powerbi_sales`, ``, `` | **yes** (or `DB_URL`) | `DB_NAME=ps_warehouse` |
| `DB_URL` | Full SQLAlchemy URL instead of the five above (**secret**) | empty | no | `mysql+pymysql://USER:PASSWORD@HOST:3306/DB` |
| `DB_TYPE` | Only `mysql` is supported | `mysql` | no | |
| `DB_SCHEMA` | Optional schema prefix | empty | no | |
| `DB_RELOAD_MODE` | `drop_recreate` or `truncate` for full loads | `drop_recreate` | no | |
| `DB_CHUNKSIZE` | Insert chunk size | `5000` | no | |
| **`DB_SESSION_TIMEZONE`** | `SET time_zone` on every MySQL connection the ETL opens | `+00:00` | no | `+00:00` |
| **`TIMEZONE`** | Business zone Odoo UTC times are converted to. **Must equal backend `APP_TIMEZONE`.** | `Africa/Tripoli` | no (set it) | `Africa/Tripoli` |
| `TZ` | OS zone of the container (log readability only) | image default (UTC) | no | `Africa/Tripoli` |
| **`ETL_INPUT_DIR`** (alias `INPUT_DIR`) | Folder with the Excel inputs **inside the container**. Relative = under `data/etl/`. A `C:/...` value on Linux fails fast with the fix. | `data/etl/input` | in Docker: set by compose to `/etl/input` | `/etl/input` |
| **`ETL_INPUT_HOST_DIR`** | *Compose/host variable*: host folder mounted read-only onto `ETL_INPUT_DIR` | `./data/etl/input` | **yes** in production | `/srv/07ps/etl/input` |
| **`ETL_OUTPUT_DIR`** (alias `OUTPUT_DIR`) | Writable folder for Excel outputs, `.pipeline_cache`, workbooks | `data/etl/Exports` | compose sets `/etl/output` | `/etl/output` |
| `ETL_OUTPUT_HOST_DIR` | Host folder for the output mount (unset = named volume `etl_output`) | named volume | no | `/srv/07ps/etl/output` |
| `OUTPUT_FILE`, `INVENTORY_VALIDATION_FILE`, `UNMAPPED_PRODUCTS_FILE` | Output workbook names | `SalesModel_OneOutput.xlsx`, `Inventory_Validation.xlsx`, `Unmapped_Products.xlsx` | no | |
| `BATCH_SIZE` | Odoo RPC batch size | `500` | no | |
| `INCREMENTAL_OVERLAP_DAYS` | Days re-read before the latest order (min 7) | `7` | no | |
| `ASSUME_UTC_FOR_NAIVE` | Treat naive Odoo timestamps as UTC | `false` | no | |
| `FORCE_SALES_FULL_REFRESH` | Always reload raw sale orders/lines | `false` | no | |
| `INCLUDE_UNINVOICED_SALES_LINES` | Include uninvoiced lines | `false` | no | |
| `CRM_INACTIVE_DAYS_THRESHOLD`, `CRM_RECENT_ACTIVITY_DAYS` | CRM classification | `30`, `14` | no | |
| **`ETL_ALLOW_EMPTY_PRODUCT_MAPPING`** | Allow a run whose `PRODUCTS.xlsx` yields 0 mappings | `false` | no | |
| `ETL_TRIGGER_SOURCE` | Set by the Flask API from the job label; stored in `etl_run_log.trigger_source` | `cli` | no | |
| `ETL_API_KEY` | Bearer secret the Flask API expects (**secret**, equals backend's) | — | **yes** | `CHANGE_ME` |
| `LOG_LEVEL`, `PORT`, `PYTHON_BIN`, `FLASK_ENV` | Flask API | `INFO`, `5001`, `sys.executable`, — | no | |

### 7.2 Backend / worker (`backend/.env`)

| Variable | Purpose | Default | Required | Example |
|---|---|---|---|---|
| `ETL_API_URL` | URL of the etl-api | (empty) | **yes** | `http://etl-api:5001` |
| `ETL_API_KEY` | Bearer key (**secret**) | empty | **yes** | `CHANGE_ME` |
| `ETL_API_POLL_INTERVAL_MS` | Status polling | `1000` | no | |
| `ETL_LOG_DIR` | Orchestration log dir | `./logs/etl` (compose: `/var/log/07ps/etl`) | no | |
| `ETL_SCHEDULE_INCREMENTAL_CRON` / `_ENABLED` | Incremental schedule | `50 8,11,14,17,20 * * *` / `true` | no | |
| `ETL_SCHEDULE_FULL_CRON` / `_ENABLED` | Full schedule | `0 2 * * *` / `true` | no | |
| `ETL_SCHEDULE_TIMEZONE` | Zone for both crons | server zone (compose: `APP_TIMEZONE`) | no | `Africa/Tripoli` |
| `REDIS_HOST`, `REDIS_PORT` | BullMQ Redis | `localhost`, `6379` (compose: `redis`) | **yes** | |
| **`APP_TIMEZONE`** | Business/display zone; zone of the naive `Fact_*` datetimes | `Africa/Tripoli` | no (set it) | `Africa/Tripoli` |
| **`REFRESH_CHECK_TOLERANCE_MINUTES`** | Skew tolerated by the freshness check | `5` | no | `5` |
| `REFRESH_STALE_AFTER_MINUTES` | Minutes without a successful run before "stale" | `270` | no | `270` |
| `DB_*`, `JWT_SECRET`, `FRONTEND_ORIGIN`, `SMTP_*`, rate limits | Web app (not ETL) — see DEPLOYMENT.md §2 | | | |

Frontend build variable: `NEXT_PUBLIC_APP_TIMEZONE` (default `Africa/Tripoli`, build-time) — display zone in the browser.

---

## 8. Timestamps and timezones

**Rules**

1. Operational metadata is stored in **UTC**, tz-aware in code, and named `*_utc` in the schema: `etl_run_log.*_utc`.
2. The MySQL session of the Node pool (`db/pool.ts`) **and** of the ETL (`DB_SESSION_TIMEZONE=+00:00`) is pinned to UTC, so `CURRENT_TIMESTAMP` and `TIMESTAMP` columns no longer depend on the DB server's own zone (observed `+02:00`).
3. Business fact datetimes (`OrderDateTime`, `QuotationDate`, `order_date`, `DateKey`) remain **naive wall-clock in the business timezone** (`TIMEZONE` = `APP_TIMEZONE`, default `Africa/Tripoli`): the calendar date drives `DateKey` and every period filter, so converting them to UTC would move orders across midnight. They are converted to UTC *at comparison time* by one function per language (`to_utc` in Python, `tripoliSqlDateTimeToDate` in TypeScript).
4. The display zone (`APP_TIMEZONE` / `NEXT_PUBLIC_APP_TIMEZONE`) is applied **only** at the presentation layer (frontend `formatTimestamp`, the message text of the freshness check).
5. ETL container, backend containers, frontend and Redis have `TZ` = `APP_TIMEZONE` (compose); this only affects log readability — no logic depends on it any more.

| Item | Storage type | Timezone / representation |
|---|---|---|
| Odoo API datetimes (`date_order`, `create_date`, `write_date`) | string, no zone marker | **UTC** (Odoo convention); converted to business zone by `odoo_utc_datetime_to_local` |
| `raw_*` staging tables | raw Odoo values | UTC |
| `Fact_Orders.OrderDateTime/OrderDate/QuotationDate`, `Fact_SalesLines.order_date`, `Fact_Sales.*Date`, `Dim_Date` | naive `DATETIME`/date | **business zone** wall-clock |
| Incremental cutoff sent to Odoo | naive UTC | derived: business-local watermark − overlap → UTC |
| **`etl_run_log.started_at_utc/finished_at_utc/watermark_*_utc/created_at_utc`** | `DATETIME` | **UTC** (written explicitly; `business_timezone` column records the zone used for the watermark conversion) |
| `pipeline_run_log.pipeline_start/end_time`, `pipeline_run_audit.started/finished_at` (legacy) | naive `DATETIME` | **business zone** since this change (`_legacy_naive`). *Before* it: the ETL container's zone (UTC in Docker) → mixed history; see §9.6 |
| `pipeline_*.created_at`, `updated_at`, `pipeline_load_metadata.last_successful_load_time` | `DATETIME DEFAULT CURRENT_TIMESTAMP` | UTC now (session pinned). Before: DB server zone (`+02:00`) |
| `pipeline_load_metadata.last_modified_time` (file mtime / table stamp) | naive | container-local; informational only, not used by the freshness check |
| `etl_job_runs.queued_at/started_at/finished_at` | `TIMESTAMP` | UTC (read under the UTC session). **Bug fixed here:** they were parsed as Libya time, showing every run 2 h early |
| App auth tables (`revoked_tokens`, `password_*`) | `TIMESTAMP` | UTC |
| API JSON | ISO 8601 with `Z` | UTC; `/meta/refresh-status` adds `displayTimezone` |
| Frontend | — | `Intl` with `APP_TIMEZONE` |
| Python logs | text | `TIMEZONE` with explicit offset, e.g. `2026-09-20 15:15:11 +0200` |
| Node logs (`etl.log`) | text | container `TZ`, **no offset** (`YYYY-MM-DD HH:mm:ss`) |
| Cron | expression | `ETL_SCHEDULE_TIMEZONE` |
| BullMQ / Flask job objects | epoch ms / ISO | UTC |

DST: Africa/Tripoli has no DST today; the helpers resolve the offset from the IANA database, and behave deterministically if a DST zone is configured
(non-existent local times use the pre-transition offset, ambiguous ones the first occurrence). Both are covered by tests.

---

## 9. The refresh log and freshness check

### 9.1 Definition

**Last Refresh = `finished_at_utc` of the newest `etl_run_log` row with `status = 'success'`.** A row becomes `success` only after the data load and its validations
passed, and in the **same transaction** the watermark is read back from the loaded `Fact_Orders` and stored on it. A failed, cancelled or still-running run never moves Last Refresh.

> Honest limit: MySQL cannot make the *load itself* (per-table `DROP`/`TRUNCATE` are implicit-commit DDL, windows are delete-then-insert) atomic with the log row. What is atomic is "watermark + success flag"; the load is committed *before* it. A crash between the two leaves a `running` row (reaped after 6 h as `failed`) and data newer than the last success — which the check reports (`data_ahead_of_watermark`).

### 9.2 Schema (`data/warehouse/migrations/0022_etl_run_log.sql`)

| Column | Meaning |
|---|---|
| `run_id`, `run_uid` (UUID, unique) | Row id; id generated by the pipeline process for this run |
| `mode` | `full` / `incremental` (`unknown` for backfilled rows without an audit match) |
| `output_mode`, `trigger_source`, `host` | `sql`/`both`; job label (§6); container hostname |
| `status` | `running` / `success` / `failed` |
| `started_at_utc`, `finished_at_utc`, `duration_seconds` | UTC |
| `watermark_order_date_utc` | `MAX(Fact_Orders.OrderDateTime)` **after** the load, UTC |
| `watermark_order_created_utc` | `MAX(Fact_Orders.QuotationDate)` (Odoo `create_date`) after the load, UTC; `NULL` if the column does not exist |
| `watermark_order_number` | order number of the latest `OrderDateTime` |
| `business_timezone` | zone used for the watermark conversion (`TIMEZONE`) |
| `rows_processed`, `odoo_extract_count`, `qa_issues_count` | counters (`rows_processed` = rows across all loaded tables) |
| `error_message` | failure text (`failed`) |
| `legacy_backfill`, `pipeline_run_log_id` | row derived from `pipeline_run_log` |
| Indexes | `(status, finished_at_utc)`, `(started_at_utc)`, unique `run_uid` |

Failed rows that failed **after** writing tables also carry the watermark columns (`finish_failed(data_loaded=True)`), so the check can attribute newer data to that run.

### 9.3 How it is written

`PowerBISalesPipeline.run()`: step 0 inserts `running`; step 10 calls `EtlRunLog.finish_success()` (one `engine.begin()` transaction: read watermark + `UPDATE ... status='success'`); the `except` path calls `finish_failed()`.
Times come from `datetime.now(timezone.utc)`; nothing uses `CURRENT_TIMESTAMP`.

### 9.4 How the dashboard reads it

`GET /meta/refresh-status` (`routes/meta.ts` → `measures/refreshStatus.ts`) returns `lastRefreshTime` (UTC), `lastUpdate` (= `MAX(OrderDateTime)` converted to UTC), `lastOrderCreated`,
`isStale`, `isInverted` (= `refreshCheck.inconsistent`, kept for the existing frontend contract), `refreshCheck` and `displayTimezone`. The frontend formats times in `APP_TIMEZONE`;
`ValidationStatusBar` shows the red banner only when `refreshCheck.inconsistent`, with the check's own message and action.

Comparison is **loaded watermark ↔ data actually in the target tables** — never the live source, and never a business date. Everything is normalised to UTC first; tolerance = `REFRESH_CHECK_TOLERANCE_MINUTES` (default 5).

### 9.5 Meaning of each status

| `refreshCheck.status` | Red banner? | Meaning | What to do |
|---|---|---|---|
| `ok` | no | Last refresh is not earlier than the newest loaded order's creation time (± tolerance) and nothing newer than the recorded watermark exists. Message: *"Last refresh 2026-09-20 14:45 Africa/Tripoli, latest loaded order 2026-09-20 14:40 Africa/Tripoli, difference 5 min, timezone Africa/Tripoli"*. | — |
| `no_refresh_log` | no (stale note only) | No `success` row in `etl_run_log`. | Start an ETL run; on an existing database apply migration 0022 and run the backfill. |
| `timezone_mismatch` | **yes** | The last run converted times with a different `TIMEZONE` than the backend's `APP_TIMEZONE`. | Set both to the same zone, run a full refresh. |
| `data_ahead_of_watermark` | **yes** | Tables hold orders newer than every run recorded in `etl_run_log` (beyond tolerance): a run loaded data without recording it, or data came from outside the ETL. | Admin → ETL Runs: find the failed run; start an incremental refresh so a success records the current data. |
| `refresh_before_data` | **yes** | Last refresh finished before the newest loaded order was created (beyond tolerance) and no failed run explains it → clock skew or timezone error. | Check `TIMEZONE`/`APP_TIMEZONE`/`DB_SESSION_TIMEZONE`, NTP on all hosts; run the backfill if the row predates the fix. |
| `last_run_failed_after_load` | no | The newest run failed after loading data (its watermark explains the newer data); Last Refresh still shows the last full success. | Fix the failed run and refresh. |

Independent of the above, `isStale` shows the amber "Data may be out of date" bar when there has been no success for `REFRESH_STALE_AFTER_MINUTES` (default 270 = 1.5 × the 3-hour cycle).

### 9.6 Backfill of old rows

`python scripts/backfill_etl_run_log.py [--dry-run] [--legacy-db-timezone Africa/Tripoli] [--business-timezone ...]` (run inside the etl-api container, or anywhere with the DB env). For each `pipeline_run_log` row not yet converted it writes an `etl_run_log` row with `legacy_backfill = 1`:

* Finish instant = the row's **`created_at`** (a `CURRENT_TIMESTAMP` stamped by the DB server at insert) converted from `--legacy-db-timezone`; the ambiguous naive `pipeline_end_time` is used only for a report line (`+2.0h from DB-local` ⇒ it had been written as UTC).
* Started = finish − `total_duration_minutes`; status `SUCCESS` → `success`, anything else `failed`.
* Watermark (`watermark_order_date_utc`) from the `pipeline_run_audit` row within ±15 min (`latest_order_datetime_after`, business zone → UTC); the created-at watermark stays `NULL`, so the check skips the watermark comparison for these rows.
* Idempotent (deterministic `run_uid`). Run it **once, before the first new run**, because after the code change `created_at` is UTC instead of DB-local. Tested on MySQL 8 with a `+02:00` server zone.

### 9.7 The "Refresh log looks wrong" incident — root cause

The banner appeared because the refresh time and the order times were read on **different clocks and different bases**, and the log could lag the data. Three defects compounded (all verified in code, and reproduced on a MySQL 8 server with a `+02:00` zone): (1) **Timezone**: the pipeline stamped `pipeline_end_time` with a naive `datetime.now()` — the container's clock, which is UTC in Docker (`main.py` documents "Containers run in UTC") — while the backend parsed every such naive value as Africa/Tripoli (`tripoliSqlDateTimeToDate`), and the order timestamps are converted to Tripoli by the ETL; every refresh therefore appeared 2 hours earlier than it was, and the check had zero tolerance. (2) **Log not tied to the load**: the run log was written *after* the tables and any failure to write it was only a warning; and a run that failed a validation step *after* committing data recorded `FAILED`, so the last `SUCCESS` row (naive `12:05`) stayed older than orders loaded later (`14:42` Tripoli) — the ETL log line `13:15` UTC that did not become the last successful refresh is consistent with exactly that. (3) **Wrong comparison basis**: the check compared with `MAX(OrderDateTime)` (a business/confirmation date that can be later than the load) instead of the record-creation time. The dashboard numbers were right because the data itself was loaded correctly; only the metadata was wrong. Suspects 3 and 5 were checked: the log *was* in the shared main database (`pipeline_run_log`, not a file), and clock skew between hosts cannot be established from the repository (mitigated by the tolerance and the `NTP` item in DEPLOYMENT.md §9). To confirm which run produced the incident on the production database, run the query in §11 ("Refresh log looks wrong").

**Fix:** `etl_run_log` (UTC, atomic success + watermark, failures recorded, including step-1 failures), a UTC-aware `PipelineRunContext`, UTC DB sessions, the rewritten check (watermark vs target tables, tolerance, specific message), the backfill, tests, and a post-deploy smoke check that fails the deployment on an inconsistent log (`scripts/post_deploy_check.py`).

---

## 10. Logging and monitoring

| Source | Location | Format |
|---|---|---|
| Pipeline (Python) | stdout/stderr of the subprocess → Flask job tracker (memory) → BullMQ job logs (Redis; view in Control Center *Live log* / `GET /admin/etl/runs/:id/log`) and `docker compose logs etl-api` | `2026-09-20 15:15:11 +0200 \| INFO \| sales_pipeline.pipeline \| <message>` |
| Orchestration | `/var/log/07ps/etl/etl.log` (named volume `etl_logs`; rotates at 10 MB × 5) and `docker compose logs backend etl-worker` | `2026-09-20 15:15:00 \| INFO \| Job picked up by worker {"jobId":...}` |
| Run history | `etl_run_log` (authoritative), `etl_job_runs`, `pipeline_run_log`/`_audit` (Admin → ETL Runs) | SQL |
| Container logs | Docker `json-file`, 50 MB × 5 per service | |

**A healthy run looks like this** *(illustrative — assembled from the log statements in the code, not captured from production; numbers are examples)*:

```text
2026-09-20 14:50:02 +0200 | INFO | sales_pipeline.runtime | Pipeline step validate_config_and_inputs started
2026-09-20 14:50:02 +0200 | INFO | sales_pipeline.pipeline | Input directory: /etl/input (exists=True)
2026-09-20 14:50:03 +0200 | INFO | sales_pipeline.pipeline | ProductNameMapper ready — 1324 Odoo→clean mappings loaded from /etl/input/PRODUCTS.xlsx
2026-09-20 14:50:03 +0200 | INFO | sales_pipeline.pipeline | Pipeline load mode: INCREMENTAL
2026-09-20 14:50:03 +0200 | INFO | sales_pipeline.runtime | Pipeline step validate_config_and_inputs completed duration_seconds=0.71
2026-09-20 14:50:03 +0200 | INFO | sales_pipeline.pipeline | Latest SQL Fact_Orders: S05821 | 2026-09-20 11:03:10
2026-09-20 14:50:03 +0200 | INFO | sales_pipeline.pipeline | Latest SQL Fact_Sales: S05821 | 2026-09-20 11:03:10
2026-09-20 14:50:03 +0200 | INFO | sales_pipeline.pipeline | Selected incremental latest SQL order: S05821 | 2026-09-20 11:03:10 | source=Fact_Orders
2026-09-20 14:50:04 +0200 | INFO | sales_pipeline.runtime | Pipeline step odoo_authenticate completed duration_seconds=0.62
   ... (extract / staging / transform steps, each "started" then "completed duration_seconds=...") ...
2026-09-20 14:52:41 +0200 | INFO | sales_pipeline.pipeline | SQL row-count validation passed for 24 table(s)
2026-09-20 14:52:44 +0200 | INFO | sales_pipeline.pipeline | etl_run_log: run 5b0f... success finished_at_utc=2026-09-20T12:52:44+00:00 watermark_order_date_utc=2026-09-20T12:42:00+00:00 watermark_order_created_utc=2026-09-20T12:40:00+00:00 order=S05840
2026-09-20 14:52:44 +0200 | INFO | __main__ | Total duration: 2.70 minutes
2026-09-20 14:52:44 +0200 | INFO | __main__ | Done
```

**Alerts to configure** (implementation choices are in DEPLOYMENT.md §9; each can be evaluated with one SQL query against `etl_run_log`):

| Alert | Condition (SQL sketch) | Suggested severity |
|---|---|---|
| Failed run | `SELECT COUNT(*) FROM etl_run_log WHERE status='failed' AND finished_at_utc > UTC_TIMESTAMP() - INTERVAL 1 HOUR` > 0 | page |
| Run too long | `status='running' AND started_at_utc < UTC_TIMESTAMP() - INTERVAL 45 MINUTE` (full run measured ≈ 17 min, incremental ≈ 3 min; **ASSUMPTION** 45 min is comfortably above both — tune after measuring in production) | warn |
| No successful run | `MAX(finished_at_utc) WHERE status='success'` older than 6 h (= 2 × the 3-hour cycle; matches `isStale` at 4.5 h) | page |
| Stale watermark | `MAX(watermark_order_date_utc)` of the last success older than N h on a working day while Odoo is producing orders | warn |
| Inconsistent refresh log | `GET /meta/refresh-status` → `refreshCheck.inconsistent = true` (the smoke script does this) | warn |
| Queue/worker down | `GET /health` → `dependencies.etlQueue.status != ok`; `etl-worker` container unhealthy | page |

---

## 11. Failure modes and troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `FileNotFoundError: Missing required input files in C:/Users/...` (or `Input validation failed: required input files are not usable` with `runtime=Linux`) | A Windows path (`INPUT_DIR=C:/...` left in `data/etl/.env` or a host path used as the container path), or the input folder is not mounted, or the wrong file case (`Products.xlsx` ≠ `PRODUCTS.xlsx` on Linux). The current code rejects `C:/…` on Linux with an explanation, compose forces `ETL_INPUT_DIR=/etl/input`, and preflight lists near-matches. | Set `ETL_INPUT_HOST_DIR` in the project `.env` to the **host** folder, `docker compose up -d etl-api`, run *Preflight* in the Control Center (or `curl -H "Authorization: Bearer $ETL_API_KEY" localhost:5001/etl/preflight`). Rename files to the exact names in §3.3. Under WSL use `/mnt/c/...`. |
| `ProductNameMapper ready — 0 mappings loaded` | `PRODUCTS.xlsx` present but the first sheet has empty `OdooProductName`/`ProductName`, the wrong sheet first, or the wrong file. (Historically this only logged a warning and the run continued with every product unmapped.) | Now the run **fails** with `ProductMappingError: ... 0 mappings` (and preflight `productMappings.ok=false`). Fix the workbook; only for a deliberately empty master set `ETL_ALLOW_EMPTY_PRODUCT_MAPPING=true`. |
| `Latest SQL Fact_Sales: None` | `Fact_Sales` is empty (first run, or a full load where the CRM build produced no rows) **or** the query failed (the helper swallows errors). | Harmless if `Selected incremental latest SQL order ... source=Fact_Orders/Fact_SalesLines` follows. If all three are `None`: check DB connectivity/permissions, then run a full refresh. |
| "Refresh log looks wrong" / `refreshCheck.inconsistent` | See §9.7 and §9.5. | Read the banner's message and action. To see what happened on the server: `SELECT run_id, status, mode, trigger_source, started_at_utc, finished_at_utc, watermark_order_created_utc, LEFT(error_message,200) FROM etl_run_log ORDER BY run_id DESC LIMIT 10;` and the matching rows of `pipeline_run_log`. Run the backfill if the history predates migration 0022. |
| `no_refresh_log` after deploy | Migration 0022 not applied or no run since. | `python data/warehouse/apply_migrations.py 0022_etl_run_log.sql`, backfill, run an incremental refresh. |
| `Missing required environment variables: ODOO_...` / `Missing database settings for SQL output: ...` | `data/etl/.env` incomplete. | Fill it (values from your secret store). |
| `Access denied for user` / `Can't connect to MySQL server` / `(2003)` | Wrong `DB_*`; from a container `DB_HOST=localhost` points at the container itself; Linux Docker without `host.docker.internal:host-gateway`; firewall. | Compose sets `DB_HOST` from `DB_HOST_FOR_CONTAINERS` and adds the host-gateway mapping. Test: `docker compose exec etl-api python -c "import pymysql,os;pymysql.connect(host=os.environ['DB_HOST'],user=os.environ['DB_USER'],password=os.environ['DB_PASSWORD'],database=os.environ['DB_NAME']);print('ok')"`. **Note:** with a bad connection the *incremental* metadata read reports `None` for all tables and falls back to a full sync — always fix connectivity first. |
| `Could not acquire SQL load lock 'sales_pipeline_full_load' within 30s` | Another run is loading (or a crashed one still holds the lock). | Wait for the other run; if none is active use *Force reset* (kills the lock holder) or `SELECT IS_USED_LOCK('sales_pipeline_full_load')` → `KILL <id>`. The lock connection self-expires after 2 h. |
| Control Center shows *Queued* forever | No worker consuming the queue, Redis down, or an orphaned row. | `docker compose ps etl-worker redis`; the status endpoint reports `workerAvailable`/`queueAvailable`; reconciliation marks stale rows failed within 5 min; *Force reset* as last resort. |
| HTTP 409 "A run is already active" from the Flask API | The in-memory tracker holds a job (e.g. after a Node-side reset). | *Force reset* (also calls `POST /etl/reset`) or restart `etl-api`. |
| HTTP 422 "ETL inputs are not ready" on Start | Preflight failed. | Read the message: it names the missing/invalid files, the folder searched and a hint. |
| `Incremental cutoff validation failed: selected latest timestamp ...` | The three tables disagree on the latest timestamp (partial earlier load). | Run a full refresh. |
| `SQL row-count mismatch` / `Excel/SQL final output validation failed` | A table load ended with a different row count than the frame (interrupted load, concurrent writer). | Re-run; if it persists run full with `--strict`. |
| Partial load (run died mid-load) | Loads are per-table, not one transaction (§12). | Re-run — loads are idempotent; use full refresh for certainty. `etl_run_log` shows `failed`/abandoned `running`. |
| Excel output "workbook locked" | `--output excel|both` while the workbook is open elsewhere. | Close it; the exporter writes an alternate file. |
| Dashboard shows old times after deploy | Frontend not rebuilt: `NEXT_PUBLIC_APP_TIMEZONE` / API URL are build-time. | `docker compose build frontend && up -d frontend`. |

---

## 12. Idempotency, recovery and rollback

* **Re-running is safe.** Full mode rebuilds every table from scratch; incremental mode deletes and reinserts the affected window/keys and skips unchanged tables. The MySQL lock prevents two concurrent loads. Duplicates by `order_number` are removed after each window load.
* **There is no single transaction and no staging-table swap.** In full mode each table is `DROP`ped and recreated (`to_sql(if_exists="replace")`) — a DDL implicit commit — so **during the SQL phase (≈ 5–6 min of the nightly full run) a dashboard query can hit a missing or partial table**. In incremental mode the window is deleted in batches and then re-inserted, so the window's rows are briefly absent. A crash mid-load leaves some tables new and some old. This is why the run log is written *after* validation, and why "run again" is the recovery. **Recommended improvement (not implemented):** load into `_new` tables and `RENAME TABLE` atomically; schedule the full refresh outside business hours (it already runs at 02:00).
* **Recover from a failed full refresh:** (1) read the error in Admin → ETL Runs / `etl_run_log.error_message`; (2) fix the cause (inputs, Odoo, DB, lock); (3) start *Full* again. The dashboard shows the last successfully loaded state only for tables that were not yet dropped — expect gaps until the rerun finishes (~17 min).
* **Restore from backup** (data corruption, bad deployment): stop the writers, restore the dump, re-run migrations that were added after it, then a full refresh:
  ```bash
  docker compose stop etl-worker etl-api backend
  gunzip -c db_backups/ps_warehouse-<UTC-stamp>.sql.gz | mysql --defaults-extra-file="$BACKUP_DEFAULTS_FILE" ps_warehouse
  docker compose up -d
  ```
  `etl_run_log` is inside the dump, so it rewinds with the data (its watermark then matches the restored tables). Details: DEPLOYMENT.md §4.
* **Roll back the application** without touching data: `scripts/deploy.sh rollback [tag]` (migration 0022 is additive; old code simply ignores `etl_run_log` — but then the old, buggy check returns).

---

## 13. Data validation checks

Run in-process after/around the load (a failure raises and fails the run):

| Check | Where | Detail |
|---|---|---|
| Required sheets present | `_validate_output_sheets` | The 28 `REQUIRED_OUTPUT_SHEETS` (QA sheets optional in fast mode). |
| Structural model checks | `ModelValidator.validate` (`validation.py`) | **Duplicate/null primary keys** for each dim/fact (`Dim_Date.DateKey`, `Dim_Customer.CustomerKey`, `Fact_Orders.OrderKey`, `Fact_Sales.SalesDocumentID`, …) and **referential integrity** fact→dim (`CustomerKey`, `DateKey`, `ProductKey`, …). ERROR issues raise; warnings raise only with `--strict`. |
| Model key integrity | `_validate_model_key_integrity` | Null modeled keys. |
| SQL row counts | `validate_counts` | Rows written = rows in the frame (per table); mismatch raises `SQL row-count mismatch`. |
| Window / mirror validation | `_validate_incremental_sql_window`, `_validate_sql_matches_final_dataframes` (`--full-validation` or full mode) | Incremental: affected window and keys; full: every table equals its frame. |
| Duplicate order numbers, date coverage | `_log_sales_date_validation` | Logged; duplicate-key diagnostics for `Fact_Sales`. |
| **Reconciliation against the source** | `_validate_sales_freshness` | Fetches the **latest Odoo `sale.order`** and looks it up in `raw_sale_order`/`raw_sale_order_line` and in `Fact_Orders`/`Fact_SalesLines`/`Fact_Sales`, and compares its order/line counts and values. Skipped (warning) if no order was captured or staging tables are absent. |
| Cutoff self-check | `_latest_sql_order_tuple` | Selected latest timestamp equals SQL `GREATEST(...)`. |
| Full-vs-incremental baseline | `--validation-baseline` | Schemas, row counts, KPI totals vs a previous manifest. |
| Excel ↔ SQL | `_validate_excel_matches_sql_output` | `--output both` only. |
| **Refresh consistency** | `etl_run_log` + `/meta/refresh-status` | §9. |

---

## 14. Admin runbook (non-technical)

**Updating the Excel files**
1. Get the current file from the shared input folder (do not create a new file). Keep the **exact file name** and the **column headers**; do not rename or delete sheets.
2. Edit only the data rows. Rules: dates in `OffDays.xlsx` as `dd/mm/yyyy`; numbers without currency symbols; one row per product per Odoo name in `PRODUCTS.xlsx` (both `OdooProductName` and `ProductName` filled).
3. Save as `.xlsx` (not `.xls`/`.csv`) and **close Excel** (a temporary `~$...` file must not be left behind).
4. Put the file into the input folder on the server (ask DevOps for the location; it is the folder mounted read-only into the ETL).

**Running the ETL**
1. Sign in as an Admin → *Admin → ETL Control Center*.
2. Look at the **Preflight / Input files** panel. Every required file must be green ("ok"). If a file is red or missing, stop and read the hint, fix the file/name, and press *Preflight* again. Do not start a run while it is red — the button will refuse anyway.
3. Choose the mode: **Incremental** for a normal update (about 3 minutes). **Full** only if you were told to, or after big changes (about 17 minutes; the dashboard may show gaps while it runs — avoid business hours).
4. Press *Start*. Watch the status: *Queued* → *Running* (with the live log) → *Success* or *Failed*.
5. When it finishes, open a dashboard and check the footer: **Last Refresh** should be the time you just ran (shown in Libya time). No red banner should be visible.

**If it fails**
* Read the red message in the panel (it says what is wrong: missing file, wrong name, Odoo/DB problem).
* Missing/invalid file → fix and re-run. "Already running" → wait; do not press Force reset unless nothing has moved for 30+ minutes and DevOps agrees.
* A red "Refresh log check failed…" banner on a dashboard means the refresh record and the data do not agree; it lists what to do. Send DevOps the message text and the time.
* Anything else: send DevOps the run number and the error text from *Admin → ETL Runs*.

---

## 15. DevOps runbook

```bash
cd /srv/07ps/07ps-sales-dashboard-app          # ASSUMPTION: deployment folder
docker compose ps                                # status + health
docker compose logs -f --tail=200 etl-api        # pipeline output
docker compose logs -f --tail=200 etl-worker backend
tail -f "$(docker volume inspect 07ps-sales-dashboard-app_etl_logs -f '{{.Mountpoint}}')/etl.log"   # orchestration log
```

| Task | Command |
|---|---|
| Deploy / rollback | `scripts/deploy.sh deploy <tag>` / `scripts/deploy.sh rollback [tag]` (DEPLOYMENT.md §6–7) |
| Run an incremental refresh from the CLI (queued, tracked) | `docker compose exec backend npm run etl:incremental` |
| Same, inline without Redis/worker | `docker compose exec backend npm run etl:incremental -- --sync` |
| Full refresh | `docker compose exec backend npm run etl:full` |
| Run the pipeline directly (bypasses queue; still uses the SQL lock and writes `etl_run_log`) | `docker compose exec etl-api python -m sales_pipeline.main --output sql --load-mode incremental --fast` |
| Preflight | `docker compose exec etl-api sh -c 'curl -s -H "Authorization: Bearer $ETL_API_KEY" localhost:5001/etl/preflight'` |
| Restart pieces | `docker compose restart etl-api` (loses in-flight run; the row is failed by reconciliation) · `docker compose up -d backend` (after schedule/env changes) |
| Change the schedule | edit `ETL_SCHEDULE_*` in `backend/.env`, `docker compose up -d backend` |
| Change timezone | set `APP_TIMEZONE` in the project `.env` **and** `TIMEZONE` stays in sync (compose derives it), `docker compose build frontend && docker compose up -d`, then run a **full** refresh |
| Update Excel inputs | copy into `ETL_INPUT_HOST_DIR` (read-only for the container; write as the host user), then Preflight |
| Rotate credentials | Odoo key / DB password / `ETL_API_KEY`: change in the secret store → update `data/etl/.env` (and `backend/.env` for `ETL_API_KEY`/DB) → `docker compose up -d etl-api etl-worker backend` (containers re-read `env_file` on recreate, not on restart) → run the smoke script |
| Upgrade | `git pull`, `scripts/deploy.sh deploy <new-tag>`; new migration files are listed in the release notes |
| Backfill legacy log (once, before the first new run) | `docker compose exec etl-api python scripts/backfill_etl_run_log.py --dry-run`, review, then without `--dry-run` (the image contains `data/etl/scripts/`; the container's working directory is `/repo/data/etl/api`, so use `python /repo/data/etl/scripts/backfill_etl_run_log.py`) |
| Inspect the run log | `mysql ... -e "SELECT run_id,status,mode,trigger_source,finished_at_utc,watermark_order_created_utc FROM etl_run_log ORDER BY run_id DESC LIMIT 10"` |

---

## 16. Performance and sizing

* **Runtime:** ≈ 16.5 min full, ≈ 3.0 min incremental (measured 2026-04-29, `docs/AUTOMATION.md`); the two long parts of a full run are `extract_sale_report` (≈ 8.6 min, Odoo-bound) and the SQL load (≈ 5.7 min).
* **Volumes:** `Fact_Orders` ≈ 37 k rows (Jul 2026 reference), `PRODUCTS.xlsx` ≈ 2.5 k rows; `Fact_SalesLines` is larger (row count not recorded in the repository).
* **CPU/RAM — ASSUMPTION:** the pipeline is pandas-based and holds the whole model in memory; there is no memory measurement in the repository. Starting limits in `docker-compose.yml`: etl-api 2 CPU / 3 GB, backend and frontend 1 CPU / 768 MB, worker 512 MB. **Measure** `docker stats` during the first nightly full run and adjust. Host guideline: 4 vCPU / 8 GB RAM / 40 GB disk for the whole stack (DEPLOYMENT.md §1).
* **Tuning:** `DB_CHUNKSIZE` (insert batch), `BATCH_SIZE` (Odoo RPC), `ODOO_TIMEOUT_SECONDS`/`ODOO_MAX_RETRIES`; keep `INCREMENTAL_OVERLAP_DAYS` ≥ 7 (lower values are ignored); use `--fast` for scheduled incremental runs; the read-path indexes are created after each load (`ensure_query_indexes`: `Fact_SalesLines(DateKey)`, `(CompanyKey,SegmentKey,SalespersonKey,CustomerKey)`, `(SalespersonKey)`, `Fact_Orders(OrderDateTime)`, `(QuotationDate)`); further raw-table index suggestions are in `data/etl/INCREMENTAL_SQL_MODE.md`.
* Use `--profile` (cProfile output) and the `PERF ...` log lines to locate slow stages.

---

## 17. Security

* **Credentials** live only in `data/etl/.env` and `backend/.env` on the server (git-ignored) or your secret manager; the repository holds placeholders (`.env.example`, `deploy/config/*/*.env.example`). `ETL_API_KEY` must be identical on both sides and is compared in constant time; the Flask API returns 500 if it is unset (it never runs unauthenticated).
* **Network:** etl-api and Redis are published on `127.0.0.1` only; Nginx exposes only frontend and backend.
* **DB least privilege:** ETL account — `SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, LOCK TABLES` on the warehouse schema only (it must create/drop the tables it owns); it does not need any app-table write. App account — `SELECT` everywhere plus DML on app-owned tables, no DDL. Template: `data/warehouse/grants/least_privilege.sql`.
* **Input folder:** mounted **read-only** into etl-api; on the host make it writable only by the file owners (e.g. group `etl-inputs`, mode `2775`/`0664`), readable by the container user. Never place credentials in it.
* **Who can trigger:** only Admin-role users (`requireAdminRole`), plus anyone with shell access on the host. Scheduled runs use `trigger_source=scheduled`. Every manual run records the user (`etl_job_runs.triggered_by_user_id/name`).
* Logs may contain order numbers and customer names; treat them as internal data. `DB_URL` in logs is not printed by the pipeline.

---

## Appendix A — Glossary

| Term | Meaning |
|---|---|
| ETL | Extract (Odoo, Excel) – Transform (pandas) – Load (MySQL) |
| Fact / Dim | Star-schema tables: measurable events / descriptive entities |
| Watermark | Latest order timestamp a run loaded; the starting point of the next incremental window (minus overlap) and the reference of the refresh check |
| Incremental / Full | §5 |
| Staging (`raw_*`) | Copies of Odoo tables kept in MySQL to make incremental runs cheap |
| Preflight | Check that the Excel inputs are reachable and valid before a run |
| Last Refresh | Finish time (UTC, shown in `APP_TIMEZONE`) of the last **successful** ETL run |
| Last Update | `MAX(Fact_Orders.OrderDateTime)` — the latest order date in the data |
| BullMQ / Redis | The job queue between the backend and the worker |
| Business timezone | `Africa/Tripoli` (UTC+2, no DST) unless configured otherwise |

## Appendix B — Sample log output

See §10 (healthy run). A failed input check looks like:

```text
ERROR | sales_pipeline.pipeline | Input validation failed: required input files are not usable.
  Configured : ETL_INPUT_DIR=/etl/input
  Resolved   : /etl/input  (exists=True, is_directory=True, runtime=Linux)
  Files:
    [MISSING    ] sales_targets.xlsx (required)
    [OK         ] SalesTeam.xlsx (required)
    [MISSING    ] PRODUCTS.xlsx (required) -- expected the exact file name 'PRODUCTS.xlsx' (names are case-sensitive on Linux); found Products.xlsx
  Directory contains (4 shown): OffDays.xlsx, Products.xlsx, SalesTeam.xlsx, BlockedCustomers.xlsx
  Hint: A file with a different name or letter case exists -- rename it to the exact expected name.
```

## Appendix C — Full example `.env` files (placeholders only)

`data/etl/.env` (etl-api):

```dotenv
DB_HOST=CHANGE_ME                    # overridden by docker-compose (DB_HOST_FOR_CONTAINERS)
DB_PORT=3306
DB_USER=ps_etl
DB_PASSWORD=CHANGE_ME
DB_NAME=ps_warehouse
ODOO_URL=https://CHANGE_ME.odoo.com
ODOO_DB=CHANGE_ME
ODOO_USER=CHANGE_ME
ODOO_API_KEY=CHANGE_ME
ODOO_TIMEOUT_SECONDS=60
ODOO_MAX_RETRIES=5
TIMEZONE=Africa/Tripoli              # must equal backend APP_TIMEZONE (compose sets it)
DB_SESSION_TIMEZONE=+00:00
# ETL_INPUT_DIR / ETL_OUTPUT_DIR are set by docker-compose (/etl/input, /etl/output)
ETL_API_KEY=CHANGE_ME                # openssl rand -base64 32 ; equals backend ETL_API_KEY
LOG_LEVEL=INFO
FLASK_ENV=production
# ETL_ALLOW_EMPTY_PRODUCT_MAPPING=false
# INCREMENTAL_OVERLAP_DAYS=7
# DB_RELOAD_MODE=drop_recreate
```

Project `.env` (repo app root, read by `docker compose`):

```dotenv
APP_TIMEZONE=Africa/Tripoli
IMAGE_TAG=CHANGE_ME_RELEASE_TAG
DB_HOST_FOR_CONTAINERS=host.docker.internal
ETL_INPUT_HOST_DIR=/srv/07ps/etl/input
# ETL_OUTPUT_HOST_DIR=/srv/07ps/etl/output
NEXT_PUBLIC_API_BASE_URL=https://api.example.com
```

Backend variables: see `deploy/config/production/backend.env.example` and DEPLOYMENT.md §2.

## Appendix D — Assumptions

1. Owners and update cadence of the Excel files (§3.3) are not recorded in the repository.
2. Alert threshold "run longer than 45 min" (§10) is a starting value above the measured 17 min / 3 min runtimes.
3. Sizing (§16): no memory/CPU measurements exist in the repository; limits are starting values to verify with `docker stats`.
4. Runtimes come from the 2026-04-29 measurement in `docs/AUTOMATION.md`; production may differ.
5. The legacy `created_at` in `pipeline_run_log` was stamped by a DB server in `Africa/Tripoli` (`+02:00`) — stated in `db/pool.ts` ("observed as UTC+2 on the deployment host"); the backfill's `--legacy-db-timezone` lets you override it.
6. Deployment folder `/srv/07ps/...` and the input folder `/srv/07ps/etl/input` are placeholders.
7. The incident cannot be replayed on the production database from here; §9.7 identifies the mechanism from the code and from the numbers quoted in the incident; the diagnostic query in §11 confirms the specific run.
