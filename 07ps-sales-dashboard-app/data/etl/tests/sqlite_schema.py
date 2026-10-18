"""Builds the tables of a MySQL migration in SQLite, for tests and local dry runs.

Only the parts the tests need are translated: CREATE TABLE IF NOT EXISTS blocks (column comments, secondary
indexes and table options dropped; UNIQUE KEY kept as UNIQUE), the INSERT IGNORE seed rows (skipped when their table
is not in the test database, e.g. the RBAC tables), and the idempotent ``ALTER TABLE ... ADD COLUMN`` of a prepared
statement (applied when the table exists and lacks the column). Everything else in the file (views, renames, data
migration) is MySQL-only and skipped. Because the real migration text is parsed, a column the code writes but the
migration lacks fails the test.
"""

from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

MIGRATIONS = Path(__file__).resolve().parents[2] / "warehouse" / "migrations"

_COMMENT = re.compile(r"\s+COMMENT\s+'(?:[^']|'')*'")
_CREATE = re.compile(r"CREATE TABLE IF NOT EXISTS (\w+) \((.*?)\n\)\s*ENGINE[^;]*;", re.S)
_SEED = re.compile(r"INSERT IGNORE INTO (?:[^';]|'(?:[^']|'')*')*;", re.S)
_SEED_TABLE = re.compile(r"INSERT OR IGNORE INTO (\w+)")
# 'ALTER TABLE t ADD COLUMN c TYPE ... [COMMENT ''...''] [AFTER x]' inside a SET @s = (SELECT IF(...)) prepared statement
_ADD_COLUMN = re.compile(r"'ALTER TABLE (\w+) ADD COLUMN (\w+) ((?:[^']|'')+)'")


def _strip_comments(sql: str) -> str:
    return "\n".join(line for line in sql.splitlines() if not line.strip().startswith("--"))


def sqlite_statements(migration: str) -> list[str]:
    sql = _strip_comments((MIGRATIONS / migration).read_text(encoding="utf-8"))
    out = []
    for name, body in _CREATE.findall(sql):
        cols = []
        for part in re.split(r",\s*\n", body):
            part = _COMMENT.sub("", part.strip()).rstrip(",")
            if not part or re.match(r"(INDEX|KEY)\s", part):
                continue
            part = re.sub(r"^UNIQUE KEY \w+ ", "UNIQUE ", part)
            part = re.sub(r"\b(\w+)\s+BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY", r"\1 INTEGER PRIMARY KEY AUTOINCREMENT", part)
            part = re.sub(r"\(\s*(\w+)\(\d+\)\s*\)", r"(\1)", part)  # prefix index columns
            # several meta columns can share one line in the DDL ("_extracted_at ..., _run_id ...")
            part = part.replace("TINYINT(1)", "INTEGER")  # SQLite cannot reflect TINYINT(1)
            cols.extend(p.strip() for p in re.split(r",\s+(?=_\w+ )", part))
        out.append(f"CREATE TABLE IF NOT EXISTS {name} (\n  " + ",\n  ".join(cols) + "\n)")
    for seed in _SEED.findall(sql):
        out.append(seed.replace("INSERT IGNORE INTO", "INSERT OR IGNORE INTO").replace("@now", "CURRENT_TIMESTAMP").rstrip(";"))
    return out


def sqlite_add_columns(migration: str) -> list[tuple[str, str, str]]:
    """(table, column, SQLite column definition) for every prepared ``ADD COLUMN`` of the migration."""
    sql = _strip_comments((MIGRATIONS / migration).read_text(encoding="utf-8"))
    out = []
    for table, column, definition in _ADD_COLUMN.findall(sql):
        definition = re.sub(r"\s+COMMENT\s+''(?:[^']|'''')*''", "", definition)
        definition = re.sub(r"\s+AFTER\s+\w+\s*$", "", definition).replace("''", "'").replace("TINYINT(1)", "INTEGER")
        out.append((table, column, definition.strip()))
    return out


def apply_migration_sqlite(engine: Engine, migration: str) -> None:
    with engine.begin() as conn:
        tables = set(inspect(conn).get_table_names())
        for stmt in sqlite_statements(migration):
            target = _SEED_TABLE.match(stmt)
            if target and target.group(1) not in tables:
                continue  # a seed for a table the test database does not have (e.g. RBAC pages/permissions)
            conn.execute(text(stmt))
            if stmt.startswith("CREATE TABLE"):
                tables.add(stmt.split()[5])
        for table, column, definition in sqlite_add_columns(migration):
            if table in tables and column not in {c["name"] for c in inspect(conn).get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {definition}"))
