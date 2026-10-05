"""Comparison window for the Phase 4 regression: which records existed, unchanged, when the baseline was taken.

  python scripts/regression/window.py --prefix zz_baseline_ --out <dir>

The baseline tables (``<prefix>raw_sale_order``, ``raw_sale_order_line``, ``raw_stock_picking``, ``raw_crm_lead``,
restored from the pre-rebuild dump) hold every record's ``write_date`` as the legacy ETL last saw it. Odoo is read
(read-only, GuardedOdooClient) for the current ``create_date`` / ``write_date`` of the same models, and each record is:

  window     in the baseline and unchanged since (same write_date; for an order also the same lines, each unchanged)
  modified   in the baseline but changed in Odoo after it
  new        not in the baseline (created after it, or created before it but never loaded: ``created_before``)
  deleted    in the baseline but no longer in Odoo

Facts and their record ids (baseline.WINDOW_ID):
  sales_lines, orders, sales_documents   order id         window = order in window
  deliveries                             PICK-<picking>   picking in window and its sale order (if any) in window
  leads                                  lead id / ETL-LEAD-<opportunity id>   lead in window, no order of it outside
  opportunities                          opportunity id   same as leads

Writes table zz_regression_window (fact, record_id) -- the only database write -- plus <out>/window.json.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT, ROOT / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from config.settings import Settings  # noqa: E402

from baseline import WINDOW_TABLE  # noqa: E402

COMPANIES = [1, 3]


def _odoo():
    from etl_platform.config import PlatformConfig
    from etl_platform.sources.odoo import OdooSource

    return OdooSource.connect(PlatformConfig.from_env(None), "default")


def _m2o(v):
    return v[0] if isinstance(v, (list, tuple)) and v else (None if v in (False, None) else v)


def current_state(src) -> dict[str, pd.DataFrame]:
    dom = [("company_id", "in", COMPANIES)]
    orders = src.search_read_all("sale.order", dom, ["id", "create_date", "write_date", "opportunity_id"])
    lines = src.search_read_all("sale.order.line", dom, ["id", "order_id", "write_date"])
    picks = src.search_read_all("stock.picking", dom, ["id", "create_date", "write_date", "sale_id"])
    leads = src.search_read_all("crm.lead", dom, ["id", "create_date", "write_date"], include_archived=True)
    df = pd.DataFrame
    return {
        "orders": df([{"id": r["id"], "create_date": r["create_date"], "write_date": r["write_date"],
                       "opportunity_id": _m2o(r.get("opportunity_id"))} for r in orders]),
        "lines": df([{"id": r["id"], "order_id": _m2o(r["order_id"]), "write_date": r["write_date"]} for r in lines]),
        "picks": df([{"id": r["id"], "create_date": r["create_date"], "write_date": r["write_date"], "sale_id": _m2o(r.get("sale_id"))} for r in picks]),
        "leads": df([{"id": r["id"], "create_date": r["create_date"], "write_date": r["write_date"]} for r in leads]),
    }


def baseline_state(conn, prefix: str) -> dict[str, pd.DataFrame]:
    q = lambda sql: pd.read_sql(text(sql.format(p=prefix)), conn)  # noqa: E731
    return {
        "orders": q("SELECT id, create_date, write_date, opportunity_id_id AS opportunity_id FROM {p}raw_sale_order"),
        "lines": q("SELECT id, order_id_id AS order_id, write_date FROM {p}raw_sale_order_line"),
        "picks": q("SELECT id, create_date, write_date, sale_id_id AS sale_id FROM {p}raw_stock_picking"),
        "leads": q("SELECT id, create_date, write_date FROM {p}raw_crm_lead"),
    }


def classify(base: pd.DataFrame, cur: pd.DataFrame, cutoff: str) -> dict[str, set[int]]:
    b = dict(zip(base["id"].astype(int), base["write_date"].astype(str)))
    c = dict(zip(cur["id"].astype(int), cur["write_date"].astype(str)))
    created = dict(zip(cur["id"].astype(int), cur.get("create_date", pd.Series(dtype=str)).astype(str))) if "create_date" in cur else {}
    new = set(c) - set(b)
    return {"window": {i for i in set(b) & set(c) if b[i] == c[i]},
            "modified": {i for i in set(b) & set(c) if b[i] != c[i]},
            "new": new,
            "created_before": {i for i in new if created.get(i, "9999") <= cutoff},
            "deleted": set(b) - set(c)}


def order_classes(base, cur, cutoff) -> dict[str, set[int]]:
    cls = classify(base["orders"], cur["orders"], cutoff)
    # an order is unchanged only if its set of lines and every line's write_date are unchanged
    bl = base["lines"].assign(write_date=base["lines"]["write_date"].astype(str)).groupby("order_id").apply(
        lambda g: tuple(sorted(zip(g["id"].astype(int), g["write_date"]))), include_groups=False)
    cl = cur["lines"].assign(write_date=cur["lines"]["write_date"].astype(str)).groupby("order_id").apply(
        lambda g: tuple(sorted(zip(g["id"].astype(int), g["write_date"]))), include_groups=False)
    bl, cl = bl.to_dict(), cl.to_dict()
    lines_changed = {o for o in cls["window"] if bl.get(o, ()) != cl.get(o, ())}
    cls["window"] -= lines_changed
    cls["modified"] |= lines_changed
    cls["lines_changed_only"] = lines_changed
    return cls


def build(conn, prefix: str, cur: dict[str, pd.DataFrame]) -> tuple[dict[str, set[str]], dict]:
    base = baseline_state(conn, prefix)
    cutoff = max(str(base[k]["write_date"].max()) for k in base)  # newest change the baseline had seen
    orders = order_classes(base, cur, cutoff)
    picks = classify(base["picks"], cur["picks"], cutoff)
    leads = classify(base["leads"], cur["leads"], cutoff)
    sale_of_pick = {int(i): (None if pd.isna(s) else int(s)) for i, s in zip(cur["picks"]["id"], cur["picks"]["sale_id"])}
    orders_of_opp = defaultdict(set)
    for oid, opp in zip(cur["orders"]["id"], cur["orders"]["opportunity_id"]):
        if opp is not None and not pd.isna(opp):
            orders_of_opp[int(opp)].add(int(oid))
    leads_ok = {lid for lid in leads["window"] if orders_of_opp.get(lid, set()) <= orders["window"]}
    pick_ok = {p for p in picks["window"] if sale_of_pick.get(p) is None or sale_of_pick[p] in orders["window"]}
    window = {
        "sales_lines": {str(o) for o in orders["window"]},
        "orders": {str(o) for o in orders["window"]},
        "sales_documents": {str(o) for o in orders["window"]},
        "deliveries": {f"PICK-{p}" for p in pick_ok},
        "leads": {str(i) for i in leads_ok} | {f"ETL-LEAD-{i}" for i in leads_ok},
        "opportunities": {str(i) for i in leads_ok},
    }
    summary = {"baseline_cutoff_write_date_utc": cutoff,
               "orders": {k: len(v) for k, v in orders.items()}, "pickings": {k: len(v) for k, v in picks.items()},
               "leads": {k: len(v) for k, v in leads.items()},
               "leads_excluded_for_linked_orders": len(leads["window"] - leads_ok),
               "pickings_excluded_for_sale_order": len(picks["window"] - pick_ok)}
    classes = {"orders": orders, "pickings": picks, "leads": leads}
    return window, {"summary": summary, "classes": {m: {k: sorted(v) for k, v in c.items()} for m, c in classes.items()}}


def write_window(engine, window: dict[str, set[str]]) -> int:
    rows = [{"fact": f, "record_id": r} for f, ids in window.items() for r in ids]
    with engine.begin() as conn:
        conn.execute(text(f"DROP TABLE IF EXISTS {WINDOW_TABLE}"))
        conn.execute(text(f"CREATE TABLE {WINDOW_TABLE} (fact VARCHAR(32) NOT NULL, record_id VARCHAR(64) NOT NULL, "
                          "PRIMARY KEY (fact, record_id)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"))
        for i in range(0, len(rows), 5000):
            conn.execute(text(f"INSERT INTO {WINDOW_TABLE} (fact, record_id) VALUES (:fact, :record_id)"), rows[i:i + 5000])
    return len(rows)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", default="zz_baseline_")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    engine = create_engine(Settings.from_env(None).sqlalchemy_url, future=True)
    src = _odoo()  # connect() opens and authenticates
    cur = current_state(src)
    with engine.connect() as conn:
        window, detail = build(conn, args.prefix, cur)
    n = write_window(engine, window)
    detail["summary"]["window_rows"] = {f: len(v) for f, v in window.items()}
    (args.out / "window.json").write_text(json.dumps(detail, indent=1, default=str), encoding="utf-8")
    print(json.dumps(detail["summary"], indent=1))
    print(f"{n} window row(s) written to {WINDOW_TABLE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
