# ETL CLI Command Reference

A focused reference for running the ETL pipeline **directly from the command line**, bypassing the
Admin UI / Node API entirely. For the `npm run etl:*` wrapper commands (which go through the Node
backend and the Flask ETL API — the same path the Admin UI's "Start Run" buttons use), see
[running-the-project.md §3](./running-the-project.md#3-running-the-etl) instead; this document
covers the lower-level path: invoking the vendored Python pipeline in `data/etl/` yourself, with no
Node process, Redis, or Flask API involved at all.

**Both paths write to the same MySQL database and the same `pipeline_run_log`/`pipeline_run_audit`
history tables** — there is only one pipeline; this is just a second way to trigger it. Nothing here
removes or changes the Admin UI trigger.

**Working directory**: every command below assumes `data/etl/` as the current directory
(`07ps-sales-dashboard-app/data/etl/`), and a working virtualenv at `data/etl/.venv/` (see
[etl-deployment.md](./etl-deployment.md#local-development) for one-time venv setup if it doesn't
exist yet).

## 1. Running the full pipeline from the CLI

Two ways to invoke it directly. Both run the exact same pipeline (`sales_pipeline.main`); the only
difference is whether output is captured to a log file.

### 1a. `run_pipeline.py` — recommended for manual runs (writes a log file)

```powershell
cd data\etl
.venv\Scripts\python.exe run_pipeline.py --mode full --output sql
```

```bash
cd data/etl
.venv/Scripts/python.exe run_pipeline.py --mode full --output sql
```

- `--mode {full,incremental}` (default `incremental`) — maps to `--load-mode` below.
- `--output {sql,excel,both}` (default `both`) — `sql` only touches MySQL; `excel` only writes
  `Exports/SalesModel_OneOutput.xlsx` and touches no database at all; `both` does both.
- Also accepts `--fast`, `--strict`, `--profile`, `--full-validation`, `--include-qa`,
  `--scheduled-refresh-time`, `--odoo-cutoff-utc`, `--validation-baseline`,
  `--write-validation-baseline` — passed straight through to the pipeline (see §1b).
- Writes stdout+stderr (unfiltered, every line) to
  `data/etl/logs/pipeline_{mode}_{output}_{timestamp}.log` — see §5.
- Exit code 0 on success, non-zero on failure (printed to the console either way, e.g. `Pipeline
  SUCCESS. See log: ...` / `Pipeline FAILED with exit code 1. See log: ...`).

### 1b. Direct module invocation (console output only, no log file)

```powershell
cd data\etl
.venv\Scripts\python.exe -m sales_pipeline.main --output sql --load-mode full
```

Same underlying pipeline, same flags (`--load-mode` instead of `--mode`, everything else
identical), just no `run_pipeline.py` wrapper — output goes to the console only, not to
`data/etl/logs/`. This is exactly what `run_pipeline.py`, the Flask ETL API, and every `npm run
etl:*` command all ultimately execute under the hood.

## 2. Running a single source (Products / OffDays)

**Honest answer: there is no `--source`/`--only` flag.** The vendored pipeline builds every
dimension and fact table in one interdependent sequence (`sales_pipeline/pipeline.py`'s
`transform()`) — Products and OffDays are loaded as part of that same sequence, not as separable
sub-pipelines. Running "the full pipeline" (§1) is what refreshes both. `npm run
etl:products`/`etl:customers`/`etl:sales`/`etl:inventory` in the backend are aliases for the same
full run, labeled differently in logs only (see each command's own header comment in
`backend/src/etl/commands/`) — not real per-source runs.

**One real exception — OffDays has a standalone script:**

```powershell
cd data\etl
.venv\Scripts\python.exe resync_offdays.py
```

This reuses the pipeline's own `OffDaysFactBuilder` + `DatabaseExporter._write_table` to rebuild
just the `Fact_OffDays` table (~21 rows) from `Input/OffDays.xlsx`, without running Odoo extraction
or touching any other table. It exists specifically because a full run is a heavyweight (~55-60
minute) way to refresh a small, infrequently-changing reference sheet.

**No equivalent exists for Products.** `data/etl/scripts/refresh_product_outputs.py` looks similar
but only patches the **Excel workbook** (`Exports/SalesModel_OneOutput.xlsx`'s `Dim_Product`/
`Dim_ProductCost`/`Fact_BCGMatrix` sheets) — it never writes to MySQL. To get an updated
`Input/PRODUCTS.xlsx` into the database, a full run (§1, `--mode full`) is required. This also
matters for **incremental** runs (§3) — `Dim_Product` is upserted-by-key incrementally but rows
*removed* from `PRODUCTS.xlsx` are never deleted except by a full run, and `Fact_OffDays` is
skipped entirely in incremental mode (see §3).

## 3. Full-refresh vs incremental

Both are the same pipeline with `--load-mode`/`--mode` switched (`sales_pipeline/export/
database_exporter.py`'s `export()` vs `export_incremental()`):

| | Full (`--mode full`) | Incremental (`--mode incremental`) |
|---|---|---|
| Every table | Unconditionally rewritten (`DROP`+recreate or `TRUNCATE`+reload, per `DB_RELOAD_MODE`) | Upserted by key where a key exists (`STRICT_INCREMENTAL_KEY_TABLES`), or skipped |
| `Fact_OffDays` | Always rewritten from `Input/OffDays.xlsx` | **Skipped entirely** if the table already exists — stale in an incremental-only environment |
| `Dim_Product` | Full rewrite, stale rows removed | Upsert-by-`ProductKey` — new/changed rows land, but rows removed from `PRODUCTS.xlsx` are **not** deleted |
| Odoo extraction | Full extract | Only records changed since the last successful run (cursor stored in MySQL) + a 7-day overlap |
| Typical duration | ~55-60 min | ~15-40 min |

**These two modes are exactly what the two cron schedules registered at backend startup run**
(`backend/src/etl/scheduler/registerSchedules.ts`, at API process boot — see the "Registered ...
ETL schedule" log lines in `npm run dev`'s output):

- **Incremental** — `ETL_SCHEDULE_INCREMENTAL_CRON` in `backend/.env` (this environment:
  `0 */3 * * *`, i.e. every 3 hours) → enqueues `{loadMode:'incremental', outputMode:'sql',
  fast:true}`, equivalent to:
  ```
  python -m sales_pipeline.main --output sql --load-mode incremental --fast
  ```
- **Full refresh** — `ETL_SCHEDULE_FULL_CRON` (this environment: `0 2 * * *`, nightly at 2am) →
  enqueues `{loadMode:'full', outputMode:'sql'}`, equivalent to:
  ```
  python -m sales_pipeline.main --output sql --load-mode full
  ```

Either schedule can be disabled independently via `ETL_SCHEDULE_INCREMENTAL_ENABLED`/
`ETL_SCHEDULE_FULL_ENABLED` in `backend/.env` (both default `true`); changing the cron strings or
enabled flags requires restarting the `backend` process (schedules register once at startup).

To force a full reload regardless of `--load-mode`, add `--full-refresh` to either the CLI (§1) or
`extraArgs` on the Node side.

## 4. Required environment / config

Only **`data/etl/.env`** is needed to run the pipeline directly (copy from `data/etl/.env.example`
if it doesn't exist) — read by `Settings.from_env()` in `data/etl/config/settings.py`:

| Variable | Required for | Notes |
|---|---|---|
| `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_API_KEY` | always | Odoo connection; validation fails without these |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `--output sql`/`both`, or any incremental run | same MySQL instance the web app uses |
| `DB_RELOAD_MODE` | full-mode SQL writes | `drop_recreate` (default) or `truncate` |
| `INPUT_DIR` | always | directory containing `PRODUCTS.xlsx`/`OffDays.xlsx`/etc. — in this environment set to the **absolute** path `C:/Users/Lenovo/Desktop/07PREPORT/Input`, not `data/etl/Input` (there's a separate, unused legacy copy of the same filenames under `data/etl/Input/` — don't confuse the two) |
| `OUTPUT_DIR` | `--output excel`/`both` | defaults to `./Exports` (relative to `data/etl/`) |
| `TIMEZONE` | always | defaults `Africa/Tripoli` |

Running via `npm run etl:*` instead reads `backend/.env` for `ETL_API_URL`/`ETL_API_KEY`/schedule
config, and the Flask ETL API process (`data/etl/api/app.py`) reads `data/etl/.env` the same as a
direct CLI run does — see [etl-deployment.md](./etl-deployment.md#configuration) for how the two
`.env` files relate.

## 5. Where logs are written, and how to tail them

| Source | Location | What it contains |
|---|---|---|
| `run_pipeline.py` (§1a) | `data/etl/logs/pipeline_{mode}_{output}_{timestamp}.log` | Full raw stdout+stderr, unfiltered — every `Fetching <model> batch N/M` line, `PERF` breadcrumbs, warnings, the final `Pipeline runtime summary:`/`Output row counts:` block, and any traceback on failure. One file per manual `run_pipeline.py` invocation; **not** produced by direct `-m sales_pipeline.main` calls (§1b) or Admin UI/API-triggered runs. |
| Admin UI Control Center | Live: SSE stream (`GET /admin/etl/stream/:runId`); past runs: `GET /admin/etl/runs/:runId/log` | Same full per-line detail as the file above, persisted in BullMQ's job log — `backend/src/etl/jobs/runPipelineJob.ts` forwards every line (not a curated subset) so the Admin UI's log view matches the raw log file. |
| Node orchestration | `backend/logs/etl/etl.log` | A *different*, smaller log: job queued/started/finished, subprocess exit codes, scheduler ticks — the orchestration layer's own view, not per-line pipeline output. |
| MySQL run history | `pipeline_run_log` / `pipeline_run_audit` tables | Structured summary per run: start/end time, duration, extract/load/QA counts, status, error message, per-table row counts (JSON) — same data the Admin → ETL Runs page reads. |

**Tailing a `run_pipeline.py` log live while it runs:**

```powershell
Get-Content -Wait data\etl\logs\pipeline_full_sql_20260726_100000.log
```

```bash
tail -f data/etl/logs/pipeline_full_sql_20260726_100000.log
```

Output is block-buffered by the Python subprocess (nothing sets `PYTHONUNBUFFERED`), so expect
lines to appear in a few-KB bursts rather than truly line-by-line — a few seconds of lag on `tail
-f`/`Get-Content -Wait` is normal, not a hang.

**Tailing a queued/API-triggered run live**: open Admin → ETL Runs in the web app — the "Current
Status" panel streams the same full detail in real time (see the row in the table above).

## 6. Supporting services for the Admin UI / queued path (Redis, Flask ETL API, worker)

Everything above (§1-§5) is the direct-CLI path, which touches none of this. The **Admin UI's
"Start Run" buttons and the two cron schedules (§3)** go through a different path instead —
`enqueuePipelineRun()` → BullMQ (Redis) → `etl:worker` → the Flask ETL API → the same
`sales_pipeline.main` from §1b. All three of the following must be running, independently of the
main `backend`/`frontend` dev servers, or a queued run gets stuck or fails outright:

| Missing piece | Symptom |
|---|---|
| Redis | Admin UI shows "Queue unavailable"; `queue.add()` calls hang and then reject with `ETL queue add() timed out after 10000ms (queue unreachable)`; backend startup log shows `ETL reconciliation: queue is unreachable at startup, skipping` |
| `etl:worker` | Redis and enqueueing both work, but a run sits in `queued` forever — after ~10 minutes it's auto-failed with `No ETL worker was consuming the queue after this run sat 'queued' for over 10 minutes...` |
| Flask ETL API (`data/etl/api/app.py`) | Redis and the worker both work, but the job fails **immediately** on pickup (worker log shows `ETL run failed to start` right after `Job picked up by worker`, often with an unhelpfully empty error message since the underlying HTTP client's error didn't carry a `.message`) — the worker calls this API over HTTP for every run, it isn't optional even in local dev (see `pythonRunner.ts`) |

**Start Redis** (a single standalone container is enough for local dev — don't use
`docker compose up` for this alone, since that also builds/starts `backend`/`frontend`/`etl-api`
containers that would fight the host's own `npm run dev` processes for ports 3000/4000):
```bash
docker run -d --name redis-dev -p 6379:6379 redis:7-alpine
```
If Docker Desktop itself isn't running, start it first (Windows: launch `Docker Desktop.exe` and
wait for the engine — `docker info` — to respond; this can take 30-90 seconds). Verify:
```bash
docker exec redis-dev redis-cli ping   # expect PONG
```
Matches `backend/.env`'s `REDIS_HOST=localhost` / `REDIS_PORT=6379` for local dev (docker-compose's
`REDIS_HOST=redis` override only applies to the fully-containerized deployment path, not this one —
don't copy that value into local-dev `.env`).

**Start the Flask ETL API** (needs the same `data/etl/.venv` as §1, plus `data/etl/.env`'s
`ETL_API_KEY` to match `backend/.env`'s):
```bash
cd data/etl/api
../.venv/Scripts/python.exe app.py    # PORT defaults to 5001, matching ETL_API_URL in backend/.env
```

**Start the worker** (separate long-lived process, not started by `npm run dev`):
```bash
cd backend
npm run etl:worker
```

Once all three are up, BullMQ's own reconnect logic means you generally do **not** need to restart
the already-running `backend` process for it to notice Redis coming back — `queue.add()` recovers
on its own for the *next* enqueue (see `etlQueue.ts`'s own comment on this). The worker, once
started, immediately drains anything left `queued` from while it was down, including old jobs from
before Redis or the Flask API were reachable.

**Local dev startup order**, adding to §8 of `running-the-project.md`:
```bash
# Terminal 1
cd backend && npm run dev
# Terminal 2
cd frontend && npm run dev
# Terminal 3
docker run -d --name redis-dev -p 6379:6379 redis:7-alpine
# Terminal 4
cd data/etl/api && ../.venv/Scripts/python.exe app.py
# Terminal 5
cd backend && npm run etl:worker
```
