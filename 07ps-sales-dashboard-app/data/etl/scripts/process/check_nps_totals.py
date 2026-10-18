"""Reconciles the NPS Score warehouse data with the NPS source, and reproduces the developer's weekly e-mail figures.

  python scripts/process/check_nps_totals.py [--from 2026-10-11 --to 2026-10-17]

Read-only on both sides: the source through the NPS credential profile (NPS_* in data/etl/.env, SSH tunnel), the
warehouse through DB_*. It checks, and prints MATCH only when all of these hold:
  1. rows: source COUNT(*) of nps_rating_full_data / low_rating_data = raw_nps_rating / raw_nps_low_rating (not deleted)
  2. per month (Africa/Tripoli) x level: the source rows classified with departments/process/nps.py = v_process_nps_summary
  3. per company x level: the source company_name (MAJAAL / TIKA, mapped as the job does) = the warehouse CompanyKey
     (the order's company); a difference lists the response ids
Then, for --from/--to (default: the last 7 days), the weekly e-mail's table: counts per company_name and level, from the
same source rows. NOTE: the e-mail compares the UTC create_date with local dates, while the dashboard converts it to
Africa/Tripoli (UTC+2): a rating between 22:00 and 24:00 UTC is on the NEXT day for us, so a week can differ at its
edges. Those ratings are listed. A run of the job after the source changed shows up as a difference: re-run the job first.
"""

from __future__ import annotations

import argparse
import collections
import datetime as _dt
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT, ROOT / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from sqlalchemy import create_engine, text  # noqa: E402

from departments.process import nps  # noqa: E402
from departments.process.transform import COMPANY_BY_SOURCE_NAME  # noqa: E402
from etl_platform.config import PlatformConfig  # noqa: E402
from etl_platform.sources.mysql_ssh import MySqlSshSettings, open_source  # noqa: E402

LEVEL_KEYS = {lv.level: lv.key for lv in nps.LEVELS}


