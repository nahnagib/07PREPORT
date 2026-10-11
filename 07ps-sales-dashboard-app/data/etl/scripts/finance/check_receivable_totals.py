"""Reconciles a receivable snapshot with Odoo's own totals, per company: the open receivable lines of the job's domain
summed by Odoo (read_group, read-only) vs the snapshot summed over EVERY scope and inter-company. They must be equal;
the Debt page's default (customer debt, inter-company excluded) is printed next to them for reference.

  python scripts/finance/check_receivable_totals.py [--date 2026-10-04]

Uses the platform settings (DB_*, ODOO_*, the production guard variables, ODOO_COMPANY_IDS / ODOO_COMPANY_NAMES)
and the default read-only Odoo credentials. Read-only on both sides. A posting in Odoo after the snapshot run shows
up as a difference: re-run right after the job, or compare the line ids (the job's own end-of-extraction recount
reports those).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT, ROOT / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from sqlalchemy import create_engine, text  # noqa: E402

from departments.finance.jobs import RECEIVABLE_DOMAIN  # noqa: E402
from etl_platform.config import PlatformConfig  # noqa: E402
from etl_platform.sources.odoo import OdooSource  # noqa: E402
from sales_pipeline.product_matching import normalize_match_company  # noqa: E402


def scoped_company_ids(config: PlatformConfig, odoo: OdooSource) -> tuple[int, ...]:
    ids = list(config.odoo_company_ids)
    if config.odoo_company_names:
        companies = odoo.accessible_companies()
        by_name = {normalize_match_company(c.get("name")).upper(): int(c["id"]) for c in companies if c.get("name") is not None}
        missing = [name for name in config.odoo_company_names if normalize_match_company(name).upper() not in by_name]
        if missing:
            raise RuntimeError("ODOO_COMPANY_NAMES not visible to the Odoo user: " + ", ".join(missing))
        ids.extend(by_name[normalize_match_company(name).upper()] for name in config.odoo_company_names)
    out = tuple(dict.fromkeys(ids))
    odoo.company_ids = out
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--date", help="snapshot date (default: the latest snapshot)")
    args = ap.parse_args()
    config = PlatformConfig.from_env()
    engine = create_engine(config.database_url)
    with engine.connect() as conn:
        snap = int(args.date.replace("-", "")) if args.date else conn.execute(text("SELECT MAX(SnapshotDateKey) FROM fact_finance_receivable_snapshot")).scalar()
        rows = conn.execute(text(
            "SELECT CompanyKey, COUNT(*), SUM(residual_company_ccy), "
            "SUM(CASE WHEN receivable_scope = 'customer_debt' AND is_intercompany = 0 THEN residual_company_ccy ELSE 0 END) "
            "FROM fact_finance_receivable_snapshot WHERE SnapshotDateKey = :s GROUP BY CompanyKey"), {"s": snap}).fetchall()
    ours = {int(c): (int(n), float(t), float(d)) for c, n, t, d in rows}
    odoo = OdooSource.connect(config, "default", today=_dt.date.today())
    ok = True
    print(f"Snapshot {snap} vs Odoo now (open receivable lines, posted, unreconciled, residual != 0)")
    print(f"{'company':>8} {'lines odoo':>11} {'lines snap':>11} {'residual odoo':>18} {'residual snap':>18} {'difference':>12} {'page default':>16}")
    for company in scoped_company_ids(config, odoo):
        domain = [*RECEIVABLE_DOMAIN, ("company_id", "=", company)]
        group = odoo.client.execute_kw("account.move.line", "read_group", [domain, ["amount_residual:sum"], []],
                                       {"lazy": False, "context": odoo.context})
        o_lines, o_sum = (int(group[0].get("__count", 0)), float(group[0].get("amount_residual") or 0.0)) if group else (0, 0.0)
        n, total, default = ours.get(company, (0, 0.0, 0.0))
        diff = round(total - o_sum, 2)
        ok &= diff == 0 and n == o_lines
        print(f"{company:>8} {o_lines:>11,} {n:>11,} {o_sum:>18,.2f} {total:>18,.2f} {diff:>12,.2f} {default:>16,.2f}")
    print("MATCH" if ok else "DIFFERENCE (see the docstring)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
