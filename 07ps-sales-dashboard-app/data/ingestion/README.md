# Data Ingestion

Odoo + manual Excel Input sheets -> MySQL warehouse, run 5x/day (09:00/12:00/15:00/18:00/21:00,
Section 5.14), never queried live by the web app (Section 7.1).

**This replaces the earlier placeholder design.** A real, working pipeline
(`powerbi_sales_pipeline`) already exists and is what produces `SalesModel_OneOutput.xlsx` -- the
exact export the warehouse schema (`data/warehouse/`) was built and validated against. Per
explicit direction this session, that pipeline's logic (connection handling, transformation
rules, product-mastering, CRM classification) is **reused, not re-derived**. The old
`odoo_connector.py` / `excel_ingest.py` / `db.py` / `config.py` / `scheduler.py` files designed in
Task A before this pipeline was discovered are renamed `*.py.deprecated` (each has a header
explaining why) and superseded by everything below.

## Architecture

```
data/ingestion/
  vendor/sales_pipeline_src/sales_pipeline/   # unmodified copy of powerbi_sales_pipeline's package
  vendor/config/                              # unmodified copy of its Settings dataclass
  odoo/
    mock_client.py     # duck-typed MockOdooClient -- same interface as the real OdooClient
    fixtures.py         # hand-built mock Odoo dataset (10 models, realistic field shapes)
    extract.py           # build_client() + extract_all() -- mirrors pipeline.run()'s repository calls
  input_sheets/
    settings_factory.py  # resolves INPUT_DIR from env, builds vendored Settings
  star_schema/
    loader.py             # maps the pipeline's in-memory sheets -> MySQL star schema tables
  orchestrator.py           # one run: extract -> transform -> load -> audit log
  scheduler.py               # APScheduler, 5x/day, calls orchestrator.run_refresh()
  tests/                      # unit tests against the mock Odoo client
```

**Key design decision:** the vendored `PowerBISalesPipeline` class exposes `transform()` and
`transform_crm()` as public methods, callable directly -- its `run()` method's *only* Odoo/DB-shaped
work is calling these two methods, then a handful of merge steps, then exporting to an Excel
workbook. `orchestrator.py` calls `transform()`/`transform_crm()` and the same merge steps `run()`
calls (`_align_fact_orders_with_fact_sales`, `_ensure_fact_orders_order_key`,
`_extend_dim_date_for_sales_and_delivery`, `_validate_model_key_integrity`) directly on the pipeline
instance, then hands the resulting in-memory `sheets` dict to `StarSchemaLoader` instead of the
vendored Excel exporter. **Zero lines of the vendored package were modified** -- only its final
export step is replaced.

## Odoo connector

`odoo/extract.py` reuses the vendored repositories (`SalesReportRepository`,
`CrmRepository`, `SaleOrderRepository`, `StockPickingRepository`, `StockMoveRepository`,
`ProductCostRepository`, plus the inventory field-list constants) completely unmodified -- they
never touch XML-RPC directly, only a typed client interface (`authenticate`, `fields_get`,
`search_count`, `search_read`).

Two client implementations satisfy that interface:

- `vendor/sales_pipeline_src/sales_pipeline/odoo/client.py` -- the real `OdooClient`, XML-RPC
  against a live Odoo instance. **Gated behind `ALLOW_LIVE_ODOO=1`; not set or exercised in this
  session**, per explicit instruction not to run a live extraction without confirmation first.
- `odoo/mock_client.py` -- `MockOdooClient`, a duck-typed drop-in backed by `odoo/fixtures.py`.
  Used by default (`build_client()` returns this unless `ALLOW_LIVE_ODOO=1`). Implements
  `search_read` with a minimal flat-AND domain filter evaluator (the only domain shape the
  repositories actually send) and returns many2one fields in Odoo's real `[id, "Display Name"]`
  wire format, so `flatten_many2one_columns()` and everything downstream runs completely
  unmodified against it.