def _table(title: str, rows: dict, columns: list[str]) -> None:
    print(f"\n{title}")
    print(f"  {'':<14}" + "".join(f"{c:>10}" for c in columns))
    for key in sorted(rows):
        print(f"  {str(key):<14}" + "".join(f"{rows[key].get(c, 0):>10}" for c in columns))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from", dest="date_from", help="weekly e-mail period start (yyyy-mm-dd), default 7 days ago")
    ap.add_argument("--to", dest="date_to", help="weekly e-mail period end, inclusive (default today)")
    args = ap.parse_args()
    config = PlatformConfig.from_env()  # also loads data/etl/.env
    tz = ZoneInfo(config.business_timezone)
    with open_source(MySqlSshSettings.from_env("NPS")) as src:
        counts = {t: int(src.read_query(f"SELECT COUNT(*) AS n FROM {t}")[0]["n"]) for t in ("nps_rating_full_data", "low_rating_data")}
        rows = src.read_query("SELECT id, create_date, company_name, body FROM nps_rating_full_data")
    wh = create_engine(config.database_url)
    with wh.connect() as c:
        raw = {"nps_rating_full_data": int(c.execute(text("SELECT COUNT(*) FROM raw_nps_rating WHERE _deleted_at IS NULL")).scalar()),
               "low_rating_data": int(c.execute(text("SELECT COUNT(*) FROM raw_nps_low_rating WHERE _deleted_at IS NULL")).scalar())}
        ours_month = {int(m): {"exceeded": int(e), "met": int(me), "below": int(b), "responses": int(n)} for m, n, e, me, b in c.execute(text(
            "SELECT FLOOR(RatingDateKey / 100), SUM(responses), SUM(exceeded), SUM(met), SUM(below) FROM v_process_nps_summary "
            "GROUP BY FLOOR(RatingDateKey / 100)"))}
        ours_company = {int(k): {"exceeded": int(e), "met": int(me), "below": int(b), "responses": int(n)} for k, n, e, me, b in c.execute(text(
            "SELECT CompanyKey, SUM(responses), SUM(exceeded), SUM(met), SUM(below) FROM v_process_nps_summary GROUP BY CompanyKey"))}
        our_company_of = {int(r): int(k) for r, k in c.execute(text("SELECT response_id, CompanyKey FROM fact_process_nps_response"))}
    ok = True
    print("1. rows (the query: SELECT COUNT(*) FROM <source table> vs SELECT COUNT(*) FROM raw_nps_* WHERE _deleted_at IS NULL)")
    for t, n in counts.items():
        same = n == raw[t]
        ok &= same
        print(f"  {t:<22} source {n:>7}  warehouse {raw[t]:>7}  {'ok' if same else 'DIFFERENT'}")

    rated = [(r, nps.classify(r["body"])) for r in rows]
    rated = [(r, lv) for r, lv in rated if lv is not None]
    src_month: dict[int, collections.Counter] = collections.defaultdict(collections.Counter)
    src_company: dict[int, collections.Counter] = collections.defaultdict(collections.Counter)
    company_diff = []
    for r, lv in rated:
        local = r["create_date"].replace(tzinfo=_dt.timezone.utc).astimezone(tz)
        src_month[local.year * 100 + local.month][LEVEL_KEYS[lv]] += 1
        src_month[local.year * 100 + local.month]["responses"] += 1
        company = COMPANY_BY_SOURCE_NAME.get(str(r["company_name"] or "").strip().upper(), -1)
        src_company[company][LEVEL_KEYS[lv]] += 1
        src_company[company]["responses"] += 1
        if our_company_of.get(int(r["id"])) != company:
            company_diff.append((int(r["id"]), r["company_name"], our_company_of.get(int(r["id"]))))
    cols = ["exceeded", "met", "below", "responses"]
    months_ok = {m: dict(v) for m, v in src_month.items()} == {m: {k: v for k, v in d.items() if v} for m, d in ours_month.items()}
    _table("2. per month (Africa/Tripoli) -- source", {m: dict(v) for m, v in src_month.items()}, cols)
    _table("   per month -- warehouse v_process_nps_summary", ours_month, cols)
    print("  " + ("ok" if months_ok else "DIFFERENT"))
    companies_ok = not company_diff
    _table("3. per company -- source company_name (MAJAAL 1, TIKA 3, other -1)", {k: dict(v) for k, v in src_company.items()}, cols)
    _table("   per company -- warehouse CompanyKey (the order's company)", ours_company, cols)
    print("  ok" if companies_ok else f"  DIFFERENT for {len(company_diff)} response(s) (id, source company_name, our CompanyKey): {company_diff[:20]}")
    ok &= months_ok and companies_ok

    today = _dt.datetime.now(tz).date()
    d_from = _dt.date.fromisoformat(args.date_from) if args.date_from else today - _dt.timedelta(days=6)
    d_to = _dt.date.fromisoformat(args.date_to) if args.date_to else today
    email: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    ours: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    edge = []
    for r, lv in rated:
        utc_day = r["create_date"].date()
        local_day = r["create_date"].replace(tzinfo=_dt.timezone.utc).astimezone(tz).date()
        name = str(r["company_name"] or "").strip().upper() or "(none)"
        if d_from <= utc_day <= d_to:
            email[name][LEVEL_KEYS[lv]] += 1
            email[name]["responses"] += 1
        if d_from <= local_day <= d_to:
            ours[name][LEVEL_KEYS[lv]] += 1
            ours[name]["responses"] += 1
        if utc_day != local_day and (d_from <= utc_day <= d_to) != (d_from <= local_day <= d_to):
            edge.append((int(r["id"]), str(r["create_date"]), str(local_day)))
    _table(f"Weekly e-mail {d_from}..{d_to} -- per company_name, UTC create_date (the e-mail's basis)", {k: dict(v) for k, v in email.items()}, cols)
    _table(f"Same period, Africa/Tripoli dates (the dashboard's basis)", {k: dict(v) for k, v in ours.items()}, cols)
    if edge:
        print(f"  {len(edge)} rating(s) change period with the time zone (id, UTC create_date, Tripoli date): {edge[:20]}")
    print("\nMATCH" if ok else "\nDIFFERENCE (see above and the docstring)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
