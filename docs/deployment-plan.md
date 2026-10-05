# Deployment plan (Phase 8): ETL platform rebuild + Debt Report, one window

Status 2026-10-05, after Phase 7. Every step that writes to git, the server, the containers or Odoo configuration is
**yours to run**. Nothing here has been done yet, except where section 0 says so.

## 0. Where things stand

### 0.1 Code: `07PREPORT` is the home of all work

| Folder | Git state | Role |
|---|---|---|
| `C:/Users/Lenovo/Desktop/07PREPORT` | branch **`main`** at `f67644d` (= `origin/main`), with **every Phase 1–7 change uncommitted** | where you review and commit |
| `C:/Users/Lenovo/Desktop/07PREPORT-ppl` | **detached HEAD at `f67644d`**, clean | production: `scripts/deploy.sh` builds the images from this folder |
| `C:/Users/Lenovo/Desktop/07PREPORT-etl` | branch `feature/debt-receivables-etl` at `aa48123`, uncommitted | read-only backup of Phases 1–6; remove after Phase 7 approval |

`07PREPORT-ppl` was switched to a detached HEAD on 2026-10-04 (same commit, nothing else changed) so that `main` could be
checked out in `07PREPORT`. Git allows a branch in one worktree only. Production therefore follows **commits**, not a
branch: Phase 8 moves its detached HEAD to the commit you make in `07PREPORT` (section 2).

Your own uncommitted work in `07PREPORT` stays out of the deploy unless you commit it: `.claude/launch.json`, the
seasonality import in `tachometer.ts`, `lib/seasonality.ts`, and **migration 0024 (never apply it)**.

### 0.2 Warehouse `powerBI_Data` (production, host MySQL)

| Migration | Applied | Content |
|---|---|---|
| 0028 | 2026-10-01 | `etl_*` run metadata |
| 0029 | 2026-10-01 | core dimensions |
| 0030 | 2026-10-04 | Odoo team map |
| 0031 | 2026-10-04 | sales marts and `v_sales_*` views |
| 0032 | 2026-10-04 | Odoo selection labels |
| 0033 | 2026-10-04 | finance receivables |
| **0034** | **2026-10-04 (Phase 7)** | `receivable_scope`, `dim_finance_receivable_scope`, `v_finance_receivable_line`, default views = customer debt; Debt Report page grants |
| 0035 | **not applied** (`migrations/manual/`, renumbered from 0034) | retire the legacy tables, after the observation period |

- **Last loads:**
  - `core_dims`: 2026-10-04 17:01 UTC;
  - `sales_full`: 2026-10-04 11:26 UTC (regression approved);
  - `finance_receivables`: 2026-10-04 22:49 local (Phase 7 re-flag, with `FINANCE_INTERCOMPANY_PARTNER_IDS=15905,15907`).
- **Legacy tables** are `zz_legacy_*` (34), kept until 0035.

### 0.3 Inputs

`07PREPORT/Input` holds the Phase 1–6 key columns and sheets since 2026-10-04 (Phase 7 transfer):

- `BlockedCustomers.xlsx`, `OffDays.xlsx` and `PRODUCTS.xlsx` are the staging versions; production had not changed
  them since the staging copy.
- `SalesTeam.xlsx` and `sales_targets.xlsx` are **your Oct 4 versions plus only the key columns and sheets**. Details
  are in the Phase 7 report §1.
- Production's compose mounts this folder read-only (`ETL_INPUT_HOST_DIR`), so **no input copy is needed in Phase 8**.
  The staging folder `C:/Users/Lenovo/etl-staging-input/` is no longer used.

### 0.4 Running stack

- `etl-worker` and `etl-api` are **stopped**; the ETL schedules are paused. **Do not start the old images:** the old
  ETL would recreate the legacy tables.
- The backend and frontend containers run the **old code**, which reads the old table names, so their sales pages
  error until this deploy.

## 1. Open decisions (none blocks the deploy)

