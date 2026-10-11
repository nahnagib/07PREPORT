"""The recipients workbook: who gets which report by email.

Sheet "Salespeople" (one row per Odoo salesperson)
    Odoo User ID | Salesperson Name (Odoo) | Email | CC | Send Report | Weekly Target | Team | Odoo Email (reference) | Notes
Sheet "Team Summary"
    Name | Email | Send Report

A report row is matched to the workbook by Odoo User ID when it is filled, else by the name (trimmed, case-insensitive)
against the Odoo user name or the dashboard name. Only rows with Send Report = Yes and an Email are emailed.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation

log = logging.getLogger("ar_weekly.recipients")

SP_COLS = ["Odoo User ID", "Salesperson Name (Odoo)", "Email", "CC", "Send Report", "Weekly Target", "Team",
           "Odoo Email (reference)", "Notes"]
TEAM_COLS = ["Name", "Email", "Send Report"]
EMAIL_RE = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$")
HEAD_FILL = PatternFill("solid", fgColor="25313F")
INPUT_FILL = PatternFill("solid", fgColor="FFF8DC")
WIDTHS = [13, 30, 32, 34, 13, 15, 26, 30, 30]


def _norm(v: Any) -> str:
    return re.sub(r"\s+", " ", str(v or "").strip()).lower()


def _blank(v: Any) -> bool:
    return v is None or (isinstance(v, float) and pd.isna(v)) or str(v).strip() == ""


def _emails(v: Any) -> list[str]:
    return [e.strip() for e in re.split(r"[,;\s]+", "" if _blank(v) else str(v)) if e.strip()]


@dataclass
class Recipient:
    row: int
    user_id: int | None
    name: str
    email: str
    cc: list[str]
    send: bool
    target: float | None


@dataclass
class Recipients:
    path: Path | None
    people: list[Recipient] = field(default_factory=list)
    team: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    @property
    def loaded(self) -> bool:
        return self.path is not None

    def find(self, rep_id: int, *names: str) -> Recipient | None:
        for p in self.people:
            if p.user_id and rep_id and p.user_id == rep_id:
                return p
        wanted = {_norm(n) for n in names if n}
        for p in self.people:
            if not p.user_id and _norm(p.name) in wanted:
                return p
        return None


def load(path: Path | None) -> Recipients:
    if not path or not path.is_file():
        if path:
            log.warning("Recipients file not found: %s", path)
        return Recipients(None)
    try:
        x = pd.read_excel(path, sheet_name=None, dtype=object)
    except Exception as exc:
        raise RuntimeError(f"Cannot read the recipients file {path.name} ({exc}). Is it open in Excel?") from None
    r = Recipients(path)
    sp = x.get("Salespeople")
    if sp is None:
        r.problems.append("sheet 'Salespeople' is missing")
        return r
    for i, row in sp.iterrows():
        name = "" if _blank(row.get("Salesperson Name (Odoo)")) else str(row["Salesperson Name (Odoo)"]).strip()
        uid_raw = row.get("Odoo User ID")
        try:
            uid = None if _blank(uid_raw) else int(float(uid_raw))
        except ValueError:
            r.problems.append(f"Salespeople row {i + 2}: Odoo User ID '{uid_raw}' is not a number")
            uid = None
        if not name and uid is None:
            continue
        emails = _emails(row.get("Email"))
        email = emails[0] if emails else ""
        cc = _emails(row.get("CC")) + emails[1:]
        for e in [email] + cc:
            if e and not EMAIL_RE.match(e):
                r.problems.append(f"Salespeople row {i + 2} ({name}): '{e}' does not look like an email address (skipped)")
        email = email if EMAIL_RE.match(email or "") else ""
        cc = [e for e in cc if EMAIL_RE.match(e)]
        send = _norm(row.get("Send Report")) in ("yes", "y", "true", "1", "نعم")
        tgt = row.get("Weekly Target")
        try:
            target = None if _blank(tgt) else float(str(tgt).replace(",", ""))
        except ValueError:
            r.problems.append(f"Salespeople row {i + 2} ({name}): Weekly Target '{tgt}' is not a number")
            target = None
        r.people.append(Recipient(i + 2, uid, name, email, cc, send, target))
    ts = x.get("Team Summary")
    for i, row in (ts if ts is not None else pd.DataFrame(columns=TEAM_COLS)).iterrows():
        if _norm(row.get("Send Report")) in ("yes", "y", "true", "1", "نعم"):
            for e in _emails(row.get("Email")):
                (r.team.append(e) if EMAIL_RE.match(e) else
                 r.problems.append(f"Team Summary row {i + 2}: '{e}' does not look like an email address"))
    ids = [p.user_id for p in r.people if p.user_id]
    dup = {u for u in ids if ids.count(u) > 1}
    if dup:
        r.problems.append(f"Odoo User ID listed more than once: {sorted(dup)} (the first row wins)")
    for p in r.problems:
        log.warning("Recipients file: %s", p)
    log.info("Recipients file: %s salespeople (%s to email), %s team-summary addresses", len(r.people),
             sum(1 for p in r.people if p.send and p.email), len(r.team))
    return r


# -- building / updating the workbook ---------------------------------------------------------------------------
def _style_sheet(ws, widths: list[int], input_cols: set[int], n_rows: int) -> None:
    for j, w in enumerate(widths, 1):
        ws.column_dimensions[ws.cell(row=1, column=j).column_letter].width = w
        c = ws.cell(row=1, column=j)
        c.fill, c.font = HEAD_FILL, Font(bold=True, color="FFFFFF")
        c.alignment = Alignment(wrap_text=True, vertical="center")
        if j in input_cols:
            for i in range(2, max(n_rows, 1) + 202):
                ws.cell(row=i, column=j).fill = INPUT_FILL
    ws.freeze_panes = "C2" if ws.title == "Salespeople" else "A2"
    ws.row_dimensions[1].height = 30


def _yes_no(ws, col_letter: str) -> None:
    dv = DataValidation(type="list", formula1='"Yes,No"', allow_blank=True, showDropDown=False)
    dv.error, dv.errorTitle = "Choose Yes or No", "Send Report"
    ws.add_data_validation(dv)
    dv.add(f"{col_letter}2:{col_letter}1000")


def build(path: Path, rows: list[dict[str, Any]]) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "Salespeople"
    ws.append(SP_COLS)
    for r in rows:
        ws.append([r.get(c) for c in SP_COLS])
    _style_sheet(ws, WIDTHS, {3, 4, 5, 6, 9}, len(rows))
    _yes_no(ws, "E")
    for i in range(2, len(rows) + 2):
        ws.cell(row=i, column=6).number_format = "#,##0"
    ws.auto_filter.ref = f"A1:I{len(rows) + 1}"

    t = wb.create_sheet("Team Summary")
    t.append(TEAM_COLS)
    t.append(["Sales Manager", "", "No"])
    t.append(["GCCO", "", "No"])
    _style_sheet(t, [28, 36, 13], {1, 2, 3}, 3)
    _yes_no(t, "C")

    h = wb.create_sheet("How to use")
    notes = [
        ("Who gets the weekly AR report by email", True),
        ("", False),
        ("Salespeople sheet: one row per salesperson. Fill the yellow columns.", False),
        ("• Odoo User ID and Salesperson Name: how the row is matched to Odoo. The ID is the most reliable; "
         "when it is empty the name must match the Odoo user name exactly (spaces and upper/lower case are ignored).", False),
        ("• Email: where the report goes. Several addresses: separate them with commas.", False),
        ("• CC: optional, e.g. the team leader. Comma-separated.", False),
        ("• Send Report: Yes = emailed every week. No = the report is still produced in the output folder but not emailed.", False),
        ("• Weekly Target: optional fixed collection target for that person (else 20% of their starting overdue).", False),
        ("• Team / Odoo Email (reference): information only, never used to send.", False),
        ("", False),
        ("Team Summary sheet: managers who get the all-salespeople summary. Set Send Report = Yes.", False),
        ("", False),
        ("New salespeople in Odoo: run  run_weekly.cmd --update-recipients  to append them here (existing rows are "
         "never changed). Check the file before each run with  run_weekly.cmd --dry-run-email.", False),
        ("Close this file in Excel before the weekly run: Excel locks it.", False),
    ]
    for i, (text, bold) in enumerate(notes, 1):
        c = h.cell(row=i, column=1, value=text)
        c.font = Font(bold=bold, size=13 if bold else 11)
        c.alignment = Alignment(wrap_text=True, vertical="top")
    h.column_dimensions["A"].width = 120
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path


def _last_data_row(ws, ncols: int) -> int:
    """Last row holding a value (the yellow input formatting extends far below the data, so max_row is not it)."""
    for r in range(ws.max_row, 1, -1):
        if any(not _blank(ws.cell(row=r, column=c).value) for c in range(1, ncols + 1)):
            return r
    return 1


def append_missing(path: Path, people: list[dict[str, Any]]) -> int:
    """Append salespeople (dicts with SP_COLS keys) that are not in the workbook yet; existing rows are untouched.
    Also fills 'Odoo Email (reference)' where it is empty."""
    current = load(path)
    wb = load_workbook(path)
    ws = wb["Salespeople"]
    header = [c.value for c in ws[1]]
    col = {name: header.index(name) + 1 for name in header if name}
    added = 0
    for p in people:
        hit = current.find(int(p.get("Odoo User ID") or 0), p.get("Salesperson Name (Odoo)", ""), p.get("_alt_name", ""))
        if hit:
            ref = col.get("Odoo Email (reference)")
            if ref and p.get("Odoo Email (reference)") and _blank(ws.cell(row=hit.row, column=ref).value):
                ws.cell(row=hit.row, column=ref, value=p["Odoo Email (reference)"])
            continue
        r = _last_data_row(ws, len(header)) + 1
        for name, j in col.items():
            if name in p:
                c = ws.cell(row=r, column=j, value=p[name])
                if name in ("Email", "CC", "Send Report", "Weekly Target", "Notes"):
                    c.fill = INPUT_FILL
        added += 1
    ws.auto_filter.ref = f"A1:{ws.cell(row=1, column=len(header)).column_letter}{_last_data_row(ws, len(header))}"
    wb.save(path)
    return added
