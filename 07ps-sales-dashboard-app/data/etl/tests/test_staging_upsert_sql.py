from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy.dialects import mysql, postgresql

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sales_pipeline.staging import StagingStore  # noqa: E402


class DummyEngine:
    def __init__(self, dialect):
        self.dialect = dialect


def store_for(dialect):
    store = StagingStore.__new__(StagingStore)
    store.engine = DummyEngine(dialect)
    return store


def normalize_sql(sql: str) -> str:
    return " ".join(sql.split())


def test_postgres_upsert_uses_on_conflict_and_excluded():
    sql = normalize_sql(
        store_for(postgresql.dialect())._build_upsert_sql(
            '"raw_sale_order"',
            '"tmp_raw_sale_order"',
            ["id", "name", "write_date"],
            "id",
        )
    )

    assert 'ON CONFLICT ("id") DO UPDATE SET' in sql
    assert '"name" = EXCLUDED."name"' in sql
    assert '"write_date" = EXCLUDED."write_date"' in sql


def test_mysql_upsert_uses_on_duplicate_key_and_values():
    sql = normalize_sql(
        store_for(mysql.dialect())._build_upsert_sql(
            "`raw_sale_order`",
            "`tmp_raw_sale_order`",
            ["id", "name", "write_date"],
            "id",
        )
    )

    assert "ON DUPLICATE KEY UPDATE" in sql
    assert "`name` = VALUES(`name`)" in sql
    assert "`write_date` = VALUES(`write_date`)" in sql
