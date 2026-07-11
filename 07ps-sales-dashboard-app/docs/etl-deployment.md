# ETL Integration: Deployment & Operations

This document explains how the Odoo → MySQL ETL pipeline (previously a standalone project at
`C:\Users\Lenovo\Desktop\PowerBIData\powerbi_sales_pipeline`, kept alive by Windows Task Scheduler)
is now integrated into this monorepo, and how to deploy/operate the whole system as one project.

## What changed and why

The web app and the ETL used to be two separate deployables reading/writing the same MySQL
database. That's fine for local development but means deploying twice, and the ETL's scheduling
depended on Windows Task Scheduler, which doesn't exist on a Linux VPS. Now:

- The ETL's actual business logic (Odoo extraction, CRM/dimension/fact building, incremental
  loading, validation) is **vendored unchanged** into `data/etl/` — nothing under
  `data/etl/config`/`data/etl/src`/`data/etl/tests` was rewritten.
- A new Node module, `backend/src/etl/`, orchestrates it: CLI commands, a cron-based scheduler, a
  Redis-backed job queue, and logging — replacing the Windows Task Scheduler + `scheduler.py`
  combo entirely.
- One `docker compose up -d --build` on the deployment target brings up the whole system.

**Per-module commands (`etl:customers`/`etl:sales`/`etl:inventory`/`etl:products`) are aliases for
the same full pipeline run today**, not independent sub-pipelines — the vendored pipeline is a
single interdependent run (dimensions/facts built in a fixed, cross-referenced order), so there's
no existing seam to isolate "just the customers data" without restructuring its internals. The
command surface exists and is labeled distinctly in logs so this is easy to revisit later.

## Architecture

```
backend/src/etl/
  config/etlConfig.ts       single place reading ETL_*/ODOO_* env vars (mirrors src/db/pool.ts)
  services/pythonRunner.ts  spawns data/etl's `python -m sales_pipeline.main ...`
  services/etlLogger.ts     orchestration-level log (backend/logs/etl/etl.log) -- NOT a duplicate
                            of the pipeline's own MySQL run history (see below)
  queue/etlQueue.ts         BullMQ queue -- the API process only enqueues jobs here
  jobs/runPipelineJob.ts    the BullMQ worker's job processor -- actually runs the pipeline
  scheduler/registerSchedules.ts   node-cron -- registered once at API server startup
  commands/*.ts             npm run etl:run | etl:customers | etl:sales | etl:inventory |
                            etl:products | etl:worker

data/etl/                   vendored pipeline (config/, src/sales_pipeline/, tests/, docs/) --
                            see data/etl/README.md's header for what was/wasn't carried over
```

Two processes, not one, run in production: the **API process** (`backend`, serves the web app +
registers cron schedules that just call `queue.add()`) and the **worker process** (`etl-worker`,
the only place that needs Python installed, consumes the queue and actually executes runs). This
mirrors a typical Laravel deployment's `php-fpm` + `queue:work` split.

## Where run history lives

The vendored pipeline already writes rich, per-run history straight into MySQL —
`pipeline_run_log` (start/end time, duration, extract/load/QA counts, status, error message) and
`pipeline_run_audit` (load_mode/output_mode, before/after order cursor, per-table row counts as
JSON) — regardless of what invokes it. **Node does not duplicate this.** It's visible in-app at
**Admin → ETL Runs** (`GET /admin/etl-runs/log` and `/audit`, permission-gated like every other
admin page). `backend/logs/etl/etl.log` is a separate, smaller log for the orchestration layer
itself (job queued/started/failed/retrying, subprocess exit codes) — useful when the question is
"did the scheduler/queue do what it was supposed to," not "what did the pipeline extract."

## Configuration

Everything lives in `backend/.env` (see `backend/.env.example` for the full list with comments):
Odoo connection (`ODOO_URL`/`ODOO_DB`/`ODOO_USER`/`ODOO_API_KEY`), timeouts/retries, batch/chunk
sizes, the vendored pipeline's location and python binary (`ETL_PYTHON_DIR`/`ETL_PYTHON_BIN`),
input/output/log directories, the two schedules (`ETL_SCHEDULE_INCREMENTAL_CRON`/
`ETL_SCHEDULE_FULL_CRON`, each independently enable-able), and Redis connection. `DB_*` (MySQL) is
already there from the auth system work and is reused as-is — `pythonRunner.ts` passes it straight
into the subprocess's environment, so credentials exist in exactly one place.