Odoo objects/fields pulled (mirrors `pipeline.run()`'s exact call sequence):

| Odoo model | Repository | Purpose |
| --- | --- | --- |
| `sale.report` | `SalesReportRepository` | Quotation/order line grain -> `fact_quotation`, `fact_order_line` |
| `crm.lead` | `CrmRepository` | Leads/opportunities -> `fact_lead`, `fact_opportunity` |
| `crm.stage` | `CrmRepository` | CRM pipeline stage lookup -> `dim_crm_stage` |
| `crm.lost.reason` | `CrmRepository` | Lost-opportunity reason lookup -> `dim_lost_reason` |
| `sale.order` | `SaleOrderRepository` | Order headers -> `fact_order` |
| `stock.picking` | `StockPickingRepository` | Delivery headers -> `fact_delivery` |
| `stock.move` | `StockMoveRepository` | Delivery line detail -> `fact_delivery` |
| `product.product` | `ProductCostRepository` + inventory | Odoo-side product catalog, cost, active flag -> `dim_product` |
| `stock.quant` | inventory extract | On-hand stock -> `fact_inventory_snapshot` |
| `stock.location` | inventory extract | Warehouse/location lookup for stock quants |
| `res.company` | inventory extract | Company lookup (Majaal / Tika) -> `dim_company` |

Full field lists per model are in each repository's `*_FIELDS` constant (unmodified from the
vendored package) and mirrored in `odoo/fixtures.py`'s `field_types` per model.

**No live Odoo access was used in this session.** Everything Odoo-sourced (sales, CRM, inventory
tables) was validated *structurally* -- correct classification logic, correct FK integrity, correct
row shapes, using a small hand-built mock catalog (2 companies, 2 sales teams, 3 customers, 4
products, 10 sale.report rows, 9 sale.order rows, 8 crm.lead rows). It was **not** reconciled
against real production values -- that requires a live Odoo connection, which needs your
confirmation first. See "Reconciliation" below for exactly which tables this affects.

## Input sheets (manual Excel)

