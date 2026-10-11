# Deploy notes: ETL schedules, Receivables and Collections, Odoo-matched exclusions

On `main` (commit 13c4d67 and later). This release carries the per-currency report, the Aging Map, Athena, the
Collections trend and the 2026-10-11 exclusions (migrations 0024, 0036-0042). Paths are relative to `07ps-sales-dashboard-app/`. All times are **Africa/Tripoli**.

## What changes, in short

- **Schedules (three runs):**

  | When | ETL job | Steps | Also started by |
  |---|---|---|---|
  | every 3 h | `main` | reference data (core_dims) → sales incremental. **No finance.** | "Sales Refresh", `npm run etl:incremental` |
  | 02:00 | `full_all` | reference data → receivables snapshot → sales full rebuild | "Full Refresh", `npm run etl:full` |
  | 15:00 | `finance_receivables` | reference data (reused if it ran in the last 3 h) → receivables snapshot | "Receivables Snapshot" |

  - Each run is one top-level row in `etl_run_log`. Its steps point to it through `parent_run_uid`, and the Control
    Center history shows them as "Steps".
  - **Failures:**
    - Reference data fails → the other steps are `skipped` and the run is `failed`.
    - Finance fails inside `full_all` → sales still runs and keeps its data, the run is `partial` ("finance failed: …"),
      and the 15:00 run retries.
  - **No overlap:** a run holds the ETL lock (MySQL `GET_LOCK('sales_pipeline_full_load')`).
    - A scheduled tick that lands while a run is active is dropped.
    - A button click gets "already running" (HTTP 409).
    - A CLI or API start gives up after 30 s with exit code 4, recorded as `skipped`.
  - **Snapshots:** each finance run replaces today's snapshot in one transaction and keeps earlier days. Two runs a day
    never duplicate rows.
- **The Debt Report is renamed "Receivables and Collections":**
  - Menu, page title, bottom navigation, Roles page label, Control Center texts, export file names, docs.
  - New URL `/Dashboard/price/receivables-collections`. The old `/Dashboard/price/debt-report` redirects to it, so old
    links keep working.
  - Kept unchanged, so no grant, table or API client breaks: the permission key `debt_report`, the API `/debt-report/*`,
    and the tables and views (`fact_finance_*`, `v_finance_*`, `cfg_finance_report_exclusion`).
  - The Roles page label is written from code at every backend start, so the rename needs no migration.
- **Filters:** every filter is a dropdown, worded as on the other pages.
  - Company (multi-select: every company of the snapshot, incl. Athena), Branch (the sales team), Salesperson, Customer (searchable).
  - Overdue status All / Overdue / Not yet due.
  - Customer Category: the Customer Growth categories A–D (dim_customer.CustomerClass_LY).
  - Include (other receivable entries / inter-company), Odoo labels.
  - The Document type filter and the old customer-size tiers are gone.
- **Exclusions = the finance team's Odoo filter** (migration 0039, reconciled invoice by invoice):
  - Teams left out: Odoo team 8 مبيعات الادارة المالية, team 23 مبيعات BMH, team 27 EXPORT.
  - Invoices with no Sales Team are left out too. This rule applies to invoices only: credit notes and unapplied
    payments without a team stay in the Net balance.
  - Removed, because they changed no number: the segments Backoffice and Inter Company, and the team name SALES.
- **EXPORT (Odoo team 27) is a team of its own:**
  - The OdooTeams sheet says "follows salesperson" for it. Sales still uses the salesperson's team.
  - Receivables now keep the document's own team: a sales team member `ODOO-TEAM-27` named "EXPORT", created by the
    finance ETL from the Odoo team. Before, it was "Unknown".
- **The cards count posted invoices with an amount due**, i.e. Odoo's Invoices list with Unpaid + **Posted**. Draft
  invoices are not counted: they are not receivables.

## 1. Environment variables

### ETL service: `data/etl/.env` (container `etl-api`)

| Variable | Required | Example (production values) | Meaning |
|---|---|---|---|
| `ODOO_PROD_DB` | yes | `odoo-ps-majaal-main-3380005` | Production guard: the ETL refuses to run unless `ODOO_DB` equals this |
| `ODOO_ALLOWED_HOSTS` | yes | `majaal.odoo.com` | Production guard: the host of `ODOO_URL` must be in this list |
| `ODOO_COMPANY_IDS` | yes | `1,3` | The Odoo companies read (Majaal, Tika) |
| `ODOO_COMPANY_NAMES` | yes (2026-10-11) | `Athena` | Companies added by name (Athena = Odoo company 9); the Odoo user must have access to them |
| `FINANCE_INTERCOMPANY_PARTNER_IDS` | yes | `15905,15907` | Partners whose receivables are inter-company balances |
| `ETL_LOCK_TIMEOUT_SECONDS` | no | `30` (default) | How long a second trigger waits for the lock before it is skipped |
| `ETL_CORE_DIMS_FRESH_MINUTES` | no | `180` (default) | Reference data is reused instead of re-read when it succeeded this recently |

