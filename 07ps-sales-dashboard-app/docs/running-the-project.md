# Running the Project — Developer Guide

This is the complete guide to running `07ps-sales-dashboard-app` locally: the web app (backend +
frontend) and the integrated ETL pipeline (scheduler, queue worker, and every manual execution
mode). Written for a developer who has never seen this project before, from a fresh clone.

Everything here was verified against the actual codebase and, for the ETL commands, against real
runs against the live Odoo/MySQL instance — not assumed.

**Project root**: `07ps-sales-dashboard-app/` — every command below is relative to that folder
unless stated otherwise. This is an npm-workspaces monorepo: `frontend/`, `backend/`, and
`packages/ui/` share one `node_modules` at the root.

## Prerequisites

| Software | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | `backend`/`frontend` |
| npm | comes with Node | workspaces support required |
| Python | ≥ 3.10 | only for the vendored ETL pipeline in `data/etl/` |
| MySQL | 8.x | the app connects to an existing instance; not containerized |
| Redis | any recent version | **only** needed for the ETL queue/worker/scheduler-execution path — not needed to use the web app or run the ETL with `--sync` |
| Docker | optional | only for `docker compose` production deployment, or to run Redis in a container locally |

## 1. Running the Backend

```bash
cd backend
npm run dev
```

- **Folder**: `backend/`
- **Command**: `npm run dev` (runs `tsx watch src/server.ts` — auto-restarts on file changes)
- **Default port**: `4000` (from `PORT` in `backend/.env`)
- **Expected output**:
  ```
  > backend@0.1.0 dev
  > tsx watch src/server.ts

  2026-07-09 09:00:00 | INFO | Registered incremental ETL schedule {"cron":"50 8,11,14,17,20 * * *"}
  2026-07-09 09:00:00 | INFO | Registered full-refresh ETL schedule {"cron":"0 2 * * *"}
  07 Ps API (Phase P1/P2 foundation) listening on :4000
  ```
  The two "Registered ... schedule" lines are the ETL scheduler starting automatically — see
  [§5](#5-scheduler).
- **Verify it's running**:
  ```bash
  curl http://localhost:4000/health
  # {"status":"ok","phase":"P1/P2 foundation"}
  ```

## 2. Running the Frontend

```bash
cd frontend
npm run dev
```

- **Folder**: `frontend/`
- **Command**: `npm run dev` (runs `next dev`)
- **Default port**: `3000`
- **Expected output**:
  ```
  ▲ Next.js 14.2.5
  - Local:        http://localhost:3000
   ✓ Ready in 6.2s
  ```
- **Verify it's running**: open `http://localhost:3000` in a browser (redirects to `/login`), or:
  ```bash
  curl -o /dev/null -w "%{http_code}\n" http://localhost:3000
  # 200
  ```

## 3. Running the ETL

The ETL is a vendored Python pipeline (`data/etl/`) orchestrated by Node
(`backend/src/etl/`). Every mode below is a real `npm run` command backed by its own file in
`backend/src/etl/commands/`.

**Every command below can run two ways** — this applies uniformly, not just to one mode:
- **Default (enqueue)**: adds a job to the Redis queue; a running `etl:worker` (§4) picks it up
  and executes it. Requires Redis + a worker running.
- **`-- --sync`**: runs the pipeline inline in the current process instead, no Redis or worker
  needed. This is the fastest way to run something manually or test a change.

```bash
npm run etl:full           # enqueue
npm run etl:full -- --sync # run inline, right now
```

### Full Refresh
```bash
cd backend
npm run etl:full -- --sync
```
Rebuilds every dimension and fact table (sales + CRM) from a **complete** Odoo extract, not just
changes. Writes to MySQL only.
- **Underlying Python args**: `python -m sales_pipeline.main --output sql --load-mode full`
- **Required arguments**: none
- **Optional arguments**: `--sync` (run inline instead of enqueueing)
- **Expected execution time**: ~55–60 minutes (real observed run: 57.1 min, 22,750 rows extracted
  from Odoo, 383,979 rows loaded to MySQL)
- **Expected output**: exit code 0; a new `SUCCESS` row in `pipeline_run_log`/`pipeline_run_audit`
  with `load_mode=full`, `output_mode=sql`
- **Tables affected**: all `Dim_*`/`Fact_*` tables in MySQL (`powerBI_Data`) — full rewrite
- **Redis required**: no (with `--sync`) / yes (without)
- **Queue Worker required**: no (with `--sync`) / yes (without)
- **Scheduler required**: no — this is a manual/on-demand mode (the scheduler's own full-refresh
  tick uses the same flags automatically, see §5)

### Incremental Refresh
```bash
cd backend
npm run etl:incremental -- --sync
```
Pulls only Odoo records changed since the last successful run (using the latest-order cursor
already stored in MySQL). Writes to MySQL only. Uses `--fast` — this is the production default
cadence (the same flags the old Windows-Task-Scheduler-driven `scheduler.py` ran 5×/day).
- **Underlying Python args**: `python -m sales_pipeline.main --output sql --load-mode incremental --fast`
- **Required arguments**: none
- **Optional arguments**: `--sync`
- **Expected execution time**: ~15–40 minutes (real observed run: 33.5 min, 22,437 rows extracted,
  384,024 rows loaded, 0 QA issues) — extraction itself is much faster than a full refresh, but the
  transform/load stages still process the full staged dataset, so total time is in the same order
  of magnitude as a full run
- **Expected output**: exit code 0; new `SUCCESS` row, `load_mode=incremental`, `output_mode=sql`
- **Tables affected**: same `Dim_*`/`Fact_*` tables, updated in place (not dropped/recreated)
- **Redis required**: no (with `--sync`) / yes (without)
- **Queue Worker required**: no (with `--sync`) / yes (without)
- **Scheduler required**: no to run manually — but this exact command is what the scheduler runs
  automatically every few hours by default (§5)

### SQL Mode
```bash
cd backend
npm run etl:sql -- --sync
```
Writes to MySQL only, no Excel workbook. Incremental load, **without** `--fast` — so QA exports
and full scoped validation still run (use `etl:incremental` instead for the faster,
validation-light production cadence). This is the general "just sync the database, thoroughly"
command.
- **Underlying Python args**: `python -m sales_pipeline.main --output sql --load-mode incremental`
- **Required arguments**: none
- **Optional arguments**: `--sync`
- **Expected execution time**: similar to or slightly longer than Incremental Refresh (extra QA
  validation work)
- **Expected output**: exit code 0; new row with `output_mode=sql`
- **Tables affected**: same `Dim_*`/`Fact_*` tables, updated in place
- **Redis required**: no (with `--sync`) / yes (without)
- **Queue Worker required**: no (with `--sync`) / yes (without)
- **Scheduler required**: no

### Excel Mode
```bash
cd backend
npm run etl:excel -- --sync
```
Produces the Excel workbook (`data/etl/Exports/SalesModel_OneOutput.xlsx`, plus the
`Inventory_Validation.xlsx` QA export) from a full Odoo extract. **Writes no MySQL data at all** —
verified directly: this is the one combination (`--load-mode full --output excel`) where the
vendored pipeline's own settings validation (`data/etl/config/settings.py`) doesn't require a
database connection, and a real run of this command showed it proceeding straight into Odoo
extraction without ever touching MySQL.
- **Underlying Python args**: `python -m sales_pipeline.main --output excel --load-mode full`
- **Required arguments**: none
- **Optional arguments**: `--sync`
- **Expected execution time**: comparable to Full Refresh's extract+transform stages (roughly
  20–40 minutes), since it skips the SQL load/validation stage entirely