| Item | Where |
|---|---|
| Aged Receivable comparison for 2026-10-04 (A3) | waiting for your exports; `scripts/finance/compare_aged_receivable.py` |
| Two more inter-company partners: 9651 مديونية شركة اثينا, 16388 مديونية اثينا (Athena) | Phase 7 report §2 |
| Live screenshots of a salesperson **with** the Debt Report enabled | Phase 7 report §6 (needs a temporary grant) |
| Second Odoo accounts, `OdooTeams` gaps, blocked-customer mapping | the review CSVs in `docs/` |
| Debt bot user (`ODOO_DEBT_*`) | `receivables-etl.md` §3 |

## 2. The window

Run the steps in order; each has a check. The checklist (section 4) is the same steps, one line each.

### Step 1. Commit (you, in `07PREPORT`)

1. Review `git status` / `git diff --stat`. All untracked files under `07ps-sales-dashboard-app/`, `docs/` and
   `.claude/settings.local.json` are yours to judge; the change set is in the latest
   `~/etl-rebuild-backups/*_phase7*` patch + tarball.
2. Leave out your own WIP (section 0.1) and the local `.env` files (git-ignored).
3. Commit on `main` (one commit, or one per phase), then push when you're ready. Note the commit id: `<C>`.
4. **Tests before deploying:** ETL `pytest` (only `test_input_check::test_wrong_case_file_name_gets_a_near_match_hint`
   fails, pre-existing), backend `npm test` + `tsc`, frontend `tsc` + `next build`.

### Step 2. Back up

1. **Database:** `scripts/backup_db.sh`, or `mysqldump --single-transaction powerBI_Data`.
2. **Input:** copy `07PREPORT/Input` with a date suffix.
3. **Code:** note the current production commit: `git -C ../07PREPORT-ppl rev-parse HEAD` (expected `f67644d`).

### Step 3. Move production to the new commit

```bash
git -C C:/Users/Lenovo/Desktop/07PREPORT-ppl switch --detach <C>
```

- `07PREPORT-ppl` is clean, so this only changes the checked-out files.
- Its untracked local files (`.env`, `backend/.env`, `data/etl/.env`) are kept.

### Step 4. Configuration (production `.env` files in `07PREPORT-ppl/07ps-sales-dashboard-app`)

**`data/etl/.env`** (etl-api). Examples: `data/etl/.env.example`, `deploy/config/production/etl.env.example`.

| Variable | Value |
|---|---|
| `ODOO_PROD_DB` | the production database name (`ODOO_DB` must equal it) |
| `ODOO_ALLOWED_HOSTS` | `majaal.odoo.com` |
| `ODOO_COMPANY_IDS` | `1,3` |
| **`FINANCE_INTERCOMPANY_PARTNER_IDS`** | **`15905,15907`** (add `9651,16388` if you approve the Athena partners) |
| `ETL_CORE_DIMS_FRESH_MINUTES` | `180` |
| `ETL_INCREMENTAL_OVERLAP_SECONDS` | `300` |
| `ETL_ODOO_PAGE_SIZE` | `2000` |
| `ODOO_DEBT_LOGIN` / `ODOO_DEBT_API_KEY` / `ODOO_DEBT_KEY_EXPIRES` | **leave commented out** until the bot user exists; the job then uses the default credentials and warns |

**`backend/.env`** (backend + etl-worker):

| Variable | Value |
|---|---|
| `ETL_SCHEDULE_FINANCE_CRON` | `30 6 * * *` |
| `ETL_SCHEDULE_TIMEZONE` | `Africa/Tripoli` |
| `ETL_SCHEDULE_INCREMENTAL_ENABLED` / `_FULL_ENABLED` / `_FINANCE_ENABLED` | **`false`** until step 8 |
| `ODOO_WEB_BASE_URL` (optional) | base of the Debt Report's "open in Odoo" links; defaults to `ODOO_URL` |
| `FINANCE_TIER_LARGE_MIN` / `FINANCE_TIER_MEDIUM_MIN` (optional) | size tiers, default `100000` / `10000` |

### Step 5. Database

- **Production needs nothing:** it is at 0034.
- **Another database** (staging copy, or a restore of the pre-rebuild dump): apply **0028 → 0034 in order** with an
  account that may CREATE/ALTER, using `python data/warehouse/apply_migrations.py <file>` per file.
  - 0029 and 0031 rename the legacy tables and abort on an unexpected state.
  - 0034 is idempotent; its down script is `down/0034_finance_receivable_scope_down.sql` (verified down + re-apply on
    production).