### Backend: `backend/.env` (containers `backend` and `etl-worker`)

| Variable | Value (production) | Change |
|---|---|---|
| `ETL_SCHEDULE_INCREMENTAL_CRON` | `0 */3 * * *` | unchanged; now runs `main` (no finance) |
| `ETL_SCHEDULE_FULL_CRON` | `0 2 * * *` | unchanged; runs `full_all` (with finance) |
| `ETL_SCHEDULE_FINANCE_CRON` | `0 15 * * *` | **set it** (it was 06:30 before; the code default is now `0 15 * * *`) |
| `ETL_SCHEDULE_FINANCE_ENABLED` | `true` | keep / set |
| `ETL_SCHEDULE_INCREMENTAL_ENABLED`, `ETL_SCHEDULE_FULL_ENABLED` | `true` | unchanged |
| `ETL_SCHEDULE_TIMEZONE` | `Africa/Tripoli` | unchanged. If unset, the crons now use `APP_TIMEZONE` (default Africa/Tripoli), never the container's UTC |

The frontend has no environment change.

## 2. Database migrations (in this order, before the new containers start)

Back up first (`scripts/backup_db.sh`, or `mysqldump --single-transaction --routines --triggers <db>`). Use an account
that may `CREATE TABLE` / `ALTER TABLE` / `CREATE VIEW`, not the app or ETL account.

| # | File | What it does |
|---|---|---|
| 0 | `data/warehouse/migrations/0024_salesperson_target_seasonality.sql` | per-salesperson monthly shares of a target override; **the Tachometer reads it** |
| 1 | `data/warehouse/migrations/0036_finance_receivable_currency_exclusions.sql` | exclusion table `cfg_finance_report_exclusion`, per-currency views |
| 2 | `data/warehouse/migrations/0037_finance_debt_aging.sql` | Aging Map settings (`cfg_finance_aging_*`, `cfg_finance_payment_term_days`) |
| 3 | `data/warehouse/migrations/0038_etl_job_runs_partial_skipped.sql` | run statuses `partial` / `skipped` in `etl_job_runs.status` |
| 4 | `data/warehouse/migrations/0039_finance_report_exclusion_odoo_teams.sql` | the Odoo-matched exclusion list, rule type `invoice_team`, the views honouring it |
| 5 | `data/warehouse/migrations/0040_finance_collections.sql` | `raw_odoo_customer_payment`, `fact_finance_collection` (Collections trend) |
| 6 | `data/warehouse/migrations/0041_finance_report_exclusion_segments.sql` | exclusions = segments Backoffice + Inter Company only (2026-10-11); EXPORT and no-team invoices back in |
| 7 | `data/warehouse/migrations/0042_finance_collection_split.sql` | collection split columns, `fact_finance_collection_invoice`, `v_finance_collection_trend` |

```bash
cd 07ps-sales-dashboard-app
set -a; . /path/to/migration.env; set +a      # DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
python3 data/warehouse/apply_migrations.py \
  0024_salesperson_target_seasonality.sql \
  0036_finance_receivable_currency_exclusions.sql 0037_finance_debt_aging.sql \
  0038_etl_job_runs_partial_skipped.sql 0039_finance_report_exclusion_odoo_teams.sql \
  0040_finance_collections.sql 0041_finance_report_exclusion_segments.sql 0042_finance_collection_split.sql
```

(`scripts/deploy.sh` does the same with `MIGRATIONS="0024_… 0036_… … 0042_…"` and `MIGRATION_ENV_FILE`.)

- **0038 before the new worker:** otherwise recording a partial or skipped run fails, and the run stays "running" in
  the Control Center until the stale-run sweep (6 h).
- **0039 before the new backend:** the new API reads the `invoices_only` column it adds.
- **0024 before the new backend:** the Tachometer's target-override months read `salesperson_target_seasonality`.
- **0040 + 0042 before the new ETL image:** the finance job now also loads collections; without the tables that step
  fails (the receivables snapshot is already committed, the run ends `partial`) and the Collections chart shows an error.
- **First finance run after 0040/0042** reads the whole customer payment history from Odoo (read-only, ~70,000 payments,
  7-15 min); later runs are incremental. To rebuild: empty `raw_odoo_customer_payment` and run `finance_receivables`.
- Skip any migration already applied on the server (no migration ledger: apply by file name only).
- 0039 needs MySQL 8.0.16 or later (CHECK constraints). It is idempotent, and its rollback was tested on a copy of the
  data.

