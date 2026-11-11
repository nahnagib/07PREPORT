"""ProductExclusions.xlsx -- the manual exclusion list of the Product pages (optional input file, like BlockedCustomers.xlsx).

Only the sheets Customers, Categories and Products are read; Instructions, Summary, Lists and "Price Fix (Odoo)" (for
information only) never are. Optional columns Reason, Added By, Added Date and Notes are kept for the log only.
  Customers   Company | Odoo Partner ID  | Action Exclude/Keep | Active Yes/No | reference columns
  Categories  Company | Odoo Category ID | Action Exclude      | Active Yes/No | reference columns
  Products    Company | Odoo Product ID  | Action Exclude/Keep | Active Yes/No | reference columns

Company = All, Majaal or Tika (a Tika row applies to Tika only). Matching is on the Odoo id only; names are reference.
Columns are found by their header name (any order, case and surrounding spaces ignored); the grey "(reference)" columns
are never read for matching. Company / Action / Active are trimmed and case-insensitive. The id must be a whole positive
number: 123, 123.0 or the text "123" all read as 123; blank, a decimal (123.5) or text is SKIPPED with its sheet and Excel
row. Fully blank rows (the sheets carry data validation down to row 2000) are ignored.
Rows with Active = No are IGNORED (counted): such a row does nothing at all -- it does NOT keep a product that another
rule (archived, a category, a raw-material category) removes. Only Action = Keep with Active = Yes keeps a product.
Duplicates (same Company + id): rows that agree apply once (warning); rows that conflict (Exclude vs Keep) are all
SKIPPED and reported. The same id under All and a company: the company's row wins for that company (ids()).
A row that cannot be read (missing / invalid id, unknown Company, Action or Active value) is SKIPPED with a warning naming
its sheet and Excel row (`skipped`); the other rows still apply. Ids that are not in Odoo, or a product of another company
than the row's, are warnings only (`warnings`, added by ProductDashboardBuilder, which has the Odoo catalog).
A missing sheet or required column makes the whole file invalid (ExclusionsFileInvalid): the upload is rejected and a run
keeps using the last valid file (load_with_fallback: the copy kept in the input-backup folder after every good load).
A missing file, or a file with only headers, means no extra exclusions.

How the rules are applied: ProductDashboardBuilder (product_dashboard.py), before any Product calculation.
"""

from __future__ import annotations

import logging
import numbers
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

EXCLUSIONS_FILE = "ProductExclusions.xlsx"
COMPANIES = {"all": "All", "majaal": "Majaal", "tika": "Tika"}
ACTIVE = {"yes": True, "y": True, "true": True, "1": True, "no": False, "n": False, "false": False, "0": False}
COLUMNS = ["Company", "OdooID", "Action", "Active"]
OPTIONAL_COLUMNS = ["Reason", "Added By", "Added Date", "Notes"]
LAST_VALID_NAME = "ProductExclusions.last-valid.xlsx"
log = logging.getLogger(__name__)


