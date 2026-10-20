"""Reconciles the NPS Score warehouse data with the NPS source, and reproduces the developer's weekly e-mail figures.

  python scripts/process/check_nps_totals.py [--from 2026-10-11 --to 2026-10-17] [--api http://localhost:14000]

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
8 YTD (the NPS page's default period, 1 January -> today, Tripoli): per company (all, Majaal, Tika), with the default
B2B + B2C filter and with every filter cleared, plain SQL on the fact tables (responders, groups, NPS, CSAT, reach
boxes, error groups, response rate = responders / (Delivered + Read) from NPS_REACH_START) vs the API (overview, weekly
and monthly trend, reach, response-rate, followup-summary, detractor list), plus the page's consistency rules. The API
part needs --api and NPS_CHECK_API_TOKEN (the Bearer token of a logged-in user with the NPS page; never printed).
"""

from __future__ import annotations

import argparse
import collections
import datetime as _dt
import os
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


# -- 8. YTD: plain SQL on the fact tables vs the API (the NPS page's default period) -----------------------------------------
B2B_B2C = [1, 2]  # the dashboard's default Customer Group filter (FilterProvider)
# the dashboard's segment rule (backend measures/filters.ts effectiveSegmentExpr): an admin override of the salesperson's
# segment wins over the row's own SegmentKey -- written here as a plain LEFT JOIN, independently of the API code
EFFECTIVE_SEGMENT = "COALESCE(sap.segment_key_override, f.SegmentKey)"
FACT_WITH_OVERRIDE = ("fact_process_nps_response f LEFT JOIN salesperson_admin_profile sap "
                      "ON sap.salesperson_key = f.SalespersonKey")


def _api_get(base: str, token: str, path: str, params: list[tuple[str, str]]) -> dict:
    """GET the NPS Score API as the logged-in user of the token (never printed)."""
    import json
    import urllib.parse
    import urllib.request
    req = urllib.request.Request(f"{base.rstrip('/')}/nps-score/{path}?{urllib.parse.urlencode(params)}",
                                 headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode("utf-8"))


def _fact_counts(conn, lo: int, hi: int, company: int | None, segments: list[int] | None) -> dict:
    """Responders and groups straight from fact_process_nps_response (no view, no API code)."""
    where = "f.RatingDateKey BETWEEN :lo AND :hi"
    params: dict = {"lo": lo, "hi": hi}
    if company is not None:
        where += " AND f.CompanyKey = :c"
        params["c"] = company
    if segments:
        where += f" AND {EFFECTIVE_SEGMENT} IN ({', '.join(str(int(s)) for s in segments)})"
    p, m, d = (int(v or 0) for v in conn.execute(text(
        f"SELECT SUM(f.nps_level = 3), SUM(f.nps_level = 2), SUM(f.nps_level = 1) FROM {FACT_WITH_OVERRIDE} WHERE {where}"), params).first())
    n = p + m + d
    return {"responders": n, "promoters": p, "passives": m, "detractors": d,
            "nps": None if n == 0 else 100 * p / n - 100 * d / n, "csat": None if n == 0 else 100 * (p + m) / n}


def _fact_reach(conn, lo: int, hi: int, company: int | None) -> dict:
    where = "in_reach_scope = 1 AND MessageDateKey BETWEEN :lo AND :hi"
    params: dict = {"lo": lo, "hi": hi}
    if company is not None:
        where += " AND CompanyKey = :c"
        params["c"] = company
    row = conn.execute(text(f"SELECT COUNT(*), SUM(box = 'delivered'), SUM(box = 'read'), SUM(box = 'not_delivered'), SUM(box = 'error'), "
                            f"SUM(box = 'other') FROM fact_process_nps_message WHERE {where}"), params).first()
    total, delivered, read, not_delivered, error, other = (int(v or 0) for v in row)
    groups = {str(g): int(n) for g, n in conn.execute(text(
        f"SELECT failure_group, COUNT(*) FROM fact_process_nps_message WHERE {where} AND box = 'error' GROUP BY failure_group"), params)}
    return {"totalReach": total, "delivered": delivered, "read": read, "notDelivered": not_delivered, "error": error,
            "otherState": other, "groups": groups}


