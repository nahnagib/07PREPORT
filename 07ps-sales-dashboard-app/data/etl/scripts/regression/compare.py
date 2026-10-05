"""Compares two regression captures (baseline.py / sheets_capture.py) file by file.

  python scripts/regression/compare.py LEFT_DIR RIGHT_DIR OUT_DIR [--label "A: new vs legacy (same run)"]

For every CSV present in LEFT_DIR: outer join on the group columns, compare each measure (row counts exactly, sums
within 0.001 = one dirham), classify each differing row:
  accepted:customer_grain      customer counts / lists (commercial-partner grain, approved)
  accepted:targets_off_unknown target rows that moved from Unknown_Salesperson to their own salesperson (approved)
  unexplained                  anything else -- blocks the regression
Writes OUT_DIR/differences.csv (every differing row) and OUT_DIR/summary.md.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

TOLERANCE = 0.001
ACCEPTED_FILES = {"customers_by_company_month.csv": "accepted:customer_grain", "customer_list.csv": "accepted:customer_grain"}


def _read(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, dtype=str, keep_default_na=False)


def _split(df: pd.DataFrame) -> tuple[list[str], list[str]]:
    cols = list(df.columns)
    if "row_count" in cols:
        i = cols.index("row_count")
        return cols[:i], cols[i:]
    numeric = [c for c in cols if c in ("customers", "odoo_partners", "line_count", "value")]
    return [c for c in cols if c not in numeric], numeric


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s.replace("", None), errors="coerce").fillna(0.0)


def compare_file(name: str, left: pd.DataFrame, right: pd.DataFrame) -> pd.DataFrame:
    if _split(left)[0] != _split(right)[0]:
        # different grains by design (customer list: legacy customer id vs CustomerKey): compare the totals only
        measures = [m for m in _split(left)[1] if m in right.columns]
        left = pd.DataFrame([{m: str(_num(left[m]).sum()) for m in measures}])
        right = pd.DataFrame([{m: str(_num(right[m]).sum()) for m in measures}])
    keys, measures = _split(left)
    if not keys:
        left = left.assign(_k="total")
        right = right.assign(_k="total")
        keys = ["_k"]
    merged = left.merge(right, on=keys, how="outer", suffixes=("_left", "_right"), indicator=True)
    rows = []
    for _, r in merged.iterrows():
        diffs = {}
        for m in measures:
            a = _num(pd.Series([r.get(f"{m}_left", "")]))[0]
            b = _num(pd.Series([r.get(f"{m}_right", "")]))[0]
            tol = 0 if m in ("row_count", "customers", "odoo_partners", "line_count") else TOLERANCE
            if abs(a - b) > tol + 1e-9:
                diffs[m] = (a, b)
        if diffs:
            rows.append({"file": name, **{k: r[k] for k in keys}, "presence": r["_merge"],
                         "measures": "; ".join(f"{m}: {a:,.3f} -> {b:,.3f} ({b - a:+,.3f})" for m, (a, b) in diffs.items()),
                         "value_delta": next((b - a for m, (a, b) in diffs.items() if m in ("Value", "OrderValue", "Target_Revenue", "value")), None),
                         "class": classify(name, r, keys)})
    return pd.DataFrame(rows)


def classify(name: str, row: pd.Series, keys: list[str]) -> str:
    if name in ACCEPTED_FILES:
        return ACCEPTED_FILES[name]
    if name.startswith("targets__salesperson"):
        return "accepted:targets_off_unknown"
    return "unexplained"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("left", type=Path)
    ap.add_argument("right", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--label", default="comparison")
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    frames, lines = [], [f"# {args.label}", "", f"left: `{args.left}`  ", f"right: `{args.right}`", "",
                         "| file | rows left | rows right | differing rows | unexplained |", "|---|---|---|---|---|"]
    for path in sorted(args.left.glob("*.csv")):
        other = args.right / path.name
        if not other.exists():
            lines.append(f"| {path.name} | | missing | | |")
            continue
        left, right = _read(path), _read(other)
        diff = compare_file(path.name, left, right)
        frames.append(diff)
        unexplained = int((diff["class"] == "unexplained").sum()) if len(diff) else 0
        lines.append(f"| {path.name} | {len(left)} | {len(right)} | {len(diff)} | {unexplained} |")
    all_diffs = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    all_diffs.to_csv(args.out / "differences.csv", index=False, encoding="utf-8-sig")
    unexplained_total = int((all_diffs["class"] == "unexplained").sum()) if len(all_diffs) else 0
    lines += ["", f"**Unexplained differing rows: {unexplained_total}**", ""]
    (args.out / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[-3:]))
    return 0 if unexplained_total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
