"""One-time backfill of product_stock_period_end (migration 0079): on hand per product + company at every period end the
SKU Trend shows (12 week ends, 12 month ends, 5 year ends: 28-29 dates). NOT part of the ETL: run it by hand, once, after 0079.
From then on the ETL keeps the new period ends itself (departments/sales/stock_period_end.py, source 'snapshot').

Odoo (read-only, the ETL's guarded client): for each period end D, ONE read_group on stock.valuation.layer --
create_date <= the end of D (Africa/Tripoli), grouped by product_id + company_id, sum of quantity. Aggregates only,
never raw layer rows. Valuation layers exist for storable products only: any other product has no row (= 0 on hand,
as on the Product Status cards, whose On Hand comes from stock quants).

Validation (always, before anything is written): the same aggregate up to the time of the warehouse's inventory
snapshot is compared with that snapshot's on hand (fact_sales_inventory_snapshot, the cards' On Hand), per product +
company with stock on either side. The match rate and the 20 biggest differences are printed; if more than 5% of them
differ, NOTHING is written and the script exits 2.

Writes (without --dry-run): an upsert per row (source 'backfill'); a 'snapshot' row the ETL stored is never overwritten.
Safe to re-run.

    python scripts/backfill_stock_period_end.py --dry-run      # row counts, timing, validation; writes nothing
    python scripts/backfill_stock_period_end.py                # validate, then upsert

Settings: the ETL's .env (ODOO_* incl. the production guard, DB_* / DB_URL).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import sys
import time
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ETL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL_ROOT))
sys.path.insert(0, str(ETL_ROOT / "src"))

from departments.sales.stock_period_end import SNAPSHOT_SELECT, TABLE, needed_period_ends  # noqa: E402
from sqlalchemy import create_engine, inspect, text  # noqa: E402

MODEL = "stock.valuation.layer"
MAX_DIFF_SHARE = 0.05
TOLERANCE = 0.01  # quantities differing by less than this are equal (rounding of the UoM)
ODOO_DT = "%Y-%m-%d %H:%M:%S"

UPSERT = text(f"""
INSERT INTO {TABLE} (product_id, company_id, period_end_date, qty_on_hand, source, loaded_at)
VALUES (:product_id, :company_id, :period_end_date, :qty_on_hand, 'backfill', :loaded_at)
ON DUPLICATE KEY UPDATE
  qty_on_hand = IF(source = 'snapshot', qty_on_hand, VALUES(qty_on_hand)),
  loaded_at = IF(source = 'snapshot', loaded_at, VALUES(loaded_at))
""")


def end_of_day_utc(day: _dt.date, tz: str) -> str:
    """The last second of ``day`` in the business time zone, as Odoo's UTC datetime string."""
    local = _dt.datetime.combine(day, _dt.time(23, 59, 59), tzinfo=ZoneInfo(tz))
    return local.astimezone(_dt.UTC).strftime(ODOO_DT)


def _m2o(value: Any) -> int | None:
    if isinstance(value, (list, tuple)) and value:
        return int(value[0])
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else None


def on_hand_at(client: Any, until_utc: str, company_ids: list[int]) -> dict[tuple[int, int], float]:
    """{(product_id, company_id): quantity} of every valuation layer created up to ``until_utc``: one read_group call."""
    groups = client.execute_kw(
        MODEL, "read_group", [[["create_date", "<=", until_utc]], ["quantity:sum"], ["product_id", "company_id"]],
        {"lazy": False, "context": {"allowed_company_ids": company_ids, "active_test": False}},
    )
    out: dict[tuple[int, int], float] = {}
    for g in groups:
        product, company = _m2o(g.get("product_id")), _m2o(g.get("company_id"))
        if product is not None and company is not None:
            out[(product, company)] = float(g.get("quantity") or 0.0)
    return out


def compare(layers: dict[tuple[int, int], float], snapshot: dict[tuple[int, int], float]) -> tuple[int, list[tuple[float, tuple[int, int], float, float]]]:
    """Products + companies with stock on either side, and the ones whose quantities differ (biggest first)."""
    keys = {k for k, v in layers.items() if abs(v) > TOLERANCE} | {k for k, v in snapshot.items() if abs(v) > TOLERANCE}
    diffs = []
    for k in keys:
        a, b = layers.get(k, 0.0), snapshot.get(k, 0.0)
        if abs(a - b) > TOLERANCE:
            diffs.append((abs(a - b), k, a, b))
    return len(keys), sorted(diffs, reverse=True)


