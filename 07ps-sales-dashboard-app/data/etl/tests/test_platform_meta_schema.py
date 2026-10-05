"""The SQLAlchemy meta definitions and migration 0028 describe the same tables and columns, and the CLI
lists the registry."""

from __future__ import annotations

import re
from pathlib import Path

from etl_platform import meta
from etl_platform.run import main

WAREHOUSE = Path(__file__).resolve().parents[2] / "warehouse"


def _ddl_columns(sql: str, table: str) -> set[str]:
    body = re.search(rf"CREATE TABLE IF NOT EXISTS {table} \((.*?)\n\) ENGINE", sql, re.S).group(1)
    cols = set()
    for line in body.splitlines():
        m = re.match(r"\s+([a-z_]+)\s+[A-Z]", line)
        if m and m.group(1) not in {"index", "unique", "primary"}:
            cols.add(m.group(1))
    return cols


def test_migration_0028_matches_meta_definitions():
    sql = (WAREHOUSE / "migrations" / "0028_etl_platform_meta.sql").read_text(encoding="utf-8")
    for table in (meta.etl_task_log, meta.etl_dq_result, meta.etl_watermark, meta.etl_dataset_registry):
        assert _ddl_columns(sql, table.name) == {c.name for c in table.columns}, table.name
    for col in meta.REQUIRED_RUN_LOG_COLUMNS:
        assert f"ADD COLUMN {col} " in sql


def test_down_script_reverses_every_object():
    down = (WAREHOUSE / "down" / "0028_etl_platform_meta_down.sql").read_text(encoding="utf-8")
    for table in ("etl_task_log", "etl_dq_result", "etl_watermark", "etl_dataset_registry"):
        assert f"DROP TABLE IF EXISTS {table};" in down
    for col in meta.REQUIRED_RUN_LOG_COLUMNS:
        assert f"DROP COLUMN {col}" in down


def test_cli_list_and_unknown_job(capsys):
    assert main(["--list"]) == 0
    assert "platform_selfcheck" in capsys.readouterr().out
    assert main(["no_such_job"]) == 2


def test_down_0029_reverses_every_table_and_rename():
    up = (WAREHOUSE / "migrations" / "0029_core_dimensions.sql").read_text(encoding="utf-8")
    down = (WAREHOUSE / "down" / "0029_core_dimensions_down.sql").read_text(encoding="utf-8")
    created = set(re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", up))
    dropped = set(re.findall(r"\b((?:dim|map|raw)_\w+)", down.split("-- 4. legacy names back")[0]))
    assert created <= dropped, sorted(created - dropped)
    renamed = re.findall(r"RENAME TABLE (\w+) TO (zz_legacy_\w+)", up)
    assert renamed and all(f"RENAME TABLE {new} TO {old}" in down for old, new in renamed)
    # every stored-key update has its reverse
    for table, col, after, before in re.findall(r"UPDATE (\w+) SET (\w+) = (-?\d+) WHERE \2 = (-?\d+)", up):
        assert f"UPDATE {table} SET {col} = {before} WHERE {col} = {after}" in down, (table, col)
