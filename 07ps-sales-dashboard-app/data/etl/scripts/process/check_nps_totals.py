"""Reconciles the NPS Score warehouse data with the NPS source, and reproduces the developer's weekly e-mail figures.

  python scripts/process/check_nps_totals.py [--from 2026-10-11 --to 2026-10-17]

Read-only on both sides: the source through the NPS credential profile (NPS_* in data/etl/.env, SSH tunnel), the
warehouse through DB_*. It checks, and prints MATCH only when all of these hold:
  1. rows: source COUNT(*) of nps_rating_full_data / low_rating_data = raw_nps_rating / raw_nps_low_rating (not deleted)
  2. per month (Africa/Tripoli) x level: the source rows classified with departments/process/nps.py = v_process_nps_summary
  3. per company x level: the source company_name (MAJAAL / TIKA, mapped as the job does) = the warehouse CompanyKey
     (the order's company); a difference lists the response ids
Then, for --from/--to (default: the last 7 days), the weekly e-mail's table: counts per company_name and level, from the
same source rows. With NPS_REACH_ENABLED, the WhatsApp reach as well: 4 raw = source, 5 fact = raw after the filters,
6 the serving views (what the API reads) = the rule per Tripoli date and company, 7 the weekly e-mail's LAST 7 DAYS
section (delivered / read / sent / error per company on the UTC create_date) = the warehouse. NOTE: the e-mail compares the UTC create_date with local dates, while the dashboard converts it to
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
import pandas as pd  # noqa: E402

from departments.process import nps  # noqa: E402
from departments.process import whatsapp as wa  # noqa: E402
from departments.process.transform import COMPANY_BY_SOURCE_NAME  # noqa: E402
from etl_platform.config import PlatformConfig  # noqa: E402
from etl_platform.sources.mysql_ssh import MySqlSshSettings, open_source  # noqa: E402

LEVEL_KEYS = {lv.level: lv.key for lv in nps.LEVELS}


def _table(title: str, rows: dict, columns: list[str]) -> None:
    print(f"\n{title}")
    print(f"  {'':<14}" + "".join(f"{c:>10}" for c in columns))
    for key in sorted(rows):
        print(f"  {str(key):<14}" + "".join(f"{rows[key].get(c, 0):>10}" for c in columns))


def reconcile_reach(conn, messages: list[dict], config: wa.ReachConfig, timezone: str,
                    date_from: _dt.date, date_to: _dt.date) -> bool:
    """Source messages vs raw, fact and serving views, and the weekly e-mail's LAST 7 DAYS table. Never prints personal
    data or free-text failures. Messages that left the source stay counted (business rule 2026-10-19), so the expected
    figures are the source rows plus the raw rows marked deleted."""
    raw_ids = {int(r[0]) for r in conn.execute(text("SELECT id FROM raw_nps_whatsapp_message WHERE _deleted_at IS NULL"))}
    source_ids = {int(r["id"]) for r in messages}
    raw_ok = source_ids == raw_ids
    state = conn.execute(text("SELECT loaded_at_utc FROM process_nps_reach_state WHERE singleton_id = 1")).first()
    print(f"\n4. WhatsApp raw = source (ids): source {len(source_ids)}, warehouse raw not deleted {len(raw_ids)}: "
          f"{'MATCH' if raw_ok else 'DIFFERENT'}")
    if state is None:
        print("  DIFFERENT: source is available but no successful warehouse message load exists; run process_nps first.")
        return False
    print(f"  Last successful message load: {state[0]} UTC")
    gone = pd.read_sql(text(f"SELECT {', '.join(wa.SOURCE_COLUMNS[:-1])}, _deleted_at FROM raw_nps_whatsapp_message "
                            "WHERE _deleted_at IS NOT NULL"), conn)
    print(f"  Messages that left the source and are still counted: {len(gone)}")
    current = pd.DataFrame(messages, columns=wa.SOURCE_COLUMNS).assign(_deleted_at=None)
    every = pd.concat([current, gone], ignore_index=True) if len(gone) else current
    every["create_date"] = pd.to_datetime(every["create_date"])
    frame = wa.build_messages(every, config, timezone, lambda name: COMPANY_BY_SOURCE_NAME.get(str(name or '').strip().upper(), -1))

    # 5. fact = raw after the filters: same rows, same flags, same boxes and groups
    fact = pd.read_sql(text("SELECT message_id, MessageDateKey, CompanyKey, box, failure_group, in_reach_scope "
                            "FROM fact_process_nps_message"), conn)
    cols = ["message_id", "MessageDateKey", "CompanyKey", "box", "failure_group", "in_reach_scope"]
    want = frame[cols].astype(str).sort_values("message_id").reset_index(drop=True)
    have = fact[cols].astype(str).sort_values("message_id").reset_index(drop=True)
    fact_ok = want.equals(have)
    print(f"5. fact = raw after filters: rows {len(frame)} vs fact {len(fact)}, in scope {int(frame.in_reach_scope.sum())} "
          f"vs {int(fact.in_reach_scope.sum())}: {'MATCH' if fact_ok else 'DIFFERENT'}")
    if not fact_ok:
        diff = want.merge(have, how="outer", indicator=True).query("_merge != 'both'")
        print(f"  differing message ids: {sorted(set(diff.message_id))[:20]}")

    # 6. serving views (what the API reads) = the rule, per Tripoli date x company, for the period
    lo, hi = (int(d.strftime("%Y%m%d")) for d in (date_from, date_to))
    scope = frame[(frame.in_reach_scope == 1) & frame.MessageDateKey.between(lo, hi)]
    columns = ["total_reach", "delivered", "not_delivered", "read_count", "error_count", "other_state"]
    box_col = {"delivered": "delivered", "not_delivered": "not_delivered", "read": "read_count", "error": "error_count", "other": "other_state"}
    expected: dict[tuple, collections.Counter] = collections.defaultdict(collections.Counter)
    errors = collections.Counter()
    for row in scope.to_dict("records"):
        key = (int(row["MessageDateKey"]), int(row["CompanyKey"]))
        expected[key]["total_reach"] += 1
        expected[key][box_col[row["box"]]] += 1
        if row["box"] == "error":
            errors[(*key, row["failure_group"])] += 1
    params = {"lo": lo, "hi": hi}
    actual = {tuple(int(v) for v in row[:2]): {key: int(value or 0) for key, value in zip(columns, row[2:])}
              for row in conn.execute(text("SELECT MessageDateKey, CompanyKey, total_reach, delivered, not_delivered, read_count, error_count, other_state "
                                           "FROM v_process_nps_reach WHERE MessageDateKey BETWEEN :lo AND :hi"), params)}
    actual_errors = {(int(day), int(company), group): int(count) for day, company, group, count in conn.execute(text(
        "SELECT MessageDateKey, CompanyKey, failure_group, errors FROM v_process_nps_message_error WHERE MessageDateKey BETWEEN :lo AND :hi"), params)}
    normalized = {key: {column: counts[column] for column in columns} for key, counts in expected.items()}
    boxes_ok, errors_ok = normalized == actual, dict(errors) == actual_errors

    def by_company(rows):
        return {c: {k: sum(v[k] for (_, cc), v in rows.items() if cc == c) for k in columns} for c in sorted({cc for _, cc in rows})}
    _table(f"6. Reach {date_from}..{date_to} (Tripoli dates) per CompanyKey -- the rule on source rows", by_company(normalized), columns)
    _table("   per CompanyKey -- warehouse v_process_nps_reach (what the API sums)", by_company(actual), columns)
    print(f"  per date x company: boxes {'MATCH' if boxes_ok else 'DIFFERENT'}; error groups {'MATCH' if errors_ok else 'DIFFERENT'}")

    # 7. the weekly e-mail's LAST 7 DAYS table: Feedback template, test numbers out, from NPS_REACH_START, per
    #    company x state on the UTC create_date (the e-mail's basis), vs the warehouse fact on sent_at_utc
    states = ["delivered", "read", "sent", "error"]
    email: dict[int, collections.Counter] = collections.defaultdict(collections.Counter)
    for row, at in zip(frame.to_dict("records"), every["create_date"]):
        if row["in_reach_scope"] and pd.notna(at) and date_from <= at.date() <= date_to:
            email[int(row["CompanyKey"])][row["state"] if row["state"] in states else "other"] += 1
    wh: dict[int, collections.Counter] = collections.defaultdict(collections.Counter)
    for company, st, n in conn.execute(text(
            "SELECT CompanyKey, state, COUNT(*) FROM fact_process_nps_message WHERE in_reach_scope = 1 "
            "AND sent_at_utc >= :a AND sent_at_utc < :b GROUP BY CompanyKey, state"),
            {"a": _dt.datetime.combine(date_from, _dt.time()), "b": _dt.datetime.combine(date_to + _dt.timedelta(days=1), _dt.time())}):
        wh[int(company)][st if st in states else "other"] += int(n)
    email_ok = {k: dict(v) for k, v in email.items()} == {k: dict(v) for k, v in wh.items()}
    names = {v: k for k, v in COMPANY_BY_SOURCE_NAME.items()}
    _table(f"7. Weekly e-mail LAST 7 DAYS {date_from}..{date_to} (UTC create_date) -- the e-mail rule on source rows",
           {names.get(k, k): {**dict(v), "total": sum(v.values())} for k, v in email.items()}, [*states, "other", "total"])
    _table("   same -- warehouse fact_process_nps_message", {names.get(k, k): {**dict(v), "total": sum(v.values())} for k, v in wh.items()},
           [*states, "other", "total"])
    print(f"  delivered / read / sent / error per company = the weekly e-mail rule: {'MATCH' if email_ok else 'DIFFERENT'}")
    return raw_ok and fact_ok and boxes_ok and errors_ok and email_ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from", dest="date_from", help="weekly e-mail period start (yyyy-mm-dd), default 7 days ago")
    ap.add_argument("--to", dest="date_to", help="weekly e-mail period end, inclusive (default today)")
    args = ap.parse_args()
    config = PlatformConfig.from_env()  # also loads data/etl/.env
    tz = ZoneInfo(config.business_timezone)
    reach_config = wa.ReachConfig.from_env()
    messages = None
    with open_source(MySqlSshSettings.from_env("NPS")) as src:
        counts = {t: int(src.read_query(f"SELECT COUNT(*) AS n FROM {t}")[0]["n"]) for t in ("nps_rating_full_data", "low_rating_data")}
        rows = src.read_query("SELECT id, create_date, company_name, body FROM nps_rating_full_data")
        if reach_config.enabled:
            exists = src.read_query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t",
                                    {"t": wa.SOURCE_TABLE})
            if exists and int(exists[0]["n"]):
                messages = src.read_table_incremental(wa.SOURCE_TABLE, wa.SOURCE_COLUMNS)
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
    for name, values in sorted(ours.items()):
        total = values["responses"]
        if total:
            print(f"  {name}: responders {total}, NPS {100 * (values['exceeded'] - values['below']) / total:.2f}, "
                  f"CSAT {100 * (values['exceeded'] + values['met']) / total:.2f}")
    if messages is not None:
        with wh.connect() as c:
            ok &= reconcile_reach(c, messages, reach_config, config.business_timezone, d_from, d_to)
    else:
        print("\n4. WhatsApp reach: SKIPPED (NPS_REACH_ENABLED is false or the source table is not available).")
    wh.dispose()
    print("\nMATCH" if ok else "\nDIFFERENCE (see above and the docstring)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
