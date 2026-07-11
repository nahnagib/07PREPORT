"""MySQL connection helper for the measures layer.

Deliberately the same env-var contract as data/ingestion/orchestrator.py's _db_connect() (DB_HOST/
DB_PORT/DB_USER/DB_PASSWORD/DB_NAME/DB_SOCKET) rather than a second, different set of variable
names for the same warehouse -- one connection convention for the whole project.

Note: the Node/Express backend (backend/src/db/pool.ts) currently uses `pg` (node-postgres) and a
Postgres-specific Row-Level-Security scaffold (backend/src/middleware/rlsContext.ts, referencing a
migration file that is now a deprecated no-op stub -- see
data/warehouse/migrations/0007_rls_policies.sql). That predates the project's move to MySQL 8
(docs/tech-stack-decision.md) and was not touched in this session (out of scope: this session is
measures/validation only, no platform-shell changes). Flagging again here because it directly
affects where this module's queries eventually get called from: Phase P3 needs to either swap the
backend to a MySQL client (e.g. mysql2) or otherwise resolve the driver mismatch before these
functions can be wired into a real endpoint. The SQL and business logic in this package don't
depend on that decision either way.
"""

from __future__ import annotations

import os
import pymysql
import pymysql.cursors


def get_connection() -> pymysql.connections.Connection:
    return pymysql.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ.get("DB_USER", "root"),
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ.get("DB_NAME", "ps_warehouse"),
        unix_socket=os.environ.get("DB_SOCKET") or None,
        autocommit=True,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
    )
