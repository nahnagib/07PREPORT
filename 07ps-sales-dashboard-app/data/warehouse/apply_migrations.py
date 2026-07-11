"""Applies every MySQL migration in data/warehouse/migrations/ (in filename order) to the
database named by DB_* env vars - a Windows/PowerShell-friendly, mysql-CLI-free alternative to
apply_migrations.sh (which is a leftover Postgres/psql script - see that file's own header).

Safe to run against a fresh database: the deprecated Postgres-era stub files in that folder
(0002_facts.sql, 0003_target_plan_fact.sql, 0004_calendar_and_metadata.sql,
0005_customer_status_scd2.sql, 0006_rbac_manifest.sql, 0007_rls_policies.sql) are pure SQL
comments with nothing executable in them - see data/warehouse/README.md's "Migration files" table
for which 8 files are the real ones. Running the whole folder in sorted order is deliberate: it
avoids the user having to hand-type 8 exact filenames in a shell that doesn't support `<`
redirection (PowerShell).

Usage (from the repo root, after `pip install pymysql`):
    python data/warehouse/apply_migrations.py
Reads the same DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME/DB_SOCKET vars as backend/.env and
data/ingestion/.env. Creates the database if it doesn't exist yet.
"""
from __future__ import annotations

import glob
import os
import sys

import pymysql
from pymysql.constants import CLIENT


def main():
    host = os.environ.get("DB_HOST", "localhost")
    port = int(os.environ.get("DB_PORT", "3306"))
    user = os.environ.get("DB_USER", "root")
    password = os.environ.get("DB_PASSWORD", "")
    db_name = os.environ.get("DB_NAME", "ps_warehouse")
    socket = os.environ.get("DB_SOCKET") or None

    # Connect without a default database first, so we can CREATE DATABASE IF NOT EXISTS.
    conn = pymysql.connect(
        host=host, port=port, user=user, password=password, unix_socket=socket,
        client_flag=CLIENT.MULTI_STATEMENTS,
    )
    with conn.cursor() as cur:
        cur.execute(f"CREATE DATABASE IF NOT EXISTS `{db_name}`")
    conn.select_db(db_name)

    migrations_dir = os.path.join(os.path.dirname(__file__), "migrations")
    files = sorted(glob.glob(os.path.join(migrations_dir, "*.sql")))
    if not files:
        raise SystemExit(f"No .sql files found in {migrations_dir}")

    for path in files:
        name = os.path.basename(path)
        sql = open(path, encoding="utf-8").read()
        print(f"Applying {name} ...", end=" ")
        with conn.cursor() as cur:
            cur.execute(sql)
            # Drain any additional result sets from multi-statement files.
            while cur.nextset():
                pass
        conn.commit()
        print("done")

    conn.close()
    print(f"\nAll migrations applied to `{db_name}`.")


if __name__ == "__main__":
    main()
