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
  config/etlConfig.ts       single place reading ETL_API_URL/ETL_API_KEY/schedule/Redis env vars
                            (mirrors src/db/pool.ts) -- no longer holds Odoo credentials or
                            pipeline tuning knobs; see "The Flask ETL API" below
  services/pythonRunner.ts  calls the ETL Flask API over HTTP and polls it to completion
  services/etlLogger.ts     orchestration-level log (backend/logs/etl/etl.log) -- NOT a duplicate
                            of the pipeline's own MySQL run history (see below)
  queue/etlQueue.ts         BullMQ queue -- the API process only enqueues jobs here
  jobs/runPipelineJob.ts    the BullMQ worker's job processor -- calls pythonRunner.ts
  scheduler/registerSchedules.ts   node-cron -- registered once at API server startup
  commands/*.ts             npm run etl:run | etl:customers | etl:sales | etl:inventory |
                            etl:products | etl:worker

data/etl/                   vendored pipeline (config/, src/sales_pipeline/, tests/, docs/) --
                            see data/etl/README.md's header for what was/wasn't carried over
data/etl/api/                Flask API wrapping the pipeline as an HTTP service (app.py,
                            job_tracker.py, wsgi.py) -- see "The Flask ETL API" below
```

Three processes run in production: the **API process** (`backend`, serves the web app + registers
cron schedules that just call `queue.add()`), the **worker process** (`etl-worker`, consumes the
queue and calls the ETL API over HTTP -- no longer needs Python installed at all), and the **ETL
API process** (`etl-api`, a separate Flask/gunicorn container that's the only one that needs Python
+ the vendored pipeline installed, and the only one that actually spawns
`python -m sales_pipeline.main`).

### The Flask ETL API

`pythonRunner.ts` used to spawn the pipeline subprocess directly from the `etl-worker` process.
It now calls `data/etl/api/app.py` (containerized via `data/etl/Dockerfile.api`) over HTTP instead:
`POST /etl/run` starts a run and returns a job id immediately; `pythonRunner.ts` polls
`GET /etl/jobs/<id>` for new log lines and the final status, same as it always tracked
stdout/stderr/exit code, just over HTTP instead of local pipes. `POST /etl/jobs/<id>/cancel`
terminates the subprocess for the ETL Control Center's Cancel button.

This split exists because `etl-api` is the only container that needs Python + the pipeline's
dependencies installed, and isolating that lets `etl-worker` stay a small Node-only image. See
`docs/vps-deployment.md` for the full containerized deployment and `data/etl/api/README` (this
file's own header, and `job_tracker.py`'s docstring) for the API's endpoints and its accepted
limitation (job state is in-memory - a restart of the `etl-api` container mid-run loses tracking
of that run, though the subprocess dies with it too, so nothing is orphaned).

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

Two `.env` files now, not one, because the ETL API is a separate process/container:

- `backend/.env` (see `backend/.env.example`): `ETL_API_URL`/`ETL_API_KEY` to reach the Flask API,
  the two schedules (`ETL_SCHEDULE_INCREMENTAL_CRON`/`ETL_SCHEDULE_FULL_CRON`, each independently
  enable-able), Redis connection, plus everything else the web app needs (DB_*, JWT, SMTP). No
  longer holds Odoo credentials or pipeline tuning knobs at all -- those moved to data/etl/.env.
- `data/etl/.env` (see `data/etl/.env.example`): Odoo connection (`ODOO_URL`/`ODOO_DB`/`ODOO_USER`/
  `ODOO_API_KEY`), `DB_*` (same MySQL instance, reused as-is), `INPUT_DIR`/`OUTPUT_DIR`, and
  `ETL_API_KEY` (must match `backend/.env`'s value exactly -- one shared secret, two files because
  it's now two containers).

`ETL_API_KEY` is the only value that must be **kept in sync** between the two files.

## Local development

```powershell
# One-time: create the vendored pipeline's venv and install its dependencies
cd data\etl
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install -e .
cd ..\..

# Fill in data\etl\.env (copy from data\etl\.env.example): ODOO_API_KEY at minimum (Odoo URL/DB/
# user are already there), plus DB_* and ETL_API_KEY (any value -- just needs to match backend\.env's
# ETL_API_KEY exactly).

# One-time: seed the business-maintained reference files the pipeline validates against on every
# run (sales targets, sales team roster, off-days calendar, product master, blocked customers).
# These are DATA, not code -- gitignored, not vendored automatically -- copy them from wherever
# the business currently maintains them into data\etl\Input\:
#   BlockedCustomers.xlsx, OffDays.xlsx, PRODUCTS.xlsx, SalesTeam.xlsx, sales_targets.xlsx

# Start the ETL Flask API (pythonRunner.ts calls this now, regardless of --sync/queued below):
cd data\etl\api
..\.venv\Scripts\python app.py     # PORT defaults to 5001; set ETL_API_KEY to match backend\.env
cd ..\..\..

# Start Redis (needed for the queue -- not needed for --sync runs, see below)
docker run -p 6379:6379 redis:7-alpine

# From backend/, with ETL_API_URL=http://localhost:5001 and ETL_API_KEY set in backend\.env:
npm run etl:run              # enqueues a job (needs Redis + a worker running)
npm run etl:run -- --sync    # runs inline instead, no Redis/worker needed -- still calls the Flask API
npm run etl:worker           # starts the worker that processes queued jobs (separate terminal)
npm run dev                  # the API server also registers the cron schedules at startup
```

`--full` on any `etl:*` command runs a full refresh instead of the default fast/incremental mode
(matching the pipeline's existing `--fast --load-mode incremental` production cadence).

## Production deployment

```bash
git clone <this repo> && cd 07ps-sales-dashboard-app
cp backend/.env.example backend/.env       # fill in real DB/JWT/SMTP/ETL_API_URL/ETL_API_KEY values
cp data/etl/.env.example data/etl/.env     # fill in real Odoo/DB/ETL_API_KEY values (same key as above)
docker compose up -d --build
```

This brings up `frontend`, `backend` (API + scheduler), `redis`, `etl-api` (Flask API, the only
container with Python + the vendored pipeline's dependencies, installed at build time via
`data/etl/Dockerfile.api`), and `etl-worker` (Node-only worker that calls `etl-api` over HTTP). No
Windows Task Scheduler, no second repository, no manual ETL execution — the schedules in
`backend/.env` take over immediately. See `docs/vps-deployment.md` for the full walkthrough
(DNS, Nginx, TLS) of exposing this to the internet.

**Things docker-compose.yml already overrides for you, worth knowing if something doesn't
connect:**
- `REDIS_HOST=redis` and `ETL_API_URL=http://etl-api:5001` (container-to-container DNS, not
  `localhost`) are set directly in `docker-compose.yml`'s `environment:` blocks — don't rely on
  `backend/.env`'s local-dev defaults for these under compose.
- MySQL is **not** containerized (this repo already runs against an existing MySQL 8 instance —
  see `docs/tech-stack-decision.md`). If that instance runs on the same host as the containers
  (not a separate DB server), `DB_HOST=localhost` in `.env` will not resolve from inside a
  container; use `host.docker.internal` (add `extra_hosts: ["host.docker.internal:host-gateway"]`
  to the `backend`/`etl-api` services) or the host's real reachable address instead.

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
  orchestration-level view -- which job ran, its exit code, retry attempts, stdout/stderr tail
  (forwarded from the ETL API's HTTP responses). `docker compose logs etl-api` has the pipeline's
  own raw stdout/stderr directly from the subprocess, useful if the tail alone isn't enough.
- **Add a new data source later** (SAP, CSV/Excel import, another API): add a new job under
  `backend/src/etl/jobs/`, a new command under `backend/src/etl/commands/`, reusing the existing
  queue/scheduler/logging plumbing -- no changes needed to that plumbing itself.