def _close(a, b) -> bool:
    return (a is None and b is None) or (a is not None and b is not None and abs(a - b) < 1e-9)


def reconcile_ytd(conn, today: _dt.date, api_base: str | None, token: str | None) -> bool:
    """YTD (1 January -> today, Tripoli): per company (all, Majaal 1, Tika 3), with the default B2B + B2C filter and with
    every filter cleared, the plain-SQL figures vs the API, plus the page's consistency rules on the API's own answers."""
    start = today.replace(month=1, day=1)
    lo, hi = int(start.strftime("%Y%m%d")), int(today.strftime("%Y%m%d"))
    state = conn.execute(text("SELECT reach_start FROM process_nps_reach_state WHERE singleton_id = 1")).first()
    reach_start = state[0] if state and state[0] else None
    rr_from = max(start, reach_start) if reach_start else start
    rr_lo = int(rr_from.strftime("%Y%m%d"))
    print(f"\n8. YTD {start}..{today} (Tripoli) -- plain SQL on the fact tables vs the API"
          f"{'' if token and api_base else ' (API NOT CHECKED: set NPS_CHECK_API_TOKEN and --api)'}")
    print(f"   response rate period {rr_from}..{today} (NPS_REACH_START {reach_start})")
    ok = True
    for label, segments in (("default B2B + B2C", B2B_B2C), ("all filters cleared", None)):
        print(f"\n   {label}")
        print(f"   {'company':<8}{'resp':>6}{'prom':>6}{'pass':>6}{'detr':>6}{'NPS':>9}{'CSAT':>9}{'reach':>7}{'deliv':>7}{'read':>6}"
              f"{'notdel':>7}{'error':>6}{'rate':>8}  result")
        for company in (None, 1, 3):
            want = _fact_counts(conn, lo, hi, company, segments)
            reach = _fact_reach(conn, lo, hi, company)
            rr_resp = _fact_counts(conn, rr_lo, hi, company, None)["responders"]
            rr_reach = _fact_reach(conn, rr_lo, hi, company)
            reached = rr_reach["delivered"] + rr_reach["read"]
            rate = None if reached == 0 else 100 * rr_resp / reached
            checks: list[tuple[str, bool]] = []
            # rules that hold on the plain SQL itself
            checks.append(("P+Pa+D=R", want["promoters"] + want["passives"] + want["detractors"] == want["responders"]))
            checks.append(("satisfied+D=R", (want["promoters"] + want["passives"]) + want["detractors"] == want["responders"]))
            checks.append(("boxes=reach", reach["delivered"] + reach["read"] + reach["notDelivered"] + reach["error"] + reach["otherState"] == reach["totalReach"]))
            checks.append(("errors=box", sum(reach["groups"].values()) == reach["error"]))
            if token and api_base:
                params = [("dateFrom", str(start)), ("dateTo", str(today))]
                if company is not None:
                    params.append(("companyKeys", str(company)))
                for s in segments or []:
                    params.append(("segmentKeys", str(s)))
                o = _api_get(api_base, token, "overview", params)["totals"]
                checks.append(("overview", all(o[k] == want[k] for k in ("responders", "promoters", "passives", "detractors"))
                               and _close(o["nps"], want["nps"]) and _close(o["csat"], want["csat"])))
                for grain in ("week", "month"):
                    t = _api_get(api_base, token, "trend", [*params, ("grain", grain)])
                    checks.append((f"trend {grain} sum", sum(p["responders"] for p in t["points"]) == want["responders"]))
                r = _api_get(api_base, token, "reach", params)
                if r["status"] == "ready":
                    t = r["totals"]
                    checks.append(("reach", all(t[k] == reach[k] for k in ("totalReach", "delivered", "read", "notDelivered", "error", "otherState"))))
                    checks.append(("errors", {e["key"]: e["count"] for e in r["errors"]} == reach["groups"]))
                rr = _api_get(api_base, token, "response-rate", params)
                checks.append(("rate", rr["status"] == "ready" and rr["responders"] == rr_resp and rr["reached"] == reached and _close(rr["rate"], rate)))
                fu = _api_get(api_base, token, "followup-summary", params)
                checks.append(("followup", fu["detractors"] == want["detractors"]
                               and fu["charted"] + fu["cancelled"] + fu["historical"] + fu["noCase"] == fu["detractors"]))
                try:
                    dl = _api_get(api_base, token, "detractors", [*params, ("pageSize", "500")])
                    checks.append(("detractor list", dl["total"] == want["detractors"]))
                except Exception as err:  # noqa: BLE001 -- the list needs nps_comments; say so instead of failing
                    print(f"     (detractor list not checked: {err})")
            bad = [name for name, good in checks if not good]
            ok &= not bad
            fmt = lambda v: "—" if v is None else f"{v:.2f}"  # noqa: E731
            print(f"   {('all' if company is None else company):<8}{want['responders']:>6}{want['promoters']:>6}{want['passives']:>6}"
                  f"{want['detractors']:>6}{fmt(want['nps']):>9}{fmt(want['csat']):>9}{reach['totalReach']:>7}{reach['delivered']:>7}"
                  f"{reach['read']:>6}{reach['notDelivered']:>7}{reach['error']:>6}{fmt(rate):>8}  "
                  f"{'MATCH' if not bad else 'DIFFERENT: ' + ', '.join(bad)}")
    hidden = conn.execute(text(f"SELECT {EFFECTIVE_SEGMENT} AS seg, COUNT(*) FROM {FACT_WITH_OVERRIDE} WHERE f.RatingDateKey BETWEEN :lo AND :hi "
                               f"AND {EFFECTIVE_SEGMENT} NOT IN (1, 2) GROUP BY seg ORDER BY seg"), {"lo": lo, "hi": hi}).all()
    print(f"\n   hidden by the default B2B + B2C filter: {sum(int(n) for _, n in hidden)} rating(s) "
          f"({', '.join(f'segment {int(k)}: {int(n)}' for k, n in hidden) or 'none'})")
    moved = conn.execute(text(f"SELECT f.response_id, f.SegmentKey, sap.segment_key_override FROM {FACT_WITH_OVERRIDE} "
                              "WHERE f.RatingDateKey BETWEEN :lo AND :hi AND sap.segment_key_override IS NOT NULL "
                              "AND sap.segment_key_override <> f.SegmentKey AND (f.SegmentKey IN (1, 2)) <> (sap.segment_key_override IN (1, 2))"),
                         {"lo": lo, "hi": hi}).all()
    if moved:
        print(f"   moved in or out of B2B + B2C by a salesperson's segment override (response_id, fact segment, override): "
              f"{[tuple(int(v) for v in r) for r in moved][:20]}")
    print(f"   YTD: {'MATCH' if ok else 'DIFFERENT'}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from", dest="date_from", help="weekly e-mail period start (yyyy-mm-dd), default 7 days ago")
    ap.add_argument("--to", dest="date_to", help="weekly e-mail period end, inclusive (default today)")
    ap.add_argument("--api", help="backend base URL for the YTD check against the API, e.g. http://localhost:14000 "
                                  "(the token comes from NPS_CHECK_API_TOKEN)")
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
    with wh.connect() as c:
        ok &= reconcile_ytd(c, today, args.api, os.environ.get("NPS_CHECK_API_TOKEN"))
    wh.dispose()
    print("\nMATCH" if ok else "\nDIFFERENCE (see above and the docstring)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
