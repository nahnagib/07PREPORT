# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). This project doesn't tag
releases yet (still pre-1.0, Phase 1 of the migration plan) — entries are grouped by what's
actually landed in git history plus what's currently uncommitted.

## [Unreleased]

### Changed (Process: NPS Score CSAT card, 2026-10-19)
- The CSAT vertical bar is replaced by a card next to the NPS tachometer: the value in its band colour, a status line
  ("Yellow · 0.48 pts below target 95" / "Green · on target"), "Satisfied x of y responders", and a full-width
  horizontal bullet bar 0-100 with red / yellow / green zones, the value bar, the target tick with its label always
  inside the card, and axis labels 0 / 85 / 95 / 100. Grey with "n = x" below the minimum responders; "—" with none.
  Bands unchanged (config/npsThresholds.ts).

### Changed (Process: NPS Score refreshes once a night, 2026-10-19)
- `process_nps` runs once a night as a full reload (ratings + WhatsApp messages): the last step of the 02:00
  `full_all`, under the same lock as sales and finance. Its own schedule (`ETL_SCHEDULE_PROCESS_NPS_CRON`, now
  `0 2 * * *`) is registered only when the full schedule is off, so it never runs twice. The Control Center shows which
  applies; the "NPS Score" run-now button stays.
- The page shows "Data refreshed: <last successful process_nps run, Tripoli time>".

### Added (Process: NPS Score WhatsApp reach goes live, 2026-10-19; runbook docs/nps-etl.md section 8)
- **Source profiled** (`profile_nps_source.py --reach-only`): `whatsapp_outbound_messages`, `create_date` in UTC,
  `updated_at` moves with the state, only failed messages before 2026-10-03.
- **Error groups agreed:** "Meta held back (131049/130472)", new "Customer opted out of marketing (131050)",
  `whatsapp_recoverable` / "retry" → Meta temporary, "Phone number missing or invalid" (fixable: add the number on the
  Odoo contact); 131047 stays in Other. Every real failure value is a test case. Migration 0051 (+ `down/`).
- **Messages that leave the source are never hidden:** raw `_deleted_at`, fact `deleted_in_source_at`, still counted;
  `warn:nps_reach_rows_disappeared` with the count.
- **Checks:** duplicate source id and more than 5 messages without a state FAIL; error in Other, no new message for
  3 days, other state and unknown company WARN; every result also in the `load_nps` details of `etl_task_log`.
- **Load mode:** the table is read in full every run (decided); when to switch to incremental is in the runbook.
- **Settings** (configuration only): `NPS_REACH_START=2026-10-03` and the test number in `NPS_REACH_EXCLUDED_NUMBERS`
  in every environment; added to the deploy `etl.env.example` files.
- **Page:** each reach box shows its share of Total Reach and a tooltip that reach uses the message date; "Reach data
  from 03 Oct 2026" (from the stored `reach_start`); Errors by reason shows # and %.
- **Reconciliation:** `check_nps_totals.py` adds fact = raw after filters and the weekly e-mail's LAST 7 DAYS
  delivered / read / sent / error per company; the backend read-only DB test checks the reach API per company and date.

### Added (Process: NPS Score data, step 1 -- ETL only, 2026-10-18; runbook docs/nps-etl.md)
- **Source:** the NPS developer's MySQL (`NPS_DB_NAME`, default `xtremech_nps_dashboard`), read only by the ETL through an
  SSH tunnel. The new generic source is `etl_platform/sources/mysql_ssh.py` (paramiko 3.5.1). It pins the host key,
  runs READ ONLY sessions with SELECT-only helpers, and retries network errors only. Its settings are `NPS_*` in
  `data/etl/.env`, and missing ones fail the job naming the variables.
- **ETL job `process_nps`** (after `core_dims`):
  - Raw `raw_nps_*` → `fact_process_nps_response` (one row per delivery rating) and `fact_process_nps_comment`
    (masked free text).
  - Every run reads the whole source, because the source is reloaded as a whole.
  - It is the last, optional step of `full_all`, so a failure never affects sales or finance. It also runs alone
    every 3 h (`ETL_SCHEDULE_PROCESS_NPS_CRON`) and from the ETL Control Center ("NPS Score").
  - `NPS_ENABLED=false` switches it off (recorded as skipped; new `JobSpec.disabled_reason`).
