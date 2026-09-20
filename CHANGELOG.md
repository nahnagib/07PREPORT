# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). This project doesn't tag
releases yet (still pre-1.0, Phase 1 of the migration plan) — entries are grouped by what's
actually landed in git history plus what's currently uncommitted.

## [Unreleased]

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
