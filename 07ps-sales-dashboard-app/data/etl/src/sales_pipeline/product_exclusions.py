"""ProductExclusions.xlsx -- the manual exclusion list of the Product pages (optional input file, like BlockedCustomers.xlsx).

Sheets (the hidden "Lists" sheet and "Instructions" are ignored):
  Customers   Company | Odoo Partner ID  | Action Exclude/Keep | Active Yes/No | reference columns
  Categories  Company | Odoo Category ID | Action Exclude      | Active Yes/No | reference columns
  Products    Company | Odoo Product ID  | Action Exclude/Keep | Active Yes/No | reference columns

Company = All, Majaal or Tika (a Tika row applies to Tika only). Matching is on the Odoo id only; names are reference.
Rows with Active = No are ignored (counted). A row that cannot be read (bad company, id, action or active value) is an
invalid row: it is listed in `issues`, logged on every run and refused on upload -- never silently dropped.
A missing file, or a file with only headers, means no extra exclusions.

How the rules are applied: ProductDashboardBuilder (product_dashboard.py), before any Product calculation.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

EXCLUSIONS_FILE = "ProductExclusions.xlsx"
COMPANIES = {"all": "All", "majaal": "Majaal", "tika": "Tika"}
ACTIVE = {"yes": True, "y": True, "true": True, "1": True, "no": False, "n": False, "false": False, "0": False}
COLUMNS = ["Company", "OdooID", "Action", "Active"]
log = logging.getLogger(__name__)


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
    return pd.DataFrame({"Company": pd.Series(dtype=object), "OdooID": pd.Series(dtype="int64"), "Action": pd.Series(dtype=object)})


@dataclass
class ProductExclusions:
    """Active rules per sheet: DataFrame[Company ('All'|'Majaal'|'Tika'), OdooID (int), Action ('Exclude'|'Keep')]."""

    customers: pd.DataFrame = field(default_factory=_empty_rules)
    categories: pd.DataFrame = field(default_factory=_empty_rules)
    products: pd.DataFrame = field(default_factory=_empty_rules)
    ignored: dict[str, int] = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)
    source: str | None = None

    @classmethod
    def empty(cls, source: str | None = None) -> "ProductExclusions":
        return cls(source=source)

    def rules(self, sheet: str) -> pd.DataFrame:
        return {"Customers": self.customers, "Categories": self.categories, "Products": self.products}[sheet]

    def ids(self, sheet: str, action: str, company: str) -> set[int]:
        """Ids of the active `action` rows of `sheet` that apply to `company` (its own rows and the All rows)."""
        r = self.rules(sheet)
        r = r[r["Action"].eq(action) & r["Company"].isin(["All", company])]
        return {int(v) for v in r["OdooID"]}

    def counts(self) -> dict[str, dict[str, int]]:
        return {s.name: self.rules(s.name)["Action"].value_counts().to_dict() for s in SHEETS}


class ProductExclusionsLoader:
    """Reads ProductExclusions.xlsx the BlockedCustomersLoader way: strip the headers, rename to the internal names."""

    def load(self, path: str | Path | None) -> ProductExclusions:
        if path is None or not Path(path).is_file():
            return ProductExclusions.empty(source=None)
        out = ProductExclusions.empty(source=str(path))
        with pd.ExcelFile(Path(path)) as workbook:
            names = {n.strip().lower(): n for n in workbook.sheet_names}
            for spec in SHEETS:
                sheet = names.get(spec.name.lower())
                if sheet is None:
                    out.issues.append(f"{spec.name}: sheet missing (no {spec.name.lower()} rules read)")
                    continue
                rules, ignored, issues = self._read_sheet(pd.read_excel(workbook, sheet_name=sheet, dtype=object), spec)
                setattr(out, spec.name.lower(), rules)
                out.ignored[spec.name] = ignored
                out.issues.extend(issues)
        return out

    @staticmethod
    def _text(v: Any) -> str:
        return "" if v is None or (not isinstance(v, str) and pd.isna(v)) else str(v).strip()

    def _read_sheet(self, df: pd.DataFrame, spec: SheetSpec) -> tuple[pd.DataFrame, int, list[str]]:
        df = df.copy()
        df.columns = [str(c).strip() for c in df.columns]
        df = df.rename(columns={spec.id_header: "OdooID", "Odoo ID": "OdooID"})
        missing = [c for c in COLUMNS if c not in df.columns]
        if missing:
            return _empty_rules(), 0, [f"{spec.name}: missing column(s) {', '.join(missing)} -- sheet ignored"]
        rows: list[dict[str, Any]] = []
        issues: list[str] = []
        ignored = 0
        for i, r in df.iterrows():
            excel_row = int(i) + 2  # header is row 1
            values = {c: self._text(r[c]) for c in COLUMNS}
            if not any(values.values()):
                continue  # blank line
            active = ACTIVE.get(values["Active"].lower())
            if active is False:
                ignored += 1
                continue
            problems = []
            if active is None:
                problems.append(f"Active must be Yes or No (got {values['Active'] or 'blank'})")
            company = COMPANIES.get(values["Company"].lower())
            if company is None:
                problems.append(f"Company must be All, Majaal or Tika (got {values['Company'] or 'blank'})")
            odoo_id = self._odoo_id(values["OdooID"])
            if odoo_id is None:
                problems.append(f"{spec.id_header} must be a whole positive number (got {values['OdooID'] or 'blank'})")
            action = next((a for a in spec.actions if a.lower() == values["Action"].lower()), None)
            if action is None:
                problems.append(f"Action must be {' or '.join(spec.actions)} (got {values['Action'] or 'blank'})")
            if problems:
                issues.append(f"{spec.name} row {excel_row}: {'; '.join(problems)} -- row not applied")
                continue
            rows.append({"Company": company, "OdooID": odoo_id, "Action": action})
        rules = pd.DataFrame(rows, columns=["Company", "OdooID", "Action"]) if rows else _empty_rules()
        if not rules.empty:
            rules["OdooID"] = rules["OdooID"].astype("int64")
            rules = rules.drop_duplicates().reset_index(drop=True)
        return rules, ignored, issues

    @staticmethod
    def _odoo_id(text: str) -> int | None:
        try:
            number = float(text)
        except ValueError:
            return None
        return int(number) if number.is_integer() and number > 0 else None


def log_summary(exclusions: ProductExclusions) -> None:
    if exclusions.source is None:
        log.info("Product pages: %s not found -- no extra exclusions (Backoffice / Inter Company / intercompany rule still applies)", EXCLUSIONS_FILE)
        return
    log.info("Product pages: %s active rules %s, Active = No rows ignored %s", EXCLUSIONS_FILE, exclusions.counts(), exclusions.ignored)
    for issue in exclusions.issues:
        log.warning("Product pages: %s %s", EXCLUSIONS_FILE, issue)
