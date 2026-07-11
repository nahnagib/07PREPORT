# Deployment Overview

This is a repo-level summary. The authoritative, detailed deployment/operations doc is
[`07ps-sales-dashboard-app/docs/etl-deployment.md`](../07ps-sales-dashboard-app/docs/etl-deployment.md).

## Target Environment

- **Host**: Libyan Spider VPS (root access).
- **Orchestration**: Docker Compose (`07ps-sales-dashboard-app/docker-compose.yml`) — `frontend`,
  `backend` (API + ETL scheduler), `redis`, `etl-worker`, `ingestion`, behind Nginx/TLS.
- **Database**: an existing MySQL 8 instance — **not** containerized as part of this stack.

The compose file was intentionally left inside `07ps-sales-dashboard-app/` (not moved to a
top-level `deployment/` folder) because its build contexts (`context: .`) are relative to that
folder — moving it without updating every `Dockerfile`/context path would risk breaking the build.

## Quick Deploy

```bash
git clone <this repo> && cd 07PREPORT/07ps-sales-dashboard-app
cp backend/.env.example backend/.env       # fill in real DB/JWT/SMTP/Odoo values
cp data/ingestion/.env.example data/ingestion/.env
docker compose up -d --build
```

## Things That Commonly Differ Between Local Dev and Production

- `REDIS_HOST` must be `redis` (the compose service name) under Docker Compose, not `localhost`.
- `DB_HOST=localhost` will not resolve from inside a container if MySQL runs on the same host as
  the containers — use `host.docker.internal` (with the matching `extra_hosts` entry) or the
  host's real reachable address instead.

## Operating the System

- **Check ETL run history**: Admin → ETL Runs in the web app, or `GET /admin/etl-runs/log`.
- **Trigger a manual ETL run**: `docker compose exec backend npm run etl:run` (or `-- --full`).
- **Change the ETL schedule**: edit `ETL_SCHEDULE_INCREMENTAL_CRON` / `ETL_SCHEDULE_FULL_CRON` in
  `backend/.env` and restart the `backend` service.
- **Troubleshoot**: Admin → ETL Runs first (pipeline-level errors/counts), then
  `docker compose logs etl-worker` (orchestration-level: job/queue/retry/exit-code detail).

## Before You Deploy — Security Checklist

- [ ] `backend/.env` and `data/ingestion/.env` contain **real, freshly-rotated** credentials (not
      values that were ever pasted into a chat, ticket, or the archived notes under
      [`docs/archive/`](archive/)).
- [ ] `.env` files are not committed (verify: `git status` shows none, `git check-ignore -v
      backend/.env` reports a match).
- [ ] TLS/Nginx is configured in front of the `frontend`/`backend` containers.
- [ ] `NODE_ENV=production` (disables any dev-only auth shortcuts).

Full details: [`07ps-sales-dashboard-app/docs/etl-deployment.md`](../07ps-sales-dashboard-app/docs/etl-deployment.md).
