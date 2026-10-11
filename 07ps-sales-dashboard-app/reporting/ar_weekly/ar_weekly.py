"""Weekly Sales Collection & Aging Report, live from Odoo.

    python ar_weekly.py --check            test the Odoo connection and access rights (reads only)
    python ar_weekly.py                    report for the last completed week (ending Saturday), every salesperson
    python ar_weekly.py --rep Marwan       one salesperson (name contains, case-insensitive)
    python ar_weekly.py --as-of 2026-10-03 a specific week end (past weeks are rebuilt from the reconciliations)
    python ar_weekly.py --send             also email the reports ([email] in config.ini)
    python ar_weekly.py --demo             run on built-in sample data (no Odoo needed)
    python ar_weekly.py --make-recipients  create the recipients Excel file from Input/SalesTeam.xlsx
    python ar_weekly.py --update-recipients add salespeople found in Odoo to the recipients file

The tool only reads from Odoo. See README.md.
"""
from __future__ import annotations

import argparse
import datetime as dt
import logging
import re
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from engine import rep_report, team_summary  # noqa: E402
from extract import extract  # noqa: E402
import recipients as rcp  # noqa: E402
from mailer import send  # noqa: E402
from odoo_api import OdooClient, OdooError  # noqa: E402
from render_excel import rep_workbook, team_workbook  # noqa: E402
from render_html import render_rep, render_team  # noqa: E402
from settings import default_as_of, load_settings  # noqa: E402

log = logging.getLogger("ar_weekly")


def setup_logging(log_dir: Path, verbose: bool) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / f"ar_weekly_{dt.datetime.now():%Y%m%d_%H%M%S}.log"
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    for h in (logging.FileHandler(path, encoding="utf-8"), logging.StreamHandler(sys.stdout)):
        h.setFormatter(fmt)
        root.addHandler(h)
    return path


def safe_name(text: str) -> str:
    return re.sub(r"[^\w\-]+", "_", text, flags=re.UNICODE).strip("_")[:60] or "rep"


def make_client(s, demo: bool):
    if demo:
        from demo_odoo import DemoOdoo
        return DemoOdoo()
    return OdooClient(s.url, s.db, s.login, s.api_key, company_ids=s.company_ids, lang=s.lang, timeout=s.timeout,
                      max_retries=s.max_retries)


