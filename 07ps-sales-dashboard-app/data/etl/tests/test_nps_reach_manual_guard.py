"""The approved manual NPS reach (process_nps_reach_manual, migration 0071) is written by migrations only: no ETL code --
the 30-minute refresh, the 02:00 full refresh, process_nps, the exporters, the ETL API -- may name the table, so nothing
can write to or truncate it. A job that needs it must be agreed first (and this test changed with it)."""

from __future__ import annotations

from pathlib import Path

ETL = Path(__file__).resolve().parents[1]
TABLE = "process_nps_reach_manual"


def test_no_etl_code_names_the_manual_reach_table():
    offenders = []
    for folder in ("src", "api", "scripts", "config"):
        root = ETL / folder
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.suffix not in {".py", ".json", ".yml", ".yaml", ".sql", ".toml"} or not path.is_file():
                continue
            if TABLE in path.read_text(encoding="utf-8", errors="ignore"):
                offenders.append(str(path.relative_to(ETL)))
    # the read-only reconciliation reads it (SELECT only) and is allowed
    assert [p for p in offenders if p.replace("\\", "/") != "scripts/process/check_nps_totals.py"] == []


def test_the_reconciliation_only_reads_it():
    script = (ETL / "scripts" / "process" / "check_nps_totals.py").read_text(encoding="utf-8")
    writes = ("INSERT", "UPDATE ", "DELETE", "TRUNCATE", "REPLACE INTO", "DROP", "ALTER")
    assert [line for line in script.splitlines() if TABLE in line and any(w in line.upper() for w in writes)] == []
