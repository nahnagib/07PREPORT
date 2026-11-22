"""Reload fact_sales_targets from Input/sales_targets.xlsx ONLY -- no Odoo, no sales rebuild (2026-11-17).

The full ETL builds the targets from the same sheet through the legacy transform (sales_org enrichment) and then the
conform step (departments/sales/conform.py: the sheet's own keys, the Director checks). This script rebuilds the same
rows from the sheet and the warehouse's own dimensions (dim_sales_team for a blank team / company / segment / city,
dim_segment for SegmentKey, dim_salesperson for a blank distribution channel) and runs the same conform checks.

Safety: every row that is already in fact_sales_targets (same YearMonth, SalespersonKey, SalesTeamKey, CompanyKey) must
come out identical on every column the ETL writes; if any differs, NOTHING is written and the script exits 2 (the
difference means this shortcut would not reproduce the full ETL -- run the full sales refresh instead). New rows (e.g.
the Director rows) and removed rows are listed. The table is then replaced in one transaction.

    python scripts/sales/reload_targets.py --dry-run   # build, check, list the changes; writes nothing
    python scripts/sales/reload_targets.py             # same, then replace fact_sales_targets

Settings: the ETL's .env (DB_* / DB_URL, ETL_INPUT_DIR).
"""

from __future__ import annotations

import argparse
import logging
import sys
import uuid
from pathlib import Path

ETL_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ETL_ROOT))
sys.path.insert(0, str(ETL_ROOT / "src"))

import pandas as pd  # noqa: E402
from core.keys import UNKNOWN, UNKNOWN_TEXT  # noqa: E402
from departments.sales import conform as cf  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

TABLE = "fact_sales_targets"
PK = ["YearMonth", "SalespersonKey", "SalesTeamKey", "CompanyKey"]
TEXT_COLS = ["TargetLevel", "Company", "SalesTeam", "Salesperson", "SalesSegment", "City", "DistributionChannel", "Currency"]
NUM_COLS = ["Target_Revenue", "Target_Volume", "ASP_LY", "ASP_ThisYear"]
NUM_TOLERANCE = 0.001  # the table stores DECIMAL(20,6); the sheet holds floats
COLUMNS = ["Year", "Month", "YearMonth", "TargetDate", "DateKey", "TargetLevel", "Company", "CompanyKey", "SalesTeam", "SalesTeamKey",
           "Salesperson", "SalespersonKey", "SalesSegment", "SegmentKey", "City", "DistributionChannel", "ChannelKey", "Currency",
           *NUM_COLS]


def _text(v):
    t = cf._ident_text(v)
    return " ".join(t.split()) if t else None


def _meta(meta, col):
    """A team attribute from dim_sales_team; its 'Unknown' placeholder is no value (the legacy enrichment leaves it blank)."""
    v = _text(getattr(meta, col)) if meta is not None else None
    return None if v in (None, "Unknown") else v


def build(sheet: pd.DataFrame, teams: pd.DataFrame, segments: dict[str, int], people_channel: dict[int, str]) -> pd.DataFrame:
    """fact_sales_targets rows from the sheet rows the loader keeps (Year and Month present, Month 1-12)."""
    s = cf.target_sheet_rows(sheet)
    team = {r.SalesTeamKey: r for r in teams.itertuples()}
    rows = []
    for r in s.to_dict("records"):
        year, month = int(r["Year"]), int(r["Month"])
        team_key = cf._team_key(r.get("SalesTeamKey"))
        meta = team.get(team_key) if team_key != UNKNOWN_TEXT else None
        person = _text(r.get("Salesperson"))
        level = _text(r.get("TargetLevel")) or ("Salesperson" if person else "SalesTeam")
        person_key = int(r["SalespersonKey"]) if pd.notna(r.get("SalespersonKey")) else UNKNOWN
        segment = _text(r.get("SalesSegment")) or _meta(meta, "SalesSegment") or "Unknown"
        target_date = pd.to_datetime(r.get("TargetDate"), errors="coerce")  # as the legacy TargetsLoader parses it
        if pd.isna(target_date):
            target_date = pd.Timestamp(year, month, 1)
        rows.append({
            "Year": year, "Month": month, "YearMonth": _text(r.get("YearMonth")) or f"{year}-{month:02d}",
            "TargetDate": target_date, "DateKey": int(target_date.strftime("%Y%m%d")),
            "TargetLevel": level,
            "Company": _text(r.get("Company")) or _meta(meta, "SalesTeamCompany"),
            "CompanyKey": int(r["CompanyKey"]) if pd.notna(r.get("CompanyKey")) else UNKNOWN,
            "SalesTeam": _text(r.get("SalesTeam")) or _meta(meta, "SalesTeam"),
            "SalesTeamKey": team_key,
            "Salesperson": person, "SalespersonKey": person_key,
            "SalesSegment": segment, "SegmentKey": segments.get(segment, UNKNOWN),
            "City": _text(r.get("City")) or _meta(meta, "SalesCity"),
            "DistributionChannel": _text(r.get("DistributionChannel")) or people_channel.get(person_key) or "Unknown",
            "ChannelKey": UNKNOWN,  # conform: the legacy codes are all Unknown on the targets
            "Currency": _text(r.get("Currency")),
            **{c: (float(r[c]) if pd.notna(pd.to_numeric(r.get(c), errors="coerce")) else None) for c in NUM_COLS},
        })
    out = pd.DataFrame(rows, columns=COLUMNS)
    dupes = out[out.duplicated(PK, keep=False)]
    if not dupes.empty:
        raise ValueError(f"duplicate {PK} in sales_targets.xlsx: {dupes[PK].head(5).to_dict('records')}")
    return out