- **Never apply** `migrations/manual/0035_retire_legacy.sql` here (step 9), nor `0024_salesperson_target_seasonality.sql`.

### Step 6. Rebuild and start

From `07PREPORT-ppl/07ps-sales-dashboard-app`, with the schedules disabled:

```bash
scripts/deploy.sh deploy <tag>
```

- It backs up the database, runs `docker compose build`, starts the stack and runs `post_deploy_check.py`.
  - The smoke check starts an "incremental" run, which is now the platform job `sales_incremental` (about 20–25
    minutes; the check waits up to 60).
- **The images must be rebuilt, not reused:**
  - `etl-api`: `Dockerfile.api` runs `pip install -e .`, which puts `etl_platform`, `core` and `departments` on the path.
  - backend: the registry sync at startup adds the `debt_report` page; the grants already exist from 0034.
- **Single writer:** `Get-NetTCPConnection -RemotePort 3306` shows only the Docker backend; the legacy Windows tasks stay
  disabled.

### Step 7. First runs (Admin → ETL Control Center) and page smoke tests

1. **Full Refresh** (`full_all` = `core_dims` + `sales_full`).
   - `etl_run_log`: both succeed.
   - `etl_dq_result`: every `orphan:*` passes.
   - `GET /meta/freshness?department=sales` shows the new run.
   - This is the first `core_dims` run on your **Oct 4 workbooks**:
     - Saleh Alabeedi, Mohamed Ramadan and Mohammed Alabed are active with teams;
     - "Sales Person 2" is no longer in the org file.

     Check the fallback counts in `etl_task_log`.
2. **Receivables Snapshot** (`finance_receivables`).
   - Today's snapshot exists.
   - The run details show `intercompany_partner_ids_configured: [15905, 15907]`.
   - The WARNING about the default credentials is expected.
   - `GET /meta/freshness?department=finance` shows the run.
3. **Totals:** `python scripts/finance/check_receivable_totals.py` (inside the etl-api container, or locally with the
   production `.env`) must print `MATCH`.
4. **Pages, as admin:**
   - Price → Debt Report loads: 7 KPIs, 5 charts, the exposure table.
   - A customer click opens the documents, and the Odoo link opens the record.
   - Both toggles on → open debt = the `check_receivable_totals.py` total.
   - Odoo labels → العربية switches the document / delivery labels.
5. **Pages, as GCFO / B2B Director / a salesperson:**
   - GCFO and B2B Director see the page; B2B Director sees segment B2B only.
   - A salesperson does not see Price → Debt Report and gets 403 on `/debt-report/*`.
6. **The other pages:** the sales pages answer; footers show their own department's refresh.
7. **Automated check (optional):** `DEBT_TEST_DB=1 npx vitest run -c vitest.debt-db.config.ts` with the production
   `DB_*`. It is read-only, takes about 40 s, and compares every endpoint with the views.

### Step 8. Enable the schedules, then observe for 7 days

1. Set the three `ETL_SCHEDULE_*_ENABLED` to `true` and restart the backend. The Control Center scheduler panel shows
   the incremental, full and finance (06:30) schedules.