`input_sheets/settings_factory.py` wraps the vendored `Settings.from_env()` dataclass.
`REQUIRED_INPUT_FILES` (5 files, matching what the vendored pipeline's loaders read):
`sales_targets.xlsx`, `SalesTeam.xlsx`, `PRODUCTS.xlsx`, `OffDays.xlsx`, `BlockedCustomers.xlsx`.

| Input file | Vendored loader | Warehouse table(s) |
| --- | --- | --- |
| `sales_targets.xlsx` | `loaders/targets_loader.py` | `fact_target_plan` |
| `SalesTeam.xlsx` | `loaders/sales_org_loader.py` | `dim_sales_team` (`dim_salesperson` also Odoo-enriched) |
| `PRODUCTS.xlsx` | `loaders/products_loader.py` | `dim_product` (Input Master rows; merged with Odoo-only products) |
| `OffDays.xlsx` | `loaders/offdays_loader.py` | `fact_calendar_exception` |
| `BlockedCustomers.xlsx` | `loaders/blocked_customers_loader.py` | `fact_customer_status_snapshot` (blocked/unblocked fields) |

### Path portability -- CLOSED: Google Drive (synced local folder)

The vendored `Settings` dataclass hardcodes a Windows default: `INPUT_DIR =
C:\Users\Lenovo\Desktop\PowerBIData\Input`. That does not exist on the Linux VPS deployment
target. `resolve_input_dir()` in `settings_factory.py` **requires an explicit `INPUT_DIR`
environment variable** and raises `InputSheetsError` rather than silently falling back to the
Windows path.

**Decision (confirmed): a Google Drive for Desktop-style synced local folder**, not SFTP, not a
network share, not a direct Drive API/OAuth integration. Whoever maintains the 5 Input files keeps
editing them in Drive as today; a Drive sync client running on the VPS mirrors that Drive folder
onto local disk, and `INPUT_DIR` simply points at that synced path (e.g.
`/mnt/gdrive/PowerBIData/Input`, exact mount path is a VPS provisioning detail, not an application
concern). No code change was needed for this beyond the environment-variable-driven `INPUT_DIR`
already in place -- `settings_factory.py` treats it as an ordinary filesystem path either way, and
does not need to know the files live in a synced Drive folder rather than a plain local directory.

Two things worth flagging for the VPS setup itself (infra, not this codebase):
- Sync latency: if a scheduled refresh runs while Drive is mid-sync, it could read a partially
  updated set of the 5 files. Given the 30-minute misfire tolerance already built into the
  scheduler (Section 2.1.2) and that these files change infrequently (targets/team/product/offdays/
  blocked-customer lists, not daily transactional data), this is a low-probability, low-impact risk
  -- not re-engineered around here, but worth knowing if a refresh ever looks like it read a
  half-updated file.
- The previously-open "direct Drive API integration" option (OAuth, `files.list`/`files.get`) was
  explicitly ruled out for now -- it would need credentials that haven't been provided, and the
  synced-folder approach needs none. If a future need arises to pull Drive files without a sync
  client, that would be a separate, explicitly-scoped follow-up, not silently added here.

### Critical operational hazard: `ProductActiveFlagReconciler`

The vendored pipeline includes a real, by-design feature: `ProductActiveFlagReconciler` compares
`PRODUCTS.xlsx`'s `IsActive` column against the live Odoo product catalog and **writes corrections
back to the Excel file on disk on every run** if they disagree.

This is safe in production, where the real Odoo catalog and the real `PRODUCTS.xlsx` are both
complete and consistent. It is **not** safe when testing with a narrow/mocked Odoo catalog against
the real `PRODUCTS.xlsx` -- during this session's validation, testing `pipeline.transform()` against
the real Input folder with the 4-product mock Odoo catalog caused the reconciler to mark 1,352 of
1,356 real products inactive and write that back to the real file. This was caught and reversed
(an untouched backup was found and restored), and a `/tmp/scratch_input/`-style copy-first
workflow was used for all further test runs, but it is a sharp edge worth calling out explicitly:
**never point this pipeline at the real Input folder with anything other than a real, complete
Odoo connection.** Always test against a disposable copy of the Input folder.

## Star schema loader

`star_schema/loader.py` takes the pipeline's in-memory `sheets` dict (same column names as its own
Excel export, since it's the same object before export) and bulk-loads it into the star schema
using a full delete-then-insert refresh per table (matches the vendored pipeline's own "full
snapshot every run" model -- there is no incremental/upsert logic here or in the vendored pipeline).

It also backfills `dim_date` (`_extend_dim_date()`) for DateKeys referenced by Fact_Targets /
Fact_OffDays / CRM / sales / delivery tables that fall outside the narrow sales-observed date
range the original 0001 migration's seed data covered -- computing weekday/quarter/etc. directly
from each YYYYMMDD key rather than assuming a pre-populated calendar covers everything. See
`../warehouse/measures/README.md` and `tachometer_kpi_validation.md` for a related finding: this
backfill is correct for whatever data the pipeline actually saw in a given run, but a run against a
narrow mocked Odoo catalog only backfills the dates *that run* observed -- a later query against a
wider real dataset needs the real `Dim_Date` sheet loaded too, not just this backfill.

## Orchestration & scheduling

`orchestrator.py::run_refresh()` is one full pipeline run: extract (Odoo, mocked by default) ->
`transform()` -> `transform_crm()` -> the same merge/validation steps `run()` performs -> load into
MySQL -> write `pipeline_run_log` / `pipeline_run_audit` rows. Failures write a `FAILED` row with
the error message and re-raise -- "report, don't silently fix," per the existing standard.

`scheduler.py` uses APScheduler's `BlockingScheduler` with a `CronTrigger` at 09:00, 12:00, 15:00,
18:00, 21:00 daily (`misfire_grace_time=1800`, i.e. a 30-minute tolerance per Standards Section
2.1.2), one persistent process -- mirroring the scheduling mechanism you confirmed (option A).

Audit logging reuses the vendored pipeline's own schema verbatim rather than a parallel design --
see `data/warehouse/migrations/0007_etl_and_audit_log.sql`'s header for the full reasoning.

## Running the validation

```bash
export INPUT_DIR=/path/to/Input          # required, no Windows-path fallback
export PYTHONPATH=data/ingestion:data/ingestion/vendor:$PYTHONPATH
python3 -m pytest data/ingestion/tests/ -v      # mock-client unit tests
python3 -c "from orchestrator import run_refresh; print(run_refresh())"
```

Default is the mock Odoo client -- no network calls, no credentials needed. Real extraction
requires `ALLOW_LIVE_ODOO=1` plus real Odoo credentials in `.env`, and per this session's explicit
instruction has not been exercised.

## Reconciliation report (Task C validation run)

Full pipeline run: mocked Odoo (10 models, hand-built fixtures) + the real Input folder (via a
disposable copy, see hazard note above) -> throwaway local MySQL 8. Result: **0 row errors, 2,183
rows loaded across 20 tables**, `orchestrator.run_refresh()` returned `SUCCESS`, and
`pipeline_run_log` / `pipeline_run_audit` rows were confirmed written correctly.

Tables genuinely reconciled against the real `SalesModel_OneOutput.xlsx` export (these are driven
entirely by the real Input files, independent of the mocked Odoo data used this session):

| Table | Check | Result |
| --- | --- | --- |
| `fact_target_plan` (`sales_targets.xlsx`) | Row count (616) + full natural-key duplicate analysis | Match. See correction note below. |
| `dim_sales_team` (`SalesTeam.xlsx`) | Full `sales_team_key` set (28 keys) vs. real `Dim_SalesTeam` sheet | Exact match |
| `fact_calendar_exception` (`OffDays.xlsx`) | Full `(date_key, sales_team_key, off_day_type)` set (21 rows) vs. real `Fact_OffDays` sheet | Exact match |
| `dim_product` (`PRODUCTS.xlsx`) | All 322 distinct `ProductKey` values in the real Input file's Sheet1 present in loaded `dim_product`; spot-checked field values (category, family, is_active) | All present, 0 missing; spot-checked row matched field-for-field (case/title normalization from the pipeline's own cleaning logic is expected, not a defect) |

**Correction to an earlier working note during this session:** an initial pass concluded
`salesperson_key` was "0 for effectively every row" in `fact_target_plan`, based on running the
real `sales_targets.xlsx` through the pipeline with the tiny 2-salesperson mock Odoo catalog (which
can't resolve most real salesperson names). Checking directly against the real export corrects
this: `SalespersonKey` takes 34 distinct values across the 616 real rows and mostly resolves to a
real individual. The reason the `(date_key, salesperson_key, segment_key, channel_key)` natural key
still isn't unique is narrower and confirmed against real data: key `0` ("unresolved") is a shared
fallback bucket that several different named salespeople collapse into within the same month (12 of
the 13 real duplicate groups), and a 13th group is an unrelated source-data defect -- 12 rows for
team `TK-WST-BB` all carry `TargetDate = 1970-01-01` despite having distinct, valid `Year`/`Month`
values, meaning that team's date field was never correctly computed in `sales_targets.xlsx`. See
`KNOWN_ISSUES.md` for the full write-up and current tracking status of that defect (still pending a
source-file fix, deliberately not patched in the pipeline).

Tables validated **structurally only** (mocked Odoo, not reconciled against real production
values -- needs a live Odoo connection with your confirmation to close):

- `fact_quotation`, `fact_order`, `fact_order_line` (sale.report / sale.order)
- `fact_lead`, `fact_opportunity` (crm.lead), `dim_crm_stage`, `dim_lost_reason`
- `fact_delivery` (stock.picking / stock.move)
- `fact_inventory_snapshot` (stock.quant / stock.location)
- `dim_salesperson` (resolved from Odoo sale/CRM history -- real export has 74 distinct
  salespeople; the mock catalog only produced 3, as expected given its narrow scope)
- The Odoo-sourced portion of `dim_product` (product cost, Odoo-only products not in
  `PRODUCTS.xlsx` -- real export's merged `Dim_Product` sheet has 3,867 rows vs. 1,356 loaded here,
  the difference being Odoo-catalog products the 4-product mock doesn't have)

These are correctly classified/shaped (won/lost/open logic, FK integrity, quotation-age
thresholds) per passing tests, but their *values* have not been and cannot be checked against real
production Odoo without a live connection.

## Tachometer KPI measures layer validation

A separate, later validation pass built and validated the Tachometer page's KPI query layer
(`data/warehouse/measures/`) against real Value/Volume/ASP/Target figures -- see
`tachometer_kpi_validation.md` in this same directory for the full report, and
`KNOWN_ISSUES.md` for the `TK-WST-BB` defect this work is downstream of.