def run_checks(sheet: pd.DataFrame, built: pd.DataFrame) -> list[dict]:
    """The ETL's own conform checks: every row has its SalespersonKey, a Director row names B2B / B2C, Director months
    equal their segment's Salesperson sum (WARNING only)."""
    keys = cf.target_sheet_rows(sheet)
    fact = built[["YearMonth", "Target_Revenue", "Target_Volume", "TargetLevel", "SalesTeamKey", "SegmentKey", "CompanyKey"]].copy()
    fact["ChannelKey"] = UNKNOWN
    out = cf.Conformed()
    cf.conform_targets(fact, keys, out)
    return out.notes["fact_sales_targets.director_target_mismatches"]


def _norm(df: pd.DataFrame) -> pd.DataFrame:
    df = df[COLUMNS].copy()
    for c in TEXT_COLS + ["YearMonth", "SalesTeamKey"]:
        df[c] = df[c].map(lambda v: None if v is None or (not isinstance(v, str) and pd.isna(v)) else str(v))
    for c in NUM_COLS:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    for c in ["Year", "Month", "DateKey", "CompanyKey", "SalespersonKey", "SegmentKey", "ChannelKey"]:
        df[c] = pd.to_numeric(df[c]).astype("int64")
    df["TargetDate"] = pd.to_datetime(df["TargetDate"]).dt.strftime("%Y-%m-%d %H:%M:%S")
    return df.set_index(PK).sort_index()


def compare(current: pd.DataFrame, built: pd.DataFrame):
    a, b = _norm(current), _norm(built)
    common = a.index.intersection(b.index)
    diffs = []
    for col in a.columns:
        x, y = a.loc[common, col], b.loc[common, col]
        same = (x - y).abs() < NUM_TOLERANCE if col in NUM_COLS else (x == y)
        differ = ~(same | (x.isna() & y.isna()))
        for idx in x[differ].index[:5]:
            diffs.append((idx, col, x.loc[idx], y.loc[idx]))
        if differ.sum() > 5:
            diffs.append(("...", col, f"{int(differ.sum())} rows differ", ""))
    return diffs, b.index.difference(a.index), a.index.difference(b.index)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="build and check only; write nothing")
    parser.add_argument("--file", default=None, help="the sheet (default: ETL_INPUT_DIR/sales_targets.xlsx)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    from etl_platform.config import PlatformConfig

    config = PlatformConfig.from_env()
    from config.input_check import effective_input_path

    path = Path(args.file) if args.file else effective_input_path(Path(config.input_dir), "sales_targets.xlsx")
    sheet = pd.read_excel(path, sheet_name="Targets")
    sheet["Salesperson"] = sheet["Salesperson"].replace({"SalesPerson 2": "Sales Person 2"})  # as jobs.conform_sales
    engine = create_engine(config.database_url, future=True)
    with engine.connect() as conn:
        teams = pd.read_sql(text("SELECT SalesTeamKey, SalesTeam, SalesTeamCompany, SalesSegment, SalesCity FROM dim_sales_team"), conn)
        segments = {r.Segment: int(r.SegmentKey) for r in conn.execute(text("SELECT SegmentKey, Segment FROM dim_segment"))}
        people_channel = {int(r.SalespersonKey): r.DistributionChannel for r in
                          conn.execute(text("SELECT SalespersonKey, DistributionChannel FROM dim_salesperson"))}
        known_people = set(people_channel)
        current = pd.read_sql(text(f"SELECT {', '.join(COLUMNS)} FROM {TABLE}"), conn)

    built = build(sheet, teams, segments, people_channel)
    mismatches = run_checks(sheet, built)
    unknown = sorted(set(built["SalespersonKey"]) - known_people - {UNKNOWN})
    if unknown:
        print(f"ERROR: SalespersonKey(s) not in dim_salesperson: {unknown}")
        return 2

    diffs, added, removed = compare(current, built)
    print(f"{path}: {len(built)} rows (was {len(current)}); {len(added)} new, {len(removed)} removed, "
          f"{len(built) - len(added)} existing; {len(mismatches)} Director month(s) differ from their people's sum")
    if diffs:
        print("ERROR: existing rows would change -- this targets-only rebuild does not reproduce the full ETL. Nothing written.")
        for idx, col, was, now in diffs:
            print(f"  {idx} {col}: {was!r} -> {now!r}")
        return 2
    new_rows = _norm(built).loc[added].reset_index()
    if len(new_rows):
        print("New rows:")
        print(new_rows[["YearMonth", "TargetLevel", "Salesperson", "SalespersonKey", "SalesSegment", "SegmentKey", "CompanyKey",
                        "SalesTeamKey", "Target_Revenue"]].to_string(index=False))
    if len(removed):
        print("Removed rows:", list(removed))
    summary = built.groupby(["Year", "TargetLevel", "SalesSegment"])["Target_Revenue"].sum().round(2)
    print("Target_Revenue by year / level / segment:\n" + summary.to_string())

    if args.dry_run:
        print("Dry run: nothing written.")
        return 0
    rows = built.assign(_run_id=str(uuid.uuid4()))
    with engine.begin() as conn:
        conn.execute(text(f"DELETE FROM {TABLE}"))
        rows.to_sql(TABLE, conn, if_exists="append", index=False, chunksize=1000)
        n = conn.execute(text(f"SELECT COUNT(*) FROM {TABLE}")).scalar_one()
    print(f"{TABLE} replaced: {n} rows (_run_id {rows['_run_id'].iloc[0]}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