The exclusion list after **0041** (`SELECT rule_type, name FROM cfg_finance_report_exclusion`): `segment` Backoffice and
`segment` Inter Company only (decision 2026-10-11). For reference, the list 0039 had set (replaced by 0041):

| rule_type | name | Odoo team |
|---|---|---|
| sales_team | مبيعات الادارة المالية | 8 (BMH-ALL-02) |
| sales_team | مبيعات BMH | 23 (BMH-ALL-00) |
| sales_team | EXPORT | 27 (ODOO-TEAM-27) |
| invoice_team | Unknown | invoices without a Sales Team (-1); their credits and payments stay |

## 3. Images and containers

Rebuild **all** images: Python (ETL, `Dockerfile.api` with `PYTHONPATH`), TypeScript (backend, worker) and the
frontend (route rename, redirect in `next.config.mjs`).

```bash
cd 07ps-sales-dashboard-app
docker compose build
docker compose up -d --remove-orphans
```

Use **`up -d`, not `restart`**. Docker reads `env_file` only when a container is created, so `restart` keeps the old
environment (for example the old finance cron). `scripts/deploy.sh deploy <tag>` does build + `up -d` for you. Its
smoke check (`--run-etl`) starts one `main` run (about 20 min; no finance).

After the first deploy, run **Full Refresh** or **Receivables Snapshot** once. That run creates the EXPORT team member
(ODOO-TEAM-27) and moves the EXPORT invoices onto it. Until then they stay on "Unknown", which the 0039 invoice rule
also leaves out, so the numbers are right either way.

## 4. How to check it worked

1. **Control Center → Scheduler Settings** shows three schedules: Incremental `0 */3 * * *`, Full `0 2 * * *`,
   Receivables Snapshot `0 15 * * *`, read in Africa/Tripoli time. "Next Scheduled Run" lists all three.
2. Run **Receivables Snapshot**, then check `etl_run_log` (the run and its steps):

   ```sql
   SELECT run_id, job_name, status, parent_run_uid, started_at_utc, duration_seconds, LEFT(error_message, 200)
     FROM etl_run_log ORDER BY run_id DESC LIMIT 6;
   SELECT SnapshotDateKey, COUNT(*) FROM fact_finance_receivable_snapshot GROUP BY SnapshotDateKey ORDER BY 1 DESC LIMIT 5;
   SELECT SalesTeamKey, SalesTeam FROM dim_sales_team WHERE SalesTeamKey LIKE 'ODOO-TEAM-%';   -- ODOO-TEAM-27 EXPORT
   ```

3. **Receivables and Collections** (Price menu):
   - The page loads at the new URL, and the old URL redirects to it.
   - "Finance refresh" shows that run's time.
   - The strip lists the exclusions: teams مبيعات BMH, مبيعات الادارة المالية, EXPORT, and invoices without an Odoo
     sales team.
4. **Reconcile with Odoo** right after the finance run, from a checkout with Node and access to the database and Odoo:

   ```bash
   cd 07ps-sales-dashboard-app/backend
   npm run reconcile:odoo
   ```

   - Expect `MATCH` (exit code 0). An invoice paid or posted in Odoo between the snapshot and the script shows as
     "timing" and still exits 0.
   - The script also prints the draft invoices per team, for accounting to clean up.
   - The Odoo-side comparison is Customers › Invoices with **Unpaid + Posted**, both companies, and Sales Team = every
     team except 8, 23, 27.
5. At 15:00 the next day: a new `finance_receivables` row, a new snapshot date, and no duplicate rows for the day.

## 5. How to roll back

1. Redeploy the previous image tag: `scripts/deploy.sh rollback`, or check out the previous commit, then
   `docker compose build && docker compose up -d`.
2. Database, newest first and only what you undo:
   - **0039** → `data/warehouse/down/0039_finance_report_exclusion_odoo_teams_down.sql`. It restores the 0036 list
     (segments Backoffice and Inter Company, teams مبيعات BMH, مبيعات الادارة المالية, SALES), its rule types and its
     views. The `ODOO-TEAM-27` member stays in `dim_sales_team`, which is harmless.
   - **0038** → `down/0038_etl_job_runs_partial_skipped_down.sql`. Apply it **after** the old images run. It turns
     `partial` rows into `success` and `skipped` into `failed`.
   - **0037 / 0036** only if the whole report release is rolled back: `down/0037_…_down.sql`, then `down/0036_…_down.sql`.
3. The old code had the finance schedule at `ETL_SCHEDULE_FINANCE_CRON=30 6 * * *`. Set that back if you roll back,
   and recreate the backend and worker with `up -d`.
4. Snapshot rows and `etl_run_log` rows written by the new code are valid for the old code and need no cleanup.
