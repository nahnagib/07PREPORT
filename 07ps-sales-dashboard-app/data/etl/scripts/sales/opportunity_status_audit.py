"""Data-quality list (read-only): opportunities whose kanban STAGE disagrees with their real STATUS in Odoo.

  python scripts/sales/opportunity_status_audit.py [--out opportunity_status_audit.csv] [--env-file .env]

In Odoo 17 the outcome of an opportunity is its status (won_status: won / lost / pending), set by the Won / Lost buttons
on the form -- not the kanban stage it sits in. Before the custom "Won" / "Lost" stages are removed, a salesperson has to
click the real button on every record that only sits in such a stage, or it is left stranded. One row per record:

  ACTIVE_IN_LOST_STAGE   active and in a stage named "Lost", not lost  -> click Lost (or Won) on the form
  WON_STAGE_NOT_WON      in an is_won stage but won_status is not won  -> click Won (or Lost)
  ARCHIVED_NOT_LOST      archived with probability > 0 (archived, never marked Lost) -> mark Lost, or restore it

The stage NAME is used here only to find the custom "Lost" column this list is about; the dashboard never uses it.
"""

from __future__ import annotations

import argparse
import csv
import datetime as _dt
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "src"), str(ROOT)]

from etl_platform.config import PlatformConfig  # noqa: E402
from etl_platform.sources.odoo import OdooSource, m2o_id  # noqa: E402

LEAD_FIELDS = ["id", "name", "active", "probability", "won_status", "stage_id", "user_id", "team_id", "company_id",
               "partner_id", "expected_revenue", "lost_reason_id", "write_date"]
ACTIONS = {
    "ACTIVE_IN_LOST_STAGE": "Open the opportunity and click Lost (or Won if it was won)",
    "WON_STAGE_NOT_WON": "Click Won if it was won (sets probability 100), otherwise Lost",
    "ARCHIVED_NOT_LOST": "Archived without Lost: restore and click Lost, or confirm it should stay out of reports",
}


def m2o_name(v) -> str:
    return v[1] if isinstance(v, (list, tuple)) and len(v) > 1 else ""


def issue_of(lead: dict, won_stage_ids: set[int], lost_stage_ids: set[int]) -> str | None:
    stage = m2o_id(lead["stage_id"])
    if not lead["active"]:
        return "ARCHIVED_NOT_LOST" if (lead["probability"] or 0) > 0 else None
    if stage in lost_stage_ids:
        return "ACTIVE_IN_LOST_STAGE"
    if stage in won_stage_ids and lead.get("won_status") != "won":
        return "WON_STAGE_NOT_WON"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="opportunity_status_audit.csv")
    ap.add_argument("--env-file", default=str(ROOT / ".env"))
    ap.add_argument("--timezone", default="Africa/Tripoli")
    args = ap.parse_args()
    config = PlatformConfig.from_env(args.env_file)
    source = OdooSource.connect(config)
    base = str(config.odoo_url).rstrip("/")
    tz = ZoneInfo(args.timezone)

    stages = source.search_read_all("crm.stage", [], ["id", "name", "is_won"], include_archived=True)
    won_stage_ids = {s["id"] for s in stages if s["is_won"]}
    lost_stage_ids = {s["id"] for s in stages if not s["is_won"] and str(s["name"]).strip().lower() == "lost"}
    leads = source.search_read_all("crm.lead", [("type", "=", "opportunity")], LEAD_FIELDS, include_archived=True)

    rows = []
    for lead in leads:
        issue = issue_of(lead, won_stage_ids, lost_stage_ids)
        if not issue:
            continue
        written = _dt.datetime.strptime(lead["write_date"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=_dt.timezone.utc).astimezone(tz)
        company = m2o_id(lead["company_id"])
        rows.append({
            "Issue": issue, "Action": ACTIONS[issue], "OpportunityID": lead["id"], "Opportunity": lead["name"],
            "Salesperson": m2o_name(lead["user_id"]) or "(none)", "Sales Team": m2o_name(lead["team_id"]),
            "Company": m2o_name(lead["company_id"]), "Stage": m2o_name(lead["stage_id"]), "Customer": m2o_name(lead["partner_id"]),
            "Active": lead["active"], "Probability": lead["probability"], "Odoo Status": lead.get("won_status") or "",
            "Lost Reason": m2o_name(lead["lost_reason_id"]), "Expected Revenue": lead["expected_revenue"],
            "Last Update": written.strftime("%Y-%m-%d %H:%M"),
            "Odoo Link": f"{base}/web#id={lead['id']}&model=crm.lead&view_type=form" + (f"&cids={company}" if company else ""),
        })
    rows.sort(key=lambda r: (r["Issue"], r["Salesperson"], r["Last Update"]))

    out = Path(args.out)
    with out.open("w", newline="", encoding="utf-8-sig") as fh:  # BOM: Excel opens Arabic names correctly
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]) if rows else ["Issue"])
        writer.writeheader()
        writer.writerows(rows)
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["Issue"]] = counts.get(r["Issue"], 0) + 1
    print(f"{len(leads)} opportunities read; {len(rows)} listed -> {out}")
    for k, v in sorted(counts.items()):
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