def check(s, client) -> int:
    print(f"Odoo URL      : {s.url}\nDatabase      : {s.db}\nLogin         : {s.login} (profile {s.credential_profile})")
    print(f"Companies     : {s.company_ids or 'all allowed'}\nSecrets from  : {', '.join(s.env_files_loaded) or 'environment'}")
    try:
        print(f"Odoo version  : {client.server_version()}")
        print(f"User id       : {client.authenticate()}")
        dom = [("account_type", "=", "asset_receivable"), ("parent_state", "=", "posted"), ("reconciled", "=", False)]
        print(f"Open receivable lines readable : {client.count('account.move.line', dom):,}")
        since = (dt.date.today() - dt.timedelta(days=28)).isoformat()
        print(f"Reconciliations last 4 weeks   : {client.count('account.partial.reconcile', [('max_date', '>', since)]):,}")
        for model in ("account.move", "account.payment", "account.journal", "res.partner", "res.users", "res.company"):
            client.call(model, "search", [[]], {"limit": 1})
        print("Read access   : OK on every model the report needs")
        print("\nConnection OK. Run without --check to build the report.")
        return 0
    except OdooError as exc:
        print(f"\nFAILED: {exc}")
        return 2


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=HERE / "config.ini")
    ap.add_argument("--env-file", type=Path, help="a .env file with ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY")
    ap.add_argument("--as-of", type=dt.date.fromisoformat, help="week-end date YYYY-MM-DD (default: last completed week end)")
    ap.add_argument("--rep", action="append", help="salesperson name (contains) or Odoo user id; repeatable")
    ap.add_argument("--out", type=Path, help="output folder (default from config.ini)")
    ap.add_argument("--send", action="store_true", help="email the reports (needs [email] enabled = true)")
    ap.add_argument("--dry-run-email", action="store_true", help="log who would be emailed, send nothing")
    ap.add_argument("--test-to", metavar="EMAIL", help="send every email to this address only (no CC), subject marked [TEST]")
    ap.add_argument("--check", action="store_true", help="test the Odoo connection and stop")
    ap.add_argument("--demo", action="store_true", help="use built-in sample data instead of Odoo")
    ap.add_argument("--make-recipients", action="store_true", help="create the recipients Excel file and stop")
    ap.add_argument("--update-recipients", action="store_true", help="append salespeople found in Odoo to the recipients file and stop")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)

    s = load_settings(a.config, a.env_file)
    if a.out:
        s.output_dir = a.out.resolve()
    log_path = setup_logging(s.log_dir, a.verbose)
    if a.make_recipients:
        return make_recipients(s)
    client = make_client(s, a.demo)
    if a.check:
        return check(s, client)

    as_of = a.as_of or (dt.date(2026, 10, 3) if a.demo else default_as_of(dt.date.today(), s.week_end_day))
    if as_of >= dt.date.today() and not a.demo:
        log.warning("As-of date %s is today or later: this week is not finished, figures will still move", as_of)
    since = as_of - dt.timedelta(days=7 * s.trend_weeks)
    generated = dt.datetime.now()
    log.info("Report for week ending %s (trend from %s), Odoo %s, demo=%s", as_of, since, s.url or "-", a.demo)

    try:
        data = extract(client, s, since)
    except OdooError as exc:
        log.error("%s", exc)
        return 2
    lines = data.lines[data.lines["excluded"].isna()] if len(data.lines) else data.lines
    if a.update_recipients:
        return update_recipients(s, lines)
    try:
        recips = rcp.load(s.recipients_file)
    except RuntimeError as exc:
        log.error("%s", exc)
        return 1
    if not s.include_unassigned:
        lines = lines[lines["rep_id"] != 0]
    wanted = (a.rep or []) + s.reps
    if wanted:
        def match(row) -> bool:
            for w in wanted:
                w = w.strip()
                if w.isdigit() and int(w) == row["rep_id"]:
                    return True
                if w.lower() in str(row["rep"]).lower() or w.lower() in str(row["rep_odoo_name"]).lower():
                    return True
            return False
        reps = lines[["rep_id", "rep", "rep_odoo_name"]].drop_duplicates()
        keep = {r.rep_id for _, r in reps.iterrows() if match(r)}
        lines = lines[lines["rep_id"].isin(keep)]
        if not keep:
            log.error("No salesperson matches %s", wanted)
            return 1

    out_dir = s.output_dir / f"{as_of:%Y-%m-%d}"
    out_dir.mkdir(parents=True, exist_ok=True)
    reports, files = [], {}
    for (rep_id, ccy), grp in lines.groupby(["rep_id", "currency"], sort=False):
        first = grp.iloc[0]
        rec = recips.find(int(rep_id), str(first["rep"]), str(first["rep_odoo_name"])) if recips.loaded else None
        r = rep_report(grp.reset_index(drop=True), data.partials, as_of, s, rec.target if rec else None)
        if r.kpi["gross"] < max(s.min_outstanding, 0.005) and r.week.collected_total == 0:
            log.debug("Skipped %s %s: no open invoices and no collections (unapplied credits %.2f)", r.rep, ccy, r.kpi["credits"])
            continue
        reports.append(r)
        stem = f"AR_Weekly_{safe_name(r.rep)}_{ccy}_{as_of:%Y-%m-%d}"
        html_path, xlsx_path = out_dir / f"{stem}.html", out_dir / f"{stem}.xlsx"
        scope = f"companies {s.company_ids or 'all'}; inter-company {'excluded' if s.exclude_intercompany else 'included'}"
        html_path.write_text(render_rep(r, generated, scope), encoding="utf-8")
        rep_workbook(r, xlsx_path, generated)
        files[(rep_id, ccy)] = (html_path, xlsx_path)
        log.info("%-28s %s  outstanding %14s  overdue %14s  collected %12s  -> %s", r.rep[:28], ccy, f"{r.kpi['gross']:,.0f}",
                 f"{r.kpi['overdue']:,.0f}", f"{r.week.collected_overdue:,.0f}", html_path.name)
    if not reports:
        log.warning("Nothing to report for %s", as_of)
        return 0

    summary = team_summary(reports)
    team_html = out_dir / f"AR_Weekly_TEAM_{as_of:%Y-%m-%d}.html"
    team_xlsx = out_dir / f"AR_Weekly_TEAM_{as_of:%Y-%m-%d}.xlsx"
    team_html.write_text(render_team(summary, as_of, generated), encoding="utf-8")
    team_workbook(summary, team_xlsx)

    hist_path = s.output_dir / "kpi_history.csv"
    hist = summary.assign(**{"Week Ending": as_of.isoformat(), "Generated": generated.isoformat(timespec="seconds")})
    if hist_path.is_file():
        old = pd.read_csv(hist_path, encoding="utf-8-sig")
        old = old[old["Week Ending"] != as_of.isoformat()]
        hist = pd.concat([old, hist], ignore_index=True)
    hist.to_csv(hist_path, index=False, encoding="utf-8-sig")

    if a.send or a.dry_run_email:
        if not s.email_enabled and not a.dry_run_email and not a.test_to:
            log.warning("--send given but [email] enabled = false in config.ini: nothing sent")
        else:
            email_reports(s, recips, reports, files, team_html, team_xlsx, as_of, dry_run=a.dry_run_email, test_to=a.test_to)
    log.info("Done: %s salesperson reports in %s (log %s)", len(reports), out_dir, log_path.name)
    return 0


