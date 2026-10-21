# ETL refresh schedule (30-minute refresh)

Status: **Phase A** (2026-10-20, branch `feature/etl-30min-refresh`). Shared lists, Receivables + Collections and
NPS refresh every 30 minutes. Sales keeps its five daily slots until Phase B (true `write_date` incremental for
sales) is merged.

## 1. What runs, where, when

Everything runs on the **production server only** (Docker Compose stack: `backend` with node-cron, `etl-worker`
with BullMQ, `redis`, `etl-api` running `python -m etl_platform.run`; MySQL is the server's own instance, reached on
`DB_HOST_FOR_CONTAINERS`). Two switches, both default **false**, are set to `true` only in the server's
`backend/.env`:

| Variable | Off (default, every laptop / test copy) | On (production server) |
|---|---|---|
| `ETL_SCHEDULER_ENABLED` | the API registers **no** cron schedule | registers the schedules below |
| `ETL_WORKER_ENABLED` | `etl-worker` stays up idle and never consumes the queue | runs queued jobs, one at a time |

**Fail-safe.** A production build (`NODE_ENV=production`) with either switch off logs an error at startup ("No ETL
schedule is running on this server: ...", in the backend and the etl-worker logs) and the ETL Control Center shows a red
banner with the missing line(s). A laptop or staging copy that runs no ETL on purpose sets `ETL_SCHEDULER_OFF_OK=true`
to silence it; the server never sets it, so a forgotten line can never stop the 02:00 full refresh silently.

Schedules (Africa/Tripoli):

| Schedule | Job | Modules | When |
|---|---|---|---|
| 30-minute refresh | `refresh_30m` | `core_dims` (shared lists) → `finance_receivables` (receivables snapshot + collections) → `process_nps` | every 30 min (`*/30 * * * *`) |
| Sales refresh | `main` | `core_dims` → `sales_incremental` | 08:50, 11:50, 14:50, 17:50, 20:50 (unchanged until Phase B) |
| Full refresh | `full_all` | `core_dims` → receivables → sales full rebuild (→ NPS on the NPS branch) | 02:00 (unchanged) |
| Receivables alone | `finance_receivables` | receivables + collections | 15:00, **off** (the 30-minute refresh covers it) |

`process_nps` is part of the refresh as soon as the NPS branch is merged; until then the job logs that the module is
not available in this build and runs the others.

## 2. Rules

* **One run at a time.** The worker runs one job at a time (BullMQ concurrency 1) and the whole ETL run holds the
  MySQL named lock `sales_pipeline_full_load` (`GET_LOCK`, 30 s wait, exit code 4 = skipped, nothing written).
* **A refresh tick never queues.** If any run is queued or running (e.g. the 02:00 full refresh or a sales run), the
  tick is skipped and logged ("tick skipped -- a run is already queued or running"); the next tick tries again.
* **The full refresh and sales have priority.** A refresh tick that falls in the same minute as the full refresh
  (02:00) or the sales schedule yields to it. A full or sales tick that lands while only a refresh is running is
  queued behind it instead of being dropped.
* **Per-module isolation.** Every module has its own `etl_run_log` row (child of the refresh run). A failed module is
  reported and the next one still runs; a module that needs the shared lists runs on the lists of the previous cycle
  when `core_dims` failed. Run status: `success`, `partial` (some modules failed), `failed` (none succeeded).
* **Watermarks.** Each incremental dataset keeps its `(write_date, id)` watermark in `etl_watermark`, saved in the
  same transaction as its rows: a failed module keeps its old watermark and the next cycle re-reads the same window.
  Reads use `write_date >= watermark - 5 min` (`ETL_INCREMENTAL_OVERLAP_SECONDS=300`) and upsert by Odoo id, so the
  overlap is harmless. The 02:00 full refresh re-reads everything and resets each watermark to the newest
  `write_date` it loaded; the next refresh continues from there.
* **No BullMQ retry for the refresh** (one attempt): the next tick is the retry. Odoo calls retry on their own (below).
* **Odoo retries.** Every Odoo call/page retries on a network or TLS error (DNS, refused/reset, `SSL: UNEXPECTED_EOF`,
  `IncompleteRead`, `ResponseNotReady`, `RemoteDisconnected`) up to `ETL_ODOO_MAX_RETRIES` (default 5) times, with
  exponential backoff 2 → 60 s plus up to 25 % jitter, each retry on a fresh connection. Odoo's own errors (faults,
  access denied) are not retried. Authentication keeps its 15-minute retry window
  (`ODOO_CONNECT_RETRY_WINDOW_SECONDS`).

