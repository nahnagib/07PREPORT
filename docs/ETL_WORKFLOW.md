# ETL Workflow

This is a repo-level summary. The authoritative, verified command reference is
[`07ps-sales-dashboard-app/docs/running-the-project.md`](../07ps-sales-dashboard-app/docs/running-the-project.md#3-running-the-etl)
(§3–§7), and the integration/architecture explanation is
[`07ps-sales-dashboard-app/docs/etl-deployment.md`](../07ps-sales-dashboard-app/docs/etl-deployment.md).

## Sources → Destination

- **Odoo ERP** (XML-RPC) — sales/invoice transactional data.
- **Reference Excel workbooks** (committed at [`Input/`](../Input/)) — sales team roster, targets,
  products, off-days calendar, blocked customers.
- **Destination**: the MySQL 8 warehouse (`data/warehouse/`), and/or an Excel export
  (`SalesModel_OneOutput.xlsx`), depending on mode.

## Modes

| Command | What it does | Redis/worker needed? |
|---|---|---|
| `npm run etl:full -- --sync` | Full rebuild from a complete Odoo extract | No |
| `npm run etl:incremental -- --sync` | Only records changed since the last successful run | No |
| `npm run etl:sql -- --sync` | Incremental, MySQL only, with full QA validation | No |
| `npm run etl:excel -- --sync` | Full Odoo extract → Excel workbook only, no MySQL writes | No |

Every mode above can also run **without** `--sync`, which enqueues the job on Redis instead of
running inline — in that case a running `npm run etl:worker` process is required to pick it up.

## Scheduler

The backend registers two cron schedules at startup (`backend/src/server.ts`):

- **Incremental** — `ETL_SCHEDULE_INCREMENTAL_CRON` (default: several times/day)
- **Full refresh** — `ETL_SCHEDULE_FULL_CRON` (default: nightly)

The scheduler only enqueues jobs on a timer — it never executes the pipeline itself. A reachable
Redis instance and a running `npm run etl:worker` process are both required for scheduled jobs to
actually run.

## Execution: the ETL Flask API

`etl:worker` doesn't spawn the Python pipeline directly — it calls a separate Flask API
(`data/etl/api/`, `pythonRunner.ts` in the backend) over HTTP: `POST /etl/run` starts a run in the
background and returns a job id immediately, `GET /etl/jobs/<id>` is polled for new log lines and
the final status, and `POST /etl/jobs/<id>/cancel` backs the Control Center's Cancel button. This
split means only the `etl-api` container needs Python + the pipeline's dependencies installed —
`etl-worker` is a plain Node image. See
[`07ps-sales-dashboard-app/docs/etl-deployment.md`](../07ps-sales-dashboard-app/docs/etl-deployment.md#the-flask-etl-api).

## Monitoring

- **In-app**: Admin → ETL Runs (`GET /admin/etl-runs/log` / `/audit`) — per-run status, duration,
  extract/load/QA counts, and error messages, written directly by the pipeline into
  `pipeline_run_log` / `pipeline_run_audit`.
- **Orchestration log**: `backend/logs/etl/etl.log` — job queued/started/failed/retrying,
  subprocess exit codes (separate from the pipeline's own MySQL run history).

## Error Handling

- Redis being unreachable logs an error but does not crash the API — the web app keeps running
  even if scheduled ETL execution is currently broken.
- Each run's failure reason (if any) is recorded in `pipeline_run_log` and visible in Admin → ETL
  Runs.

## Reference Input Files

See the [root README](../README.md#reference-input-files) for which Excel files under
[`Input/`](../Input/) are required templates versus which paths are generated/runtime-only and
therefore git-ignored (`data/etl/Input/`, `data/etl/Exports/`).