- **Expected output**: exit code 0; `data/etl/Exports/SalesModel_OneOutput.xlsx` and
  `Inventory_Validation.xlsx` written to disk. **Does not** write to `pipeline_run_log` in the same
  way SQL modes do requiring a DB — if no DB connection was made, no run-history row is written
  (this mode's audit trail is the file on disk plus `backend/logs/etl/etl.log`)
- **Tables affected**: none
- **Redis required**: no (with `--sync`) / yes (without)
- **Queue Worker required**: no (with `--sync`) / yes (without)
- **Scheduler required**: no — not on any default schedule (see §5)

### Additional modes

The commands above cover the 2×2 combinations documented in the vendored pipeline's own CLI
(`--load-mode {full,incremental}` × `--output {sql,excel,both}`, `data/etl/src/sales_pipeline/main.py`).
Two more exist but have no dedicated npm script yet:

- **`--output both`**: writes MySQL **and** the Excel workbook in the same run. Not exposed as its
  own `npm run` command; call the lower-level API directly if needed (see below).
- **Aliases `etl:customers` / `etl:sales` / `etl:inventory` / `etl:products`** (pre-existing,
  `backend/src/etl/commands/customers.ts` etc.): currently all trigger the same full pipeline run
  as `etl:run`, just labeled differently in the log. The vendored pipeline has no independent
  per-domain seam today (dimensions/facts are built in one interdependent sequence) — documented
  in each file's header comment.
- **`etl:run [-- --full] [-- --sync]`**: the original general-purpose command (incremental+sql by
  default, `--full` for a full refresh). Functionally superseded by the more explicit
  `etl:full`/`etl:incremental` above, kept for backward compatibility.

Every other flag the Python CLI supports (`--strict`, `--profile`, `--odoo-cutoff-utc`,
`--validation-baseline`, `--write-validation-baseline`, `--include-qa`, `--full-validation`,
`--force-sales-full-refresh`) is accepted by `runPipeline()`'s `extraArgs` option
(`backend/src/etl/services/pythonRunner.ts`) but not wired to any npm script — call
`runPipeline({ loadMode, outputMode, extraArgs: ['--strict'] })` from a small script if you need
one of these, or run the Python CLI directly (see `data/etl/README.md`).

## 4. Queue Worker

```bash
cd backend
npm run etl:worker
```
- **Folder**: `backend/`
- **Command**: `npm run etl:worker` (runs `tsx src/etl/commands/worker.ts`)
- **Expected output**:
  ```
  2026-07-09 09:00:00 | INFO | ETL worker started, waiting for jobs...
  ```
  Then, once a job is enqueued and picked up:
  ```
  2026-07-09 09:00:05 | INFO | Job picked up by worker {"jobId":"1","label":"full-refresh",...}
  ...
  2026-07-09 09:34:00 | INFO | Job completed {"jobId":"1","label":"full-refresh"}
  ```
- This process must stay running (it's a long-lived worker, like `queue:work` in other
  frameworks) — it's what actually executes any ETL job that wasn't run with `--sync`, including
  every job the scheduler enqueues. Stop with `Ctrl+C` (handled gracefully via `SIGINT`).
- Requires Redis to be reachable (`REDIS_HOST`/`REDIS_PORT` in `.env`).

## 5. Scheduler

- **Starts automatically**: yes — `registerEtlSchedules()` runs once inside `backend/src/server.ts`
  at API startup (§1's "Registered ... schedule" log lines). There is no separate scheduler
  process or command.
- It only **enqueues** jobs on a timer (`node-cron`) — it never runs the pipeline itself, so
  nothing happens unless `etl:worker` (§4) is also running and Redis is reachable.
- Two independent schedules, both configurable via `backend/.env`:
  - `ETL_SCHEDULE_INCREMENTAL_CRON` (default `50 8,11,14,17,20 * * *`) /
    `ETL_SCHEDULE_INCREMENTAL_ENABLED` (default `true`)
  - `ETL_SCHEDULE_FULL_CRON` (default `0 2 * * *`, nightly) / `ETL_SCHEDULE_FULL_ENABLED`
    (default `true`)
- **Verify scheduled jobs are executing**:
  1. Confirm both "Registered ... schedule" lines appeared in the backend's startup log.
  2. Confirm `etl:worker` is running.
  3. Wait for (or temporarily shorten) a cron tick, then check `backend/logs/etl/etl.log` for
     `"Scheduled incremental ETL tick -- enqueueing job"` / `"Scheduled full-refresh ETL tick"`,
     and the Admin → ETL Runs page (or `GET /admin/etl-runs/log`) for the resulting run.

## 6. Redis

- **Required?** Only for: the queue (any `etl:*` command run *without* `--sync`), the scheduler
  actually executing anything (it can register without Redis, but enqueueing will fail/log an
  error if Redis is down — see below), and `etl:worker`.
- **Not required** for: the web app (login, dashboard, admin panel), or any `etl:*` command run
  with `--sync`.
- **Start locally**:
  ```bash
  docker run -p 6379:6379 redis:7-alpine
  ```
- **Verify connected**:
  ```bash
  docker exec -it <container-id-or-name> redis-cli ping
  # PONG
  ```
  From the app's side: no `"ETL queue connection error"` lines in `backend/logs/etl/etl.log` (or
  the backend's console) is the sign Redis is reachable — the app is intentionally written so a
  missing Redis logs an error and keeps running rather than crashing the API process
  (`backend/src/etl/queue/etlQueue.ts`, `backend/src/etl/jobs/runPipelineJob.ts`).

## 7. Running Without Redis

Every `etl:*` command supports `--sync`, which runs the pipeline inline in the current process and
never touches Redis at all:
```bash
cd backend
npm run etl:full -- --sync
npm run etl:incremental -- --sync
npm run etl:sql -- --sync
npm run etl:excel -- --sync
```
This is the recommended way to run the ETL during day-to-day development — no Redis, no worker
process, immediate console output, and a clean exit code (`0` success / `1` failure) you can check
directly.

## 8. Common Development Workflows

**Start only the web application** (no ETL execution):
```bash
# Terminal 1
cd backend
npm run dev

# Terminal 2
cd frontend
npm run dev
```
(The backend still *registers* the ETL schedules per §5, but nothing runs unless Redis + a worker
are also up.)

**Run one manual ETL synchronization** (any mode, right now, no Redis):
```bash
cd backend
npm run etl:sql -- --sync
```

**Run the ETL in Incremental mode**:
```bash
cd backend
npm run etl:incremental -- --sync
```

**Run the ETL in Full mode**:
```bash
cd backend
npm run etl:full -- --sync
```

**Run Excel export**:
```bash
cd backend
npm run etl:excel -- --sync
```

**Run SQL synchronization**:
```bash
cd backend
npm run etl:sql -- --sync
```

**Start everything required for local development** (web app + scheduled/queued ETL execution):

Terminal 1
```bash
cd backend
npm run dev
```

Terminal 2
```bash
cd frontend
npm run dev
```

Terminal 3
```bash
docker run -p 6379:6379 redis:7-alpine
```

Terminal 4
```bash
cd backend
npm run etl:worker
```

## 9. Helper Scripts (root `package.json`)

These now exist at the project root so you don't need to `cd` into `backend`/`frontend` for the
common cases (they delegate to the workspace scripts documented above):

```bash
npm run backend           # == cd backend && npm run dev
npm run frontend          # == cd frontend && npm run dev
npm run dev                # both backend + frontend together (pre-existing, via `concurrently`)
npm run etl:run -- --sync  # general-purpose ETL command (pre-existing, extended for arg passthrough)
npm run etl:full -- --sync
npm run etl:incremental -- --sync
npm run etl:sql -- --sync
npm run etl:excel -- --sync
npm run etl:worker
```

**Note the `--` before any extra flag** (e.g. `npm run etl:full -- --sync`) — required for npm to
forward the flag through the root script into the backend workspace's script instead of consuming
it itself. Omitting it (`npm run etl:full --sync`) silently drops the flag. This was verified
directly, not assumed.

`npm run etl:worker` takes no arguments, so no `--` is needed for it.

## 10. Verifying Everything

```bash
# Backend
curl http://localhost:4000/health
# {"status":"ok","phase":"P1/P2 foundation"}

# Frontend
curl -o /dev/null -w "%{http_code}\n" http://localhost:3000
# 200

# JWT auth (also proves the database is connected -- login queries MySQL)
curl -X POST http://localhost:4000/auth/login -H "Content-Type: application/json" \
  -d '{"email":"<your admin email>","password":"<your password>"}'
# returns { token, user, permissions }

# Redis
docker exec -it <redis-container> redis-cli ping
# PONG

# Queue worker: its own terminal should show "ETL worker started, waiting for jobs..."
# and "Job completed" after a job runs

# Scheduler: backend's startup log shows both "Registered ... ETL schedule" lines

# ETL run history
curl http://localhost:4000/admin/etl-runs/log -H "Authorization: Bearer <token>"
# or open Admin -> ETL Runs in the browser (Admin role by default)
```

## Environment Files

Only `backend/.env` matters for running this project (see `backend/.env.example` for the full,
commented template). It holds MySQL, JWT, SMTP, Odoo, and every `ETL_*`/`REDIS_*` variable
referenced above. There is no separate `.env` for `data/etl/` by design — Node injects the
relevant values into the Python subprocess's environment at spawn time
(`backend/src/etl/config/etlConfig.ts`), so credentials exist in exactly one place. Full details
in [docs/etl-deployment.md](./etl-deployment.md).