def email_reports(s, recips, reports, files, team_html, team_xlsx, as_of, dry_run: bool, test_to: str | None = None) -> None:
    plan = []
    mail = send
    if test_to and test_to.strip().lower() == "me":
        test_to = s.smtp_user or re.sub(r".*<([^>]+)>.*", r"\1", s.smtp_from)
        if "@" not in (test_to or ""):
            log.error("Test mode: no address for 'me'. Put your email in SMTP_USER in .env, or use --test-to you@company.ly")
            return
    if test_to:
        # test mode: the recipients file decides WHICH reports go out, but every one goes to test_to only
        def mail(s_, to, subject, body, att, dry_run=False, cc=None):
            log.info("[TEST] '%s' would go to %s%s: sent to %s instead", subject, to, f" (cc {cc})" if cc else "", test_to)
            return send(s_, [test_to], "[TEST] " + subject, body, att, dry_run=dry_run, cc=[])
    for r in reports:
        h, x = files[(r.rep_id, r.currency)]
        subject = f"تقرير التحصيل الأسبوعي — {r.rep} — {as_of:%d/%m/%Y}" + (f" — {r.currency}" if r.currency != "LYD" else "")
        if recips.loaded:
            rec = recips.find(r.rep_id, r.rep, r.rep_odoo_name)
            if rec is None:
                plan.append((r.rep, "-", "NOT SENT: not in the recipients file (run --update-recipients)"))
                continue
            if not rec.send:
                plan.append((r.rep, rec.email or "-", "not sent: Send Report = No"))
                continue
            to = rec.email or (r.rep_email if s.use_odoo_email_if_blank else "")
            if not to:
                plan.append((r.rep, "-", "NOT SENT: no email in the recipients file"))
                continue
            cc = rec.cc + s.email_cc
        else:
            if not s.email_to_rep:
                continue
            to = s.email_rep_overrides.get(r.rep.lower()) or s.email_rep_overrides.get(str(r.rep_id)) or r.rep_email
            cc = s.email_cc
        try:
            ok, err = mail(s, [to], subject, h.read_text(encoding="utf-8"), [x], dry_run=dry_run, cc=cc), ""
        except Exception as exc:  # one failure must not stop the other emails
            ok, err = False, f": {str(exc)[:160]}"
            log.error("Email to %s failed: %s", to, exc)
        plan.append((r.rep, to + (f" (cc {', '.join(cc)})" if cc else ""), ("would send" if dry_run else "sent") if ok else "FAILED" + err))
    team_to = list(dict.fromkeys((recips.team if recips.loaded else []) + s.email_summary_to))
    if team_to:
        try:
            ok, err = mail(s, team_to, f"ملخص التحصيل الأسبوعي — كل المندوبين — {as_of:%d/%m/%Y}",
                           team_html.read_text(encoding="utf-8"), [team_xlsx], dry_run=dry_run, cc=[]), ""
        except Exception as exc:
            ok, err = False, f": {str(exc)[:160]}"
            log.error("Team summary email failed: %s", exc)
        plan.append(("TEAM SUMMARY", ", ".join(team_to), ("would send" if dry_run else "sent") if ok else "FAILED" + err))
    log.info("Email plan%s:\n%s", " (dry run, nothing sent)" if dry_run else "",
             "\n".join(f"  {n[:30]:<30} {e:<45} {st}" for n, e, st in plan))