**No secrets are duplicated on disk**: `data/etl` must never have its own `.env` file (see its
`.gitignore`); Node injects everything at subprocess-spawn time.

## Local development

```powershell
# One-time: create the vendored pipeline's venv and install its dependencies
cd data\etl
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install -e .
cd ..\..

# Fill in backend\.env: ODOO_API_KEY at minimum (Odoo URL/DB/user are already there),
# and set ETL_PYTHON_BIN=../data/etl/.venv/Scripts/python.exe (already the default in .env)

# One-time: seed the business-maintained reference files the pipeline validates against on every
# run (sales targets, sales team roster, off-days calendar, product master, blocked customers).
# These are DATA, not code -- gitignored, not vendored automatically -- copy them from wherever
# the business currently maintains them into data\etl\Input\:
#   BlockedCustomers.xlsx, OffDays.xlsx, PRODUCTS.xlsx, SalesTeam.xlsx, sales_targets.xlsx

# Start Redis (needed for the queue -- not needed for --sync runs, see below)
docker run -p 6379:6379 redis:7-alpine

# From backend/:
npm run etl:run              # enqueues a job (needs Redis + a worker running)
npm run etl:run -- --sync    # runs inline instead, no Redis/worker needed -- fastest local loop
npm run etl:worker           # starts the worker that processes queued jobs (separate terminal)
npm run dev                  # the API server also registers the cron schedules at startup
```

`--full` on any `etl:*` command runs a full refresh instead of the default fast/incremental mode
(matching the pipeline's existing `--fast --load-mode incremental` production cadence).

## Production deployment

```bash
git clone <this repo> && cd 07ps-sales-dashboard-app
cp backend/.env.example backend/.env   # fill in real Odoo/DB/JWT/SMTP values
docker compose up -d --build
```

This brings up `frontend`, `backend` (API + scheduler), `redis`, and `etl-worker` (worker, with
Python + the vendored pipeline's dependencies installed at build time via
`backend/Dockerfile.etl-worker`). No Windows Task Scheduler, no second repository, no manual ETL
execution — the schedules in `backend/.env` take over immediately.

**Two things that differ from local dev, both already handled by the compose file, but worth
understanding if something doesn't connect:**
- `REDIS_HOST` should be `redis` (the compose service name), not `localhost`, when running under
  docker-compose -- container-to-container traffic uses service-name DNS, not the host loopback.
- MySQL is **not** containerized (this repo already runs against an existing MySQL 8 instance --
  see `docs/tech-stack-decision.md`). If that instance runs on the same host as the containers
  (not a separate DB server), `DB_HOST=localhost` in `.env` will not resolve from inside a
  container; use `host.docker.internal` (add `extra_hosts: ["host.docker.internal:host-gateway"]`
  to the `backend`/`etl-worker` services) or the host's real reachable address instead.

## Operating the system day-to-day

- **Check recent runs**: Admin → ETL Runs in the web app (Admin role by default; grant the
  `admin_etl` permission to other roles via Admin → Roles & Permissions if needed).
- **Trigger a run manually**: `npm run etl:run` (or `-- --full`) from a shell on the server, or
  `docker compose exec backend npm run etl:run` if running in containers -- enqueues a job the
  `etl-worker` service picks up.
- **Change the schedule**: edit `ETL_SCHEDULE_INCREMENTAL_CRON`/`ETL_SCHEDULE_FULL_CRON` in
  `backend/.env` and restart the `backend` service (cron registrations happen once at startup).
- **Troubleshoot a failure**: start with Admin → ETL Runs (the pipeline's own error message and
  per-table counts), then `backend/logs/etl/etl.log` (or `docker compose logs etl-worker`) for the
  orchestration-level view -- which job ran, its exit code, retry attempts, stdout/stderr tail.
- **Add a new data source later** (SAP, CSV/Excel import, another API): add a new job under
  `backend/src/etl/jobs/`, a new command under `backend/src/etl/commands/`, reusing the existing
  queue/scheduler/logging plumbing -- no changes needed to that plumbing itself.