## 3. Modules: what each run reads

| Module | Odoo models | How a run reads | Deletes / cancellations / archive |
|---|---|---|---|
| `core_dims` | res.users, res.partner, product.product, account.payment.term(.line): `write_date` incremental. res.company, res.currency, crm.team, partner company properties: full (small). Excel inputs: full. | Only records changed since the watermark (−5 min). No change → seconds. | Archived records are read (`active_test=False`). Daily id reconciliation marks records deleted in Odoo (`_deleted_at`). Dimensions never delete members. |
| `finance_receivables` | account.move.line, account.move, account.payment, sale.order, account.partial.reconcile | Receivables: **full read of the open receivable lines** every run (~1.7 min), today's snapshot replaced (one snapshot per day). Collections: payments by `write_date` (1 h overlap) + unreconciled payments + new reconciliations. | Snapshot: a paid, cancelled or deleted line is no longer open, so it leaves today's snapshot. Collections: a cancelled / reset payment gets a new `write_date` and drops out (only `posted` count). |
| `process_nps` | — (the NPS developer's MySQL database) | Full reload (~25 s): the source script rewrites its tables, so `updated_at` is no watermark (decision D7). | Ids that leave the source get `_deleted_at`. |

Why the receivables snapshot is still a full read in Phase A: the snapshot is "every open receivable line as of
today", one set per day. A check on production Odoo (2026-10-20, read-only: 200 reconciliations of the last 3 days)
showed that a reconciliation DOES move the receivable line's `write_date` (74 of 74 lines), so a `write_date` read can
see payments. An incremental snapshot is therefore possible, but it also needs: an `account.move` watermark (due date
/ header changes), copying yesterday's open set into today at the first run of the day, recomputing the aging buckets
for every row each day, and re-deriving rows when a customer's salesperson or team changes. That is the same raw
mirror + targeted rebuild machinery as Phase B (sales), so it is planned there; until then the full read (~1.7 min)
keeps the snapshot exact.

## 4. Configuration

`backend/.env` (server): `ETL_SCHEDULER_ENABLED=true`, `ETL_WORKER_ENABLED=true`, `ETL_SCHEDULE_REFRESH_ENABLED=true`,
`ETL_REFRESH_INTERVAL_MINUTES=30` (a divisor of 60; or `ETL_SCHEDULE_REFRESH_CRON`), `ETL_SCHEDULE_FINANCE_ENABLED=false`.
`data/etl/.env` (server): `ETL_REFRESH_MODULES=core_dims,finance_receivables,process_nps`,
`ETL_CORE_DIMS_FRESH_MINUTES=0` (the shared lists run in every cycle; before: 180, skipped when fresh),
`ETL_ODOO_MAX_RETRIES=5`.

## 5. Install on the server (after the merge is approved; Phase A + Phase B step 1 in one release)

1. Back up the warehouse: `mysqldump --single-transaction --routines powerBI_Data > db_backups/powerbi_data_<date>_pre_30min.sql`.
2. Apply migration **0054** (`data/warehouse/migrations/0054_sales_incremental_phase_b.sql`, idempotent; NPS 0046-0053
   first if they are not applied yet).
3. Edit the server's `backend/.env`: add `ETL_SCHEDULER_ENABLED=true` and `ETL_WORKER_ENABLED=true` **before** the
   new images start (without them the new code runs no schedule at all), plus the refresh lines of §4 and
   `ETL_SCHEDULE_SALES_BUILD_ENABLED=true`.
4. Edit the server's `data/etl/.env`: the lines of §4 (an existing `ETL_ODOO_MAX_RETRIES=3` must become 5), and
   `ETL_SALES_MODE=shadow`, `ETL_REFRESH_MODULES=core_dims,sales_mirror,finance_receivables,process_nps`.
5. Deploy: `docker compose up -d --build backend etl-worker etl-api`.
6. Check: `docker compose logs backend | grep -i "schedule"` shows "Registered 30-minute refresh schedule" and "Registered
   sales build schedule (queue etl-long)"; `docker compose logs etl-worker` shows "queues etl and etl-long"; the ETL Control
   Center shows "Next 30-minute Refresh" and "Next sales build". The first `sales_mirror` reads every mirrored record once
   (about as long as one sales extraction); the first `sales_build` fills the `shd_*` copies.

## 5a. Phase B: shadow -> incremental, and back

* **shadow** (deployed): the dashboards read the live tables exactly as before; the 30-minute build writes `shd_*`. Each
  morning the Control Center card "Sales: live vs shadow" shows the comparison of the night (MATCH / DIFF, where).
* **switch to incremental** (the owner decides after >= 3 working days of MATCH): `data/etl/.env` `ETL_SALES_MODE=incremental`,
  then `docker compose up -d etl-api etl-worker`. From the next build the live tables are written every 30 minutes (changed
  rows only) and the 5x/day sales job records "skipped (disabled: ETL_SALES_MODE=incremental)". The 02:00 full refresh
  still rebuilds the live tables from Odoo every night.
* **rollback** (from either): `ETL_SALES_MODE=legacy` + the same recreate: the 5x/day job writes the live tables again,
  the mirror and the build stop (the build records "skipped"). Optionally `ETL_SCHEDULE_SALES_BUILD_ENABLED=false` in
  `backend/.env` + `docker compose up -d backend`. No code change, no migration to undo; the 0054 tables can stay (the
  down script `data/warehouse/down/0054_sales_incremental_phase_b_down.sql` removes them if ever wanted).

## 6. Uninstall / roll back to the old schedule (09-12-15-18-21 slots)

No code change is needed; in the server's `backend/.env`:

```
ETL_SCHEDULE_REFRESH_ENABLED=false
ETL_SCHEDULE_FINANCE_ENABLED=true          # the 15:00 receivables run comes back
ETL_SCHEDULE_INCREMENTAL_CRON=50 8,11,14,17,20 * * *
ETL_SCHEDULE_FULL_CRON=0 2 * * *
```

and in `data/etl/.env`: `ETL_CORE_DIMS_FRESH_MINUTES=180`. Then `docker compose up -d backend etl-api` (recreate, no
build). Full code rollback: redeploy the previous image tag / commit; keep `ETL_SCHEDULER_ENABLED=true` and
`ETL_WORKER_ENABLED=true` in the env (the old code ignores them). No table or migration to undo.

## 7. Checking it

```sql
-- the last refresh runs and their modules
SELECT p.started_at_utc, p.status, p.duration_seconds, c.job_name, c.status AS module_status, c.duration_seconds AS module_s,
       c.odoo_extract_count AS rows_read, c.rows_processed AS rows_loaded, c.error_message
FROM etl_run_log p JOIN etl_run_log c ON c.parent_run_uid = p.run_uid
WHERE p.job_name = 'refresh_30m' ORDER BY p.started_at_utc DESC, c.run_id LIMIT 30;

-- Phase B: the mirror's rows read per Odoo model, and the sales builds (skipped = nothing changed)
SELECT started_at_utc, JSON_EXTRACT(details, '$.odoo_rows_read') AS rows_read, JSON_EXTRACT(details, '$.changed') AS stored
FROM etl_task_log WHERE task_name = 'mirror_sync' ORDER BY started_at_utc DESC LIMIT 10;
SELECT started_at_utc, duration_seconds, rows_loaded, JSON_EXTRACT(details, '$.skipped') AS skipped, JSON_EXTRACT(details, '$.reason') AS reason
FROM etl_task_log WHERE task_name IN ('build_sales_from_mirror', 'write_sales_from_mirror') ORDER BY started_at_utc DESC LIMIT 10;
SELECT as_of_date, status, rows_only_live, rows_only_shadow, rows_different, cells_diff, cells_compared, excluded_orders
FROM etl_shadow_compare ORDER BY started_at_utc DESC LIMIT 7;

-- rows read per Odoo model / per task, with the watermark it moved from and to
SELECT t.task_name, t.rows_extracted, t.rows_loaded, t.duration_seconds, t.watermark_before, t.watermark_after
FROM etl_task_log t JOIN etl_run_log c ON c.run_uid = t.run_uid
WHERE c.parent_run_uid = (SELECT run_uid FROM etl_run_log WHERE job_name = 'refresh_30m' ORDER BY run_id DESC LIMIT 1);
```

Each page's "Last Refresh" comes from the newest successful run of its department (`departmentFreshness.ts`), so
Receivables and Collections moves every 30 minutes; the sales footer moves with the sales runs.