def make_recipients(s) -> int:
    path = s.recipients_file
    if not path:
        log.error("Set recipients_file under [email] in config.ini")
        return 1
    if path.exists():
        log.error("%s already exists: edit it, or use --update-recipients to add new salespeople", path)
        return 1
    rows = []
    try:
        x = pd.read_excel(s.sales_team_file, sheet_name=None, dtype=object) if s.sales_team_file else {}
    except Exception as exc:
        log.warning("Could not read the sales team file (%s): creating an empty recipients file", exc)
        x = {}
    if "OdooUsers" in x:
        u = x["OdooUsers"].dropna(subset=["odoo_user_id"])
        sp = x.get("salesperson", pd.DataFrame(columns=["SalespersonKey"]))
        tm = x.get("salesteam", pd.DataFrame(columns=["TeamKey"]))
        m = u.merge(sp, on="SalespersonKey", how="left").merge(tm[["TeamKey", "TeamName", "Segment"]] if "TeamName" in tm else tm,
                                                              on="TeamKey", how="left")
        m["_active"] = m.get("Status", pd.Series(dtype=object)).astype(str).str.strip().str.lower().eq("active")
        m = m.sort_values(["_active", "odoo_user_name"], ascending=[False, True])
        for _, r in m.iterrows():
            seg = str(r.get("Segment") or "").strip()
            active = bool(r["_active"]) and seg.lower() not in s.exclude_segments
            team = " · ".join(str(v).strip() for v in (r.get("TeamKey"), r.get("TeamName")) if isinstance(v, str) and v.strip())
            rows.append({"Odoo User ID": int(float(r["odoo_user_id"])), "Salesperson Name (Odoo)": str(r["odoo_user_name"]).strip(),
                         "Email": None, "CC": None, "Send Report": "Yes" if active else "No", "Weekly Target": None,
                         "Team": team or None,
                         "Notes": None if active else ("Inactive / no team in SalesTeam.xlsx" if not seg or not r["_active"]
                                                       else f"{seg} segment: excluded from the report")})
    rcp.build(path, rows)
    log.info("Created %s with %s salespeople. Fill the Email column, then run --dry-run-email.", path, len(rows))
    return 0


def update_recipients(s, lines: pd.DataFrame) -> int:
    path = s.recipients_file
    if not path:
        log.error("Set recipients_file under [email] in config.ini")
        return 1
    people = []
    for _, r in lines[lines["rep_id"] != 0].drop_duplicates("rep_id").iterrows():
        people.append({"Odoo User ID": int(r["rep_id"]), "Salesperson Name (Odoo)": r["rep_odoo_name"] or r["rep"],
                       "_alt_name": r["rep"], "Email": None, "Send Report": "Yes", "Team": r["team"] or None,
                       "Odoo Email (reference)": r["rep_email"] or None, "Notes": "added from Odoo: fill the email"})
    if not path.exists():
        rcp.build(path, [{k: v for k, v in p.items() if not k.startswith("_")} for p in people])
        log.info("Created %s with the %s salespeople who have debt in Odoo", path, len(people))
        return 0
    try:
        added = rcp.append_missing(path, people)
    except PermissionError:
        log.error("%s is open in Excel: close it and run again", path)
        return 1
    log.info("Recipients file updated: %s salespeople added, Odoo emails filled in the reference column", added)
    return 0


if __name__ == "__main__":
    sys.exit(main())
