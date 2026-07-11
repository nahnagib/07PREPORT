#!/usr/bin/env bash
# DEPRECATED / Postgres-era (psql, DATABASE_URL) - stale since the MySQL correction to
# docs/tech-stack-decision.md. Kept for git history, per "replace, don't silently disappear".
# Use apply_migrations.py instead (mysql-native, works from PowerShell too - no `mysql` CLI or
# `psql` needed, just `pip install pymysql`).
#
# Original Postgres-era content below, left as-is (not functional against MySQL - seed.sql also
# references dim_business_unit/dim_branch, which don't exist in the MySQL schema):
#
# Applies migrations (and optionally the sample seed) to $DATABASE_URL in order.
# Usage: DATABASE_URL=postgres://... ./apply_migrations.sh [--seed]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Set DATABASE_URL first, e.g. postgres://ps_admin:pw@localhost:5432/ps_warehouse" >&2
  exit 1
fi

for f in "$DIR"/migrations/*.sql; do
  echo "Applying $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

if [ "${1:-}" = "--seed" ]; then
  echo "Applying seed data"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DIR/seed/seed.sql"
fi

echo "Done."