2. **Each day for 7 days:**
   - `etl_run_log` has no failed run;
   - `etl_dq_result` has no `fail`;
   - from the second snapshot on, the finance sanity checks pass, the Debt Report trend shows two points, and
     "Change in overdue (7d)" fills in from 2026-10-11 (if the first snapshot after deploy is today's);
   - the receivables recount in `etl_task_log.details.recount` is small or zero;
   - `check_receivable_totals.py` says `MATCH` right after the 06:30 run.

### Step 9. Retire the legacy tables: 0035 (after the 7 days and your approval)

Apply `data/warehouse/migrations/manual/0035_retire_legacy.sql` deliberately with the MySQL client; the runner cannot
apply it. It drops:

- the `zz_legacy_*` tables;
- `pipeline_load_metadata`, `pipeline_run_audit` and `pipeline_run_log`;
- the `qa_*` tables;
- the four `_tmp_keys_*` tables.

**Irreversible.** Keep the 2026-10-01 dump and the step 2 backup.

## 3. Rollback

**Code only** (the page or ETL misbehaves, the data is fine), before step 9:

```bash
git -C C:/Users/Lenovo/Desktop/07PREPORT-ppl switch --detach f67644d
```

Then run `scripts/deploy.sh rollback <previous tag>` (or `deploy` again from `f67644d`), and keep `etl-worker` /
`etl-api` **stopped**. The old code reads the old table names, so the sales pages stay broken until a full restore.

**Debt Report only:** apply `down/0034_finance_receivable_scope_down.sql`. It removes the grants, the scope column and
the line view, and restores the 0033 views; the rest of the platform keeps running.

**Full rollback** (before step 9):

1. Switch `07PREPORT-ppl` back to `f67644d` and roll the images back (above).
2. Restore the pre-rebuild dump `powerbi_data_before_rebuild_20261001-1404.sql` (`rename-map.md` §9: drop and recreate
   the database, then load). This loses the new tables and the finance snapshot history.
3. Restore the step 2 Input backup if the old ETL must read the old workbooks. The extra key columns and sheets are
   harmless to it, but the 2026-10-01 originals are in `~/etl-rebuild-backups/excel/original_2026-10-01/`.
4. Let the legacy full refresh reload the Odoo data since 2026-10-01.

**After step 9:** rollback is the dump restore only.

## 4. Checklist (line by line)

```
[ ] 1  07PREPORT: review git diff, leave out WIP (0024, seasonality, launch.json), commit on main -> <C>
[ ] 1  tests: ETL pytest (1 known failure), backend npm test + tsc, frontend tsc + next build
[ ] 2  backup: powerBI_Data dump, Input copy, note 07PREPORT-ppl HEAD (f67644d)
[ ] 3  git -C ../07PREPORT-ppl switch --detach <C>
[ ] 4  07PREPORT-ppl data/etl/.env: ODOO_PROD_DB, ODOO_ALLOWED_HOSTS, ODOO_COMPANY_IDS=1,3, FINANCE_INTERCOMPANY_PARTNER_IDS=15905,15907
[ ] 4  07PREPORT-ppl backend/.env: ETL_SCHEDULE_FINANCE_CRON=30 6 * * *, all ETL_SCHEDULE_*_ENABLED=false
[ ] 5  database: production already at 0034 - nothing to apply (never 0024, never 0035 now)
[ ] 6  scripts/deploy.sh deploy <tag> (rebuilds images); smoke check passes
[ ] 6  Get-NetTCPConnection -RemotePort 3306: only the Docker stack
[ ] 7  Control Center: Full Refresh -> success, DQ orphans pass, sales freshness updated
[ ] 7  Control Center: Receivables Snapshot -> success, inter-company ids [15905, 15907] in details
[ ] 7  check_receivable_totals.py -> MATCH
[ ] 7  admin: Price -> Debt Report, KPIs/charts/table/drill-down/Odoo link, toggles total = Odoo, Arabic labels
[ ] 7  GCFO + B2B Director see the page (B2B: segment B2B); salesperson: no page, 403 on /debt-report
[ ] 7  sales pages answer; each footer shows its own department's refresh
[ ] 8  ETL_SCHEDULE_*_ENABLED=true, restart backend, scheduler panel shows 3 schedules
[ ] 8  days 1-7: no failed run, no DQ fail, finance sanity passes, recount ~0, totals MATCH
[ ] 9  after approval: mysql < migrations/manual/0035_retire_legacy.sql
[ ] -  after Phase 7 approval: remove worktree 07PREPORT-etl; git branch -d feature/debt-receivables-etl
```

## After go-live (follow-ups)

- **Sales extraction.** True write-date incremental extraction; today `sales_incremental` re-extracts in full, about
  20 minutes per run.
- **Sales labels.** Move the remaining code-written sales labels to `dim_odoo_selection_label` (agree the wording
  with the page owners).
- **Debt bot user.** Create it, set `ODOO_DEBT_*`, and check that partner 3575 becomes readable.
- **Credit limits.** Odoo has no partner with a credit limit above 0 in either company, so the "over credit limit"
  KPI reads 0 until finance sets limits in Odoo.