- **Measure:** the developer's 3-level answer (Exceeded / Met / Below expectations, exact Arabic text rule in
  `departments/process/nps.py`); NPS-style (3-level) = %Exceeded − %Below, from counts.
- **Company:** the matched sale order's, else the delivery's, else the source company name. The source `company_id`
  (a WhatsApp account) is never used. Dates are converted UTC → Africa/Tripoli.
- **Quality:** orphans, duplicate responses and levels outside 1..3 fail the run. An unmatched company or order,
  source rows that are not a rating, and no rating for 3 days warn.
- **Warehouse:** migration 0046 (+ down): raw, `dim_process_nps_level`, both facts, and the views
  `v_process_nps_response / _comment / _summary / _trend / _low_rating`.
- **Reconciliation:** `scripts/process/check_nps_totals.py` checks source vs warehouse and reproduces the weekly e-mail's
  counts per company and level.
- **Not yet:** the API, permissions and page (step 2).

### Changed (Receivables and Collections: "Credit Policy Escalation" replaces the Aging Map, 2026-10-15)
- **Placement:** each customer is placed by days past due of its unpaid invoice with the EARLIEST due date (as of the
  snapshot date), in the credit policy zones. Payment-term multiples (1x / 2x / 3x term, > 4.5x) are gone.
  - The zones are GREEN 0-15 (Sales Rep), YELLOW 16-30 (Sales Manager), RED 31-44 (Sales Director), CEO 45-60,
    CRITICAL 61-65 (Final Warning + Stop Supply) and LEGAL > 65 (CFO + GCEO).
  - They are defined once, in `backend/src/config/creditPolicy.ts`, and validated at load (no gaps or overlaps).
  - The due date is the unpaid instalment's own due date (Odoo `date_maturity`), else the invoice's `invoice_date_due`,
    else invoice date + term days.
- **Not yet due:** customers whose earliest due date is after the snapshot date are never day 0 / GREEN. They appear in
  a grey strip left of "Due Date (Day 0)" with a count and an amount, so the chart adds up to Total debt.
- **Layout:**
  - One dot per customer, sized by total outstanding (sqrt scale), linear by days inside each zone, without overlaps.
  - LEGAL packs its dots and shows the days inside the large ones.
  - A dashed ring marks a customer entering the next zone within 7 days.
  - Each zone header shows its range, owner, action and live "N customers · amount" in the page's currency.
- **Interaction:** hovering a dot shows its details (kept inside the viewport). Clicking opens the customer's open
  invoices through a new `customer_open` drill-down, which reconciles to the dot.
- **Payment term filter:** relabelled "Payment term (Filter)". It only chooses which customers are shown.
- **Customers table:** the "Aging bucket" column is the same zone, computed by the same backend code
  (`creditZone` on every row): zone + range, "Not yet due", or "—". It is sortable by age and filterable.
- **Removed:** the term-multiple Aging Map, its layout code and tests, the old zone tokens, and the table's previous
  oldest-overdue bucket. The `cfg_finance_aging_zone` / `cfg_finance_aging_setting` tables (migration 0037) are no
  longer read; they are not dropped. No migration.

### Changed (Roles: data scope rules with "is" / "is not" and several values, 2026-10-15)
- **Rule shape:** a data scope rule is now `[Dimension] [is | is not] [values]`, one rule per dimension.
  - "is" (`in`): users see ONLY the selected values.
  - "is not" (`not_in`): users see everything EXCEPT them.
  - Rules on different dimensions combine with AND, and a live summary says it in words
    (e.g. "Users with this role see: Company is not X · Branch is A or B").
- **Value picker:** searchable, with checkboxes, Select all / Clear, and chips ("+N more" after three).
  It offers every value, Unknown / Unassigned included. A rule needs at least one value.
- **Enforcement:** "is not" is resolved on the server on every request, against the dimension's current values.
  - A company added later is visible without editing the role, and Unassigned stays visible unless it is excluded.
  - Excluding everything shows nothing; it never falls back to "no restriction".
  - It is applied at the one scope choke point, so it reaches every report, chart, drill-down, filter list and the data
    behind exports. Asking for an excluded value is a 403.