def snapshot_on_hand(conn: Any) -> tuple[_dt.date, str | None, dict[tuple[int, int], float]]:
    """The warehouse's latest inventory snapshot (the cards' On Hand), the UTC start of the run that loaded it, and its
    on hand per product + company."""
    day = conn.execute(text("SELECT MAX(SnapshotDate) FROM fact_sales_inventory_snapshot")).scalar()
    if day is None:
        raise SystemExit("fact_sales_inventory_snapshot is empty: run the ETL once before the backfill")
    loaded = None
    try:
        loaded = conn.execute(text(
            "SELECT MAX(l.started_at_utc) FROM etl_run_log l JOIN (SELECT DISTINCT _run_id FROM fact_sales_inventory_snapshot "
            "WHERE SnapshotDate = :d) s ON s._run_id = l.run_uid"), {"d": day}).scalar()
    except Exception:  # noqa: BLE001 - etl_run_log may be missing on an old database: fall back to the end of that day
        loaded = None
    # the ETL step's own query (the snapshot's product + company through ProductCompanyKey: the cards' On Hand)
    rows = conn.execute(text(SNAPSHOT_SELECT), {"d": day}).fetchall()
    as_of = loaded.strftime(ODOO_DT) if isinstance(loaded, _dt.datetime) else None
    return day if isinstance(day, _dt.date) else _dt.date.fromisoformat(str(day)[:10]), as_of, {(int(p), int(c)): float(q) for p, c, q in rows}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="Read Odoo and the warehouse, print counts / timing / validation; write nothing")
    parser.add_argument("--today", default=None, help="Business date the trend windows end on (YYYY-MM-DD; default today)")
    parser.add_argument("--dates", default=None, help="Only these period ends (comma-separated YYYY-MM-DD) instead of the 29 the trend needs")
    args = parser.parse_args(argv)

    from etl_platform.config import PlatformConfig
    from etl_platform.sources.odoo import OdooSource

    config = PlatformConfig.from_env()
    tz = config.business_timezone
    today = _dt.date.fromisoformat(args.today) if args.today else _dt.datetime.now(ZoneInfo(tz)).date()
    dates = [_dt.date.fromisoformat(d.strip()) for d in args.dates.split(",")] if args.dates else needed_period_ends(today)

    engine = create_engine(config.database_url, future=True)
    source = OdooSource.connect(config)
    client = source.client
    company_ids = list(config.odoo_company_ids) or [int(c["id"]) for c in source.accessible_companies()]
    print(f"Odoo {config.odoo_url} ({source.server_version}), companies {company_ids}; {len(dates)} period end(s) "
          f"{dates[0]} .. {dates[-1]}; dry_run={args.dry_run}")

    # -- validation: the layers up to the snapshot's load time vs the snapshot's on hand ------------------------------------
    with engine.connect() as conn:
        snap_day, snap_loaded_utc, snapshot = snapshot_on_hand(conn)
    until = snap_loaded_utc or end_of_day_utc(snap_day, tz)
    started = time.perf_counter()
    layers_now = on_hand_at(client, until, company_ids)
    with_stock, diffs = compare(layers_now, snapshot)
    match_rate = 1 - len(diffs) / with_stock if with_stock else 1.0
    print(f"Validation vs fact_sales_inventory_snapshot {snap_day} (layers up to {until} UTC, {time.perf_counter() - started:.1f}s): "
          f"{with_stock:,} product+company with stock, {len(diffs):,} differ -> match rate {match_rate:.1%}")
    if diffs:
        print("  20 biggest differences (product_id, company_id: layers vs snapshot):")
        for gap, (product, company), a, b in diffs[:20]:
            print(f"    {product:>7} {company:>3}: {a:>14,.2f} vs {b:>14,.2f}  (diff {gap:,.2f})")
    passed = with_stock > 0 and len(diffs) / with_stock <= MAX_DIFF_SHARE

    # -- the period ends ------------------------------------------------------------------------------------------------------
    loaded_at = _dt.datetime.now(_dt.UTC).replace(tzinfo=None, microsecond=0)
    rows: list[dict[str, Any]] = []
    total_started = time.perf_counter()
    for d in dates:
        t = time.perf_counter()
        at = on_hand_at(client, end_of_day_utc(d, tz), company_ids)
        rows.extend({"product_id": p, "company_id": c, "period_end_date": d, "qty_on_hand": round(q, 6), "loaded_at": loaded_at}
                    for (p, c), q in at.items())
        print(f"  {d}: {len(at):>6,} product+company rows, {sum(1 for q in at.values() if q > TOLERANCE):>6,} with stock  ({time.perf_counter() - t:.1f}s)")
    print(f"{len(rows):,} rows for {len(dates)} period end(s) in {time.perf_counter() - total_started:.1f}s")

    if not passed:
        print(f"STOP: more than {MAX_DIFF_SHARE:.0%} of the products with stock differ from the warehouse snapshot -- nothing written.")
        return 2
    if args.dry_run:
        print("Dry run: validation passed, nothing written.")
        return 0
    with engine.begin() as conn:
        if not inspect(conn).has_table(TABLE):
            print(f"{TABLE} not found: apply migration 0079 first -- nothing written.")
            return 2
        for i in range(0, len(rows), 5000):
            conn.execute(UPSERT, rows[i:i + 5000])
    print(f"Upserted {len(rows):,} rows into {TABLE} (source 'backfill'; 'snapshot' rows kept).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
