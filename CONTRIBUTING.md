# Contributing

Thanks for looking at this project. This doc covers code style, testing, and the PR process. For
the full, verified local setup (every command, expected output, common gotchas), see
[`07ps-sales-dashboard-app/docs/running-the-project.md`](07ps-sales-dashboard-app/docs/running-the-project.md)
— that's the authoritative source; this file won't repeat it.

## Quick Start

```bash
cd 07ps-sales-dashboard-app
npm install                                # installs frontend, backend, packages/ui (npm workspaces)
cp backend/.env.example backend/.env       # fill in DB_*/JWT_SECRET/ODOO_*/REDIS_* — see comments
npm run dev                                # backend :4000 + frontend :3000, concurrently
```

That gets the web app running against an empty (schema-only) database. To also run the ETL
pipeline, see [Reference Input Files](README.md#reference-input-files) and
[ETL Workflow](README.md#etl-workflow) in the root README first — a fresh clone can't run any
`etl:*` command until the Python venv and reference Excel files are in place.

## Project Layout

This is a two-level repo: `07PREPORT/` (this level — repo-wide docs, reference Excel templates,
brand assets) and `07ps-sales-dashboard-app/` (the actual application — frontend, backend, ETL,
warehouse). Most day-to-day development happens inside the app folder. See the root
[README's Repository Layout](README.md#repository-layout) for the full tree.

## Code Style

- **TypeScript** (`frontend/`, `backend/`): ESLint + Prettier. Run `npm run lint` and
  `npm run format` from `07ps-sales-dashboard-app/` (root workspace scripts — they apply across
  `frontend`/`backend`/`packages/ui` via `--workspaces`).
- **Python** (`data/etl/`, `data/ingestion/`): match the existing style in the file you're editing.
  Vendored code under `data/etl/src/` and `data/etl/vendor/`-equivalent paths should be treated as
  **read-only** — see the note in [Vendored Code](#vendored-code-dont-modify) below.
- Default to **no comments** unless something is genuinely non-obvious (a hidden constraint, a
  workaround, a subtle invariant) — don't explain what code already says through naming.
- Don't add abstractions, config flags, or error handling for cases that can't happen. Match the
  existing codebase's habit of explaining *why*, not *what*, in the comments that do exist.

## Vendored Code — Don't Modify

`data/etl/src/sales_pipeline/` is vendored, unmodified, from a standalone project — see
`data/etl/README.md`. **Do not edit files under this tree directly**, even for small fixes.
If a vendored file has a bug or needs a config/env value it can't resolve, the standard pattern
this repo already uses is a small compatibility shim in the *integration* layer above it (e.g. a
`sys.modules` alias, a path-injection module) — not a hand-edit to the vendored file itself. If
you're unsure whether a file counts as vendored, check its own header comment first.

## Testing

```bash
# TypeScript (backend) - vitest, colocated in __tests__/ folders next to the source
cd backend && npm run test

# TypeScript build check (no emit errors)
cd 07ps-sales-dashboard-app && npm run build

# Python (ETL Flask API)
cd data/etl/api && python -m pytest tests/ -v

# Python (mocked-Odoo ingestion sandbox)
cd data/ingestion && python -m pytest tests/ -v
```

New tests should follow the existing convention: mock external dependencies (axios, subprocess,
the real MySQL connection) so the suite never makes a real network call, spawns a real process, or
needs real credentials to pass. See `backend/src/etl/services/__tests__/pythonRunner.test.ts` or
`data/etl/api/tests/test_app.py` for the pattern.

**Before submitting a change that touches runtime behavior** (not just tests/docs/types), verify it
actually works — run the dev servers, exercise the affected page/endpoint, and if it's a Docker or
deployment change, at minimum run `docker compose config` to confirm the compose file still parses.
A green test suite and a clean `npm run build` are necessary but not sufficient on their own.

## Git Workflow

- Branch from `main`; open a PR back into `main`.
- Keep commits focused — one logical change per commit, with a message explaining *why*, not just
  *what* changed (the diff already shows what).
- Don't commit `.env` files, build artifacts (`dist/`, `.next/`), or anything under `data/etl/Input/`
  / `data/etl/Exports/` (runtime-only, git-ignored) — see the root [`.gitignore`](.gitignore).
- If your change affects deployment (Dockerfiles, `docker-compose.yml`, `docker/nginx.conf`, env
  var names), update the relevant doc in the same PR — `docs/DEPLOYMENT.md`,
  `07ps-sales-dashboard-app/docs/vps-deployment.md`, or `07ps-sales-dashboard-app/docs/etl-deployment.md`.

## Pull Request Checklist

- [ ] `npm run lint` and `npm run build` pass (from `07ps-sales-dashboard-app/`)
- [ ] `npm run test` passes (from `backend/`); Python tests pass if you touched `data/etl/api/` or
      `data/ingestion/`
- [ ] New/changed runtime behavior was actually exercised, not just unit-tested in isolation
- [ ] Docs updated if the change affects setup, deployment, or the ETL workflow
- [ ] No real credentials, API keys, or `.env` files included in the diff

## Reporting Issues

Open a GitHub issue with: what you expected, what happened instead, and how to reproduce it
(commands run, relevant log output — redact any credentials first). For deployment issues, include
which environment (local dev vs. VPS/Docker) and see
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) first in case it's already covered.