- **API:** `PUT/DELETE /admin/roles/:id/data-scope/:dimension` with `{ operator, values }`, validated server-side
  (dimension, operator, at least one value, every value must exist). The old add/remove-by-row endpoints are gone.
  The picker loads its options from `GET /admin/roles/dimension-values/:dimension` (all data, never the admin's own
  scope) through `useDimensionValues`. It shows loading, a visible error with Retry, "No values available" and
  "No matches" (only for a non-empty search), and its search ignores case and Arabic letter variants.
- **Migration 0044:** `role_data_scope.operator`. Existing rules become "is", and several rows on one dimension merge
  into one rule. Behaviour is unchanged.

### Changed (Receivables and Collections: page-wide currency filter, 2026-10-15)
- The "Charts currency" toggle is gone. Default view = **All currencies (≈ LYD)**: Aging Map, every chart, both trends,
  drill-downs and the customer table add every currency up in LYD, using Odoo's own Amount Due at the rate booked on
  each invoice's date. That is the same basis as the header total, which keeps showing all currencies.
- Clicking a currency row of cards (a toggle button, `aria-pressed`) filters the whole page to that currency, in its own
  units. Click it again to go back to all currencies. The filter is kept in the URL as `?currency=USD`. The rows show a
  selected / dimmed / hover state, and a "Showing: …" line with a Clear link sits above the charts.
- Customer table: follows the page filter (its Currency dropdown was removed; the column stays). Exports name the
  currency. New **Aging bucket** column: the bucket of the oldest overdue invoice (Not due / — for credits only),
  shown as a coloured badge, sortable by real age and filterable.
- API: `overview.all`, `trend.all`, customer rows `lyd` + `oldestOverdueDays` / `oldestOverdueBucketKey`; drill-down
  without `currency` = every currency, with LYD totals; `aging` and `collections-*` accept `allCurrencies=true`. No migration.

### Fixed (live: legacy tables read because of table-name case, 2026-10-13)
- **DEPLOY NOTE: must be deployed together with `deploy/live-remap/02_remap.sql` — see `deploy/live-remap/README.md`.**
- Live MySQL runs with `lower_case_table_names=0`, so `Dim_Company` and `dim_company` are two tables there. Migration 0029
  renamed the legacy tables by their lowercase name only, so on live they stayed, and the backend (capitalised names)
  kept reading the stale legacy `Dim_Company`, `Dim_Customer`, `Dim_Date`, `Dim_Salesperson`, `Dim_Segment`. Symptom: the
  Company "ETL Relation" dropdown on live listed only 1 Majaal, 2 Tika (no Athena).
- Every backend query now uses the lowercase core tables (18 files). The ETL Relation dropdown no longer offers `-1 Unknown`.
- New guard test `backend/src/db/__tests__/tableNameCase.test.ts` (runs in CI): fails on any capitalised table name in backend SQL.
- `deploy/live-remap/`: read-only checks, backup, a by-name remap of stored legacy keys (Tika 2 → 3, segment Unknown 5 → -1)
  with audit/rollback, and post-deploy verification, for DevOps to run by hand. No migration; legacy tables untouched.

### Changed (UX enhancements, 2026-09)
- Bottom page navigator scrolls horizontally (wheel/drag/touch, edge arrows + fades, active tab scrolled into view, RTL-aware).
- Back button moved into the header; header Refresh and filter-bar Reset Filters removed.
- Filter Bar is now fully cross-filtered: new `GET /filters/options` (all seven filters, any direction, multi-select, auto-deselect of invalid values); Branch and Customer enabled. Customer filter (`customerKeys`) applies to sales-line KPIs and is offered on Invoices Engine / Customer Growth only.
- ETL: enqueue is race-safe (cross-process lock); a failed attempt that BullMQ will retry keeps the lock; scheduled ticks skip while a run is active; `POST /admin/etl/retry`; `/admin/etl/status` returns `lastRun`; optional `ETL_SCHEDULE_TIMEZONE`; dashboards and filter options reload after an ETL run finishes.

