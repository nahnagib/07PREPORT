"""Backfill historical collection invoice dates, without changing payments or writing to Odoo.

Apply migration 0045 first. Run with --apply to load the missing invoice dates from the
existing guarded read-only Odoo source. Without --apply, report the missing count only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for path in (ROOT, ROOT / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from sqlalchemy import create_engine, text

from departments.finance.collections import INVOICE_DATES, collection_invoice_dates
from departments.finance.jobs import PROFILE
from etl_platform.config import PlatformConfig
from etl_platform.load import upsert
from etl_platform.sources.odoo import OdooConfigError, OdooCredentials, OdooSource
from check_receivable_totals import scoped_company_ids

MISSING_SQL = f"""SELECT DISTINCT m.move_id FROM fact_finance_collection_invoice m
 LEFT JOIN {INVOICE_DATES} d ON d.move_id = m.move_id
 WHERE m.move_type IN ('out_invoice', 'out_receipt') AND d.invoice_date IS NULL
 ORDER BY m.move_id"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    config = PlatformConfig.from_env()
    engine = create_engine(config.database_url)
    with engine.connect() as conn:
        ids = [int(r[0]) for r in conn.execute(text(MISSING_SQL))]
    print(f"Historical invoice dates missing: {len(ids)}", flush=True)
    if not args.apply or not ids:
        engine.dispose()
        return 0
    try:
        OdooCredentials.from_env(PROFILE)
        profile = PROFILE
    except OdooConfigError:
        profile = "default"
    source = OdooSource.connect(config, profile)
    scoped_company_ids(config, source)
    loaded = 0
    for offset in range(0, len(ids), source.id_chunk_size):
        moves = source.read_by_ids("account.move", ids[offset:offset + source.id_chunk_size], ["id", "move_type", "invoice_date"])
        dates = collection_invoice_dates({int(m["id"]): m for m in moves})
        dates = dates[dates["invoice_date"].notna()]
        if not dates.empty:
            with engine.begin() as conn:
                loaded += upsert(conn, INVOICE_DATES, dates.assign(updated_at_utc=dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)))
        if offset % 5000 == 0 or offset + source.id_chunk_size >= len(ids):
            print(f"Read {min(offset + source.id_chunk_size, len(ids))}/{len(ids)}; dates loaded: {loaded}", flush=True)
    with engine.connect() as conn:
        missing = len(conn.execute(text(MISSING_SQL)).fetchall())
    engine.dispose()
    print(f"Dates loaded: {loaded}; still missing: {missing}", flush=True)
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