class ExclusionsFileInvalid(ValueError):
    """A required sheet or column is missing: the file cannot be applied at all."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


@dataclass(frozen=True)
class SheetSpec:
    name: str
    id_header: str
    actions: tuple[str, ...]


SHEETS: tuple[SheetSpec, ...] = (
    SheetSpec("Customers", "Odoo Partner ID", ("Exclude", "Keep")),
    SheetSpec("Categories", "Odoo Category ID", ("Exclude",)),
    SheetSpec("Products", "Odoo Product ID", ("Exclude", "Keep")),
)
SHEET_BY_NAME = {s.name: s for s in SHEETS}


def _empty_rules() -> pd.DataFrame:
    return pd.DataFrame({"Company": pd.Series(dtype=object), "OdooID": pd.Series(dtype="int64"), "Action": pd.Series(dtype=object),
                         "Row": pd.Series(dtype="int64")})


@dataclass
class ProductExclusions:
    """Active rules per sheet: DataFrame[Company ('All'|'Majaal'|'Tika'), OdooID (int), Action ('Exclude'|'Keep')]."""

    customers: pd.DataFrame = field(default_factory=_empty_rules)
    categories: pd.DataFrame = field(default_factory=_empty_rules)
    products: pd.DataFrame = field(default_factory=_empty_rules)
    ignored: dict[str, int] = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)
    # rows skipped: {"sheet", "row" (Excel row number), "name" (reference column), "reason"}; also in `issues` for the log
    skipped: list[dict[str, Any]] = field(default_factory=list)
    # rows applied with a remark (duplicate applied once; id not in Odoo; product of another company): same shape
    warnings: list[dict[str, Any]] = field(default_factory=list)
    source: str | None = None
    modified_utc: str | None = None  # the file's last-modified time (= upload time: an upload replaces the file)
    fallback_reason: str | None = None  # set when the current file is invalid and the last valid one was used

    @classmethod
    def empty(cls, source: str | None = None) -> "ProductExclusions":
        return cls(source=source)

    def rules(self, sheet: str) -> pd.DataFrame:
        return {"Customers": self.customers, "Categories": self.categories, "Products": self.products}[sheet]

    def ids(self, sheet: str, action: str, company: str) -> set[int]:
        """Ids of the active `action` rows of `sheet` that apply to `company`: its own rows, plus the All rows of the ids
        it has no own row for (a company row wins over the All row of the same id, for that company)."""
        r = self.rules(sheet)
        own = r[r["Company"].eq(company)]
        everyone = r[r["Company"].eq("All") & ~r["OdooID"].isin(own["OdooID"])]
        both = pd.concat([own, everyone])
        return {int(v) for v in both.loc[both["Action"].eq(action), "OdooID"]}

    def counts(self) -> dict[str, dict[str, int]]:
        return {s.name: {str(k): int(v) for k, v in self.rules(s.name)["Action"].value_counts().to_dict().items()} for s in SHEETS}

    def summary(self) -> dict[str, Any]:
        """What the ETL Control Center shows about the file itself."""
        return {
            "file": EXCLUSIONS_FILE if self.source else None,
            "uploaded_at_utc": self.modified_utc,
            "fallback_reason": self.fallback_reason,
            "active_rows": self.counts(),
            "inactive_rows": {k: int(v) for k, v in self.ignored.items()},
            "skipped_rows": len(self.skipped),
            "skipped": self.skipped[:200],
            "warning_rows": len(self.warnings),
            "warnings": self.warnings[:200],
        }


class ProductExclusionsLoader:
    """Reads ProductExclusions.xlsx the BlockedCustomersLoader way: strip the headers, rename to the internal names."""

    def load(self, path: str | Path | None) -> ProductExclusions:
        """Raises ExclusionsFileInvalid when a required sheet or column is missing; skips (and lists) unreadable rows."""
        if path is None or not Path(path).is_file():
            return ProductExclusions.empty(source=None)
        out = ProductExclusions.empty(source=str(path))
        out.modified_utc = pd.Timestamp(Path(path).stat().st_mtime, unit="s", tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ")
        problems: list[str] = []
        frames: dict[str, pd.DataFrame] = {}
        with pd.ExcelFile(Path(path)) as workbook:
            names = {n.strip().lower(): n for n in workbook.sheet_names}
            for spec in SHEETS:
                sheet = names.get(spec.name.lower())
                if sheet is None:
                    problems.append(f"sheet '{spec.name}' is missing")
                    continue
                df = pd.read_excel(workbook, sheet_name=sheet, dtype=object)
                df.columns = [str(c).strip() for c in df.columns]
                by_lower = {c.lower(): c for c in df.columns}
                required = ("Company", spec.id_header, "Action", "Active")
                missing = [c for c in required if c.lower() not in by_lower and not (c == spec.id_header and "odoo id" in by_lower)]
                if missing:
                    problems.append(f"sheet '{spec.name}' is missing column(s) {', '.join(missing)}")
                    continue
                # header names, not positions: any order and case; renamed to the canonical names
                canonical = (*required, *OPTIONAL_COLUMNS, "Odoo ID")
                frames[spec.name] = df.rename(columns={by_lower[c.lower()]: c for c in canonical if c.lower() in by_lower})
        if problems:
            raise ExclusionsFileInvalid(problems)
        for spec in SHEETS:
            rules, ignored, skipped, warnings = self._read_sheet(frames[spec.name], spec)
            setattr(out, spec.name.lower(), rules)
            out.ignored[spec.name] = ignored
            out.skipped.extend(skipped)
            out.warnings.extend(warnings)
            out.issues.extend(f"{x['sheet']} row {x['row']}: {x['reason']} -- row skipped" for x in skipped)
            out.issues.extend(f"{x['sheet']} row {x['row']}: {x['reason']}" for x in warnings)
        return out

    def load_with_fallback(self, path: str | Path | None, backup_dir: str | Path | None) -> ProductExclusions:
        """The run's rules: the current file when it is valid (a copy is kept in `backup_dir` as the last valid file);
        otherwise the last valid copy, with `fallback_reason` saying why. No valid copy -> no file rules (logged)."""
        last_valid = Path(backup_dir) / LAST_VALID_NAME if backup_dir else None
        try:
            out = self.load(path)
        except ExclusionsFileInvalid as exc:
            reason = f"{EXCLUSIONS_FILE} is invalid ({exc}); the last valid file is used until a valid one is uploaded"
            if last_valid is not None and last_valid.is_file():
                try:
                    out = self.load(last_valid)
                    out.fallback_reason = reason
                    log.error("Product pages: %s", reason)
                    return out
                except ExclusionsFileInvalid:
                    pass
            log.error("Product pages: %s is invalid (%s) and no last valid copy exists -- no file rules this run", EXCLUSIONS_FILE, exc)
            empty = ProductExclusions.empty(source=None)
            empty.fallback_reason = f"{EXCLUSIONS_FILE} is invalid ({exc}) and no last valid copy exists: no file rules applied"
            return empty
        if out.source is not None and last_valid is not None:
            try:
                last_valid.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(Path(out.source), last_valid)
            except OSError as exc:  # a read-only backup folder only costs the fallback, never the run
                log.warning("Product pages: could not keep the last valid %s copy in %s: %s", EXCLUSIONS_FILE, last_valid.parent, exc)
        return out

    @staticmethod
    def _text(v: Any) -> str:
        return "" if v is None or (not isinstance(v, str) and pd.isna(v)) else str(v).strip()

    def _read_sheet(self, df: pd.DataFrame, spec: SheetSpec) -> tuple[pd.DataFrame, int, list[dict[str, Any]], list[dict[str, Any]]]:
        df = df.copy()
        df.columns = [str(c).strip() for c in df.columns]
        df = df.rename(columns={spec.id_header: "OdooID", "Odoo ID": "OdooID"})
        reference = [c for c in df.columns if "(reference)" in c.lower()]
        rows: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        ignored = 0
        for i, r in df.iterrows():
            excel_row = int(i) + 2  # header is row 1; pandas keeps the blank rows in between, so this is the sheet row
            values = {c: self._text(r[c]) for c in COLUMNS}
            if not any(values.values()):
                continue  # blank line, or a row past the data (validation-only rows down to row 2000)
            name = next((self._text(r[c]) for c in reference if self._text(r[c])), "")
            active = ACTIVE.get(values["Active"].lower())
            if active is False:
                ignored += 1  # Active = No: ignored -- it keeps nothing and removes nothing
                continue
            problems = []
            if active is None:
                problems.append(f"Active must be Yes or No (got {values['Active'] or 'blank'})")
            company = COMPANIES.get(values["Company"].lower())
            if company is None:
                problems.append(f"Company must be All, Majaal or Tika (got {values['Company'] or 'blank'})")
            odoo_id = self._odoo_id(r["OdooID"])
            if odoo_id is None:
                problems.append(f"{spec.id_header} must be a whole positive number (got {values['OdooID'] or 'blank'})")
            action = next((a for a in spec.actions if a.lower() == values["Action"].lower()), None)
            if action is None:
                problems.append(f"Action must be {' or '.join(spec.actions)} (got {values['Action'] or 'blank'})")
            if problems:
                skipped.append({"sheet": spec.name, "row": excel_row, "name": name, "reason": "; ".join(problems)})
                continue
            rows.append({"Company": company, "OdooID": odoo_id, "Action": action, "Row": excel_row, "Name": name,
                         "Log": {c: self._text(r[c]) for c in OPTIONAL_COLUMNS if c in df.columns and self._text(r[c])}})
        rows, conflicts, warnings = self._resolve_duplicates(rows, spec)
        skipped = sorted(skipped + conflicts, key=lambda x: x["row"])
        for row in rows:  # Reason / Added By / Added Date / Notes: for the log only, never matched on
            log.debug("Product pages: %s %s %s %s %s", spec.name, row["Company"], row["OdooID"], row["Action"], row["Log"])
        rules = pd.DataFrame([{k: row[k] for k in ("Company", "OdooID", "Action", "Row")} for row in rows]) if rows else _empty_rules()
        if not rules.empty:
            rules["OdooID"] = rules["OdooID"].astype("int64")
            rules["Row"] = rules["Row"].astype("int64")
        return rules.reset_index(drop=True), ignored, skipped, warnings

    @staticmethod
    def _resolve_duplicates(rows: list[dict[str, Any]], spec: SheetSpec) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        """Same Company + id more than once: the same Action -> applied once (the first row; a warning on the others);
        different Actions (Exclude vs Keep) -> every row of that id is skipped and reported."""
        groups: dict[tuple[str, int], list[dict[str, Any]]] = {}
        for row in rows:
            groups.setdefault((row["Company"], row["OdooID"]), []).append(row)
        kept: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        warnings: list[dict[str, Any]] = []
        for (company, odoo_id), group in groups.items():
            if len(group) == 1:
                kept.append(group[0])
                continue
            if len({g["Action"] for g in group}) > 1:
                actions = " vs ".join(f"{g['Action']} (row {g['Row']})" for g in group)
                for g in group:
                    skipped.append({"sheet": spec.name, "row": g["Row"], "name": g["Name"],
                                    "reason": f"{company} {spec.id_header} {odoo_id} conflicts: {actions} -- every row of it is skipped"})
                continue
            kept.append(group[0])
            for g in group[1:]:
                warnings.append({"sheet": spec.name, "row": g["Row"], "name": g["Name"],
                                 "reason": f"duplicate of row {group[0]['Row']} ({company} {spec.id_header} {odoo_id}, {g['Action']}): applied once"})
        kept.sort(key=lambda g: g["Row"])
        return kept, skipped, warnings

    @staticmethod
    def _odoo_id(raw: Any) -> int | None:
        """A whole positive id: 123, 123.0 or the text "123" (also "123.0") -> 123; anything else (blank, 123.5, text,
        a date, TRUE/FALSE, 0 or negative) -> None."""
        if raw is None or isinstance(raw, bool):
            return None
        if isinstance(raw, numbers.Integral):
            return int(raw) if int(raw) > 0 else None
        if isinstance(raw, numbers.Real):
            number = float(raw)
            return int(number) if number == number and number.is_integer() and number > 0 else None
        if isinstance(raw, str):
            text = raw.strip()
            if re.fullmatch(r"\d+(\.0+)?", text):
                number = int(text.split(".")[0])
                return number if number > 0 else None
        return None


def backup_dir() -> Path:
    """Where the last valid copy is kept: the ETL Control Center's input-backup folder (ETL_INPUT_BACKUP_DIR, writable in
    the etl-api container that runs the ETL), else data/etl/input_backups."""
    raw = os.getenv("ETL_INPUT_BACKUP_DIR", "").strip()
    return Path(raw) if raw else Path(__file__).resolve().parents[2] / "input_backups"


def load_for_run(path: str | Path | None) -> ProductExclusions:
    """The rules a run applies: the current file, or the last valid one when the current file is invalid."""
    return ProductExclusionsLoader().load_with_fallback(path, backup_dir())


def log_summary(exclusions: ProductExclusions) -> None:
    if exclusions.source is None:
        log.info("Product pages: %s not found -- no extra exclusions (Backoffice / Inter Company / intercompany rule still applies)", EXCLUSIONS_FILE)
        return
    log.info("Product pages: %s (modified %s) active rules %s, Active = No rows ignored %s, rows skipped %s", EXCLUSIONS_FILE,
             exclusions.modified_utc, exclusions.counts(), exclusions.ignored, len(exclusions.skipped))
    for issue in exclusions.issues:
        log.warning("Product pages: %s %s", EXCLUSIONS_FILE, issue)