### Fixed (ETL input files, 2026-09)
- ETL failed at step one in Docker: `data/etl/.env` pointed `INPUT_DIR` at a Windows path that cannot exist in the Linux `etl-api` container. Input/output directories are now `ETL_INPUT_DIR`/`ETL_OUTPUT_DIR` (legacy names still read), resolved with `pathlib` against `data/etl/`, default `data/etl/input`. `docker-compose.yml` mounts `ETL_INPUT_HOST_DIR` read-only at `/etl/input`; a `C:/...` value on Linux now fails fast with the fix.
- Input validation runs first and explains itself (resolved path, per-file status, case-insensitive near matches, directory listing, corrupt/unreadable `.xlsx`, likely cause). `ProductNameMapper` no longer reports "ready" with 0 mappings for a missing/unreadable `PRODUCTS.xlsx`; it raises.
- `GET /etl/preflight` (ETL API) and `GET /admin/etl/preflight`; the ETL panel shows the check, disables Run when inputs are bad, and a failed run shows the real error plus its last log lines. Pipeline log timestamps carry their UTC offset (Libya time); the log panel no longer adds a second, unlabelled clock.
- `.dockerignore` excludes ETL input/output data from the image build context.

### Removed
- Export Overview Report (`/reports/overview`, report* services, `puppeteer-core`, Chromium in the backend image).

### Added
- ETL Flask API (`data/etl/api/`) — wraps the real pipeline (`data/etl/src/sales_pipeline`) as an
  HTTP service, so the ETL can run in its own container/process without the API/worker needing
  Python installed directly.
- `docker/nginx.conf` — VPS reverse proxy config with subdomain-based routing (frontend on the main
  domain, backend on a dedicated `api.` subdomain) and TLS via Let's Encrypt.
- `data/etl/Dockerfile.api`, `docs/vps-deployment.md`, `scripts/health-check.sh`.
- `CONTRIBUTING.md`, `TROUBLESHOOTING.md`, this changelog.

### Changed
- `backend/src/etl/services/pythonRunner.ts` rewritten: calls the ETL Flask API over HTTP and polls
  it to completion, instead of spawning `python -m sales_pipeline.main` as a direct subprocess.
  Same external contract (`PipelineRunOptions`/`PipelineRunResult`) — nothing above it
  (`runPipelineJob.ts`, the BullMQ worker, `admin/etlControl.ts`, the frontend ETL Runs page)
  changed.
- `backend/Dockerfile.etl-worker` simplified — no longer installs Python/venv, since it no longer
  spawns the pipeline itself.
- `docker-compose.yml` updated: new `etl-api` service, explicit `REDIS_HOST`/`ETL_API_URL`
  overrides so local-dev `.env` defaults don't silently break under Docker, and a build-arg fix so
  `NEXT_PUBLIC_API_BASE_URL` is actually inlined into the frontend bundle at build time.
- Fixed a pre-existing bug where `data/ingestion/input_sheets/settings_factory.py` imported
  `config.settings` when the module was actually at `config_src.settings` (and the vendored
  pipeline package itself had the same issue internally) — `orchestrator.py` couldn't be imported
  at all before this fix.
- Repo cleanup: archived ~17 internal planning/prompt documents that had accumulated at the repo
  root (and one stale pre-MySQL-migration status report) into `docs/archive/`, alongside the
  ~25 already there from the prior release-audit pass.

## Recorded in git history

### `8fc0573` — Revenue - Critical Number
Critical Number, Revenue Trend, Invoices Engine, and Customer Growth dashboard pages implemented
and wired to their backend routes (frontend + `backend/src/routes/`, `backend/src/measures/`).

### `404b543` — Apply final release-audit fixes
Untracked a build artifact, removed a dead env template, documented the DB migration and ETL venv
setup as part of preparing the repo for its initial public state.

### `ee5623a` — Initial commit
07PREPORT sales dashboard, ETL pipeline, and docs — Phase 1 foundation: Tachometer dashboard,
MySQL warehouse (star schema), JWT auth with role/company/salesperson scoping, the vendored Python
ETL pipeline, and BullMQ-based scheduling.
