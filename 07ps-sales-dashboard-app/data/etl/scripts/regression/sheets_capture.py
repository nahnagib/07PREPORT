"""The regression baseline computed from the LEGACY sheets of a run (sales_pipeline.build_sheets) instead of SQL.

Gives "legacy, same extraction" totals in exactly the file format of baseline.py, so the conformed tables can be
compared with what the legacy pipeline would have loaded FROM THE SAME ODOO DATA (isolates the key conformance), and
those legacy totals compared with the stored baseline (isolates Odoo changes between the two dates).
Mirrors baseline.legacy_specs(): same facts, measures, groupings, labels, cutoff and NULL semantics (SUM of only
NULLs is NULL; undated rows are kept).
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

import pandas as pd

from baseline import MONTH_CUTOFF, legacy_specs

SHEET_OF = {"fact_saleslines": "Fact_SalesLines", "fact_orders": "Fact_Orders", "fact_sales": "Fact_Sales", "fact_targets": "Fact_Targets",
            "fact_delivery": "Fact_Delivery", "fact_lead": "Fact_Lead", "fact_opportunity": "Fact_Opportunity",
            "fact_productsalesdaily": "Fact_ProductSalesDaily", "fact_inventory": "Fact_Inventory", "fact_bcgmatrix": "Fact_BCGMatrix",
            "fact_offdays": "Fact_OffDays"}


def _label_maps(sheets: dict[str, pd.DataFrame]) -> dict[str, dict]:
    def m(sheet, key, label):
        df = sheets.get(sheet, pd.DataFrame())
        return dict(zip(df[key], df[label])) if len(df) else {}
    return {"company": m("Dim_Company", "CompanyKey", "Company"), "salesperson": m("Dim_Salesperson", "SalespersonKey", "salesperson"),
            "channel": m("Dim_DistributionChannel", "ChannelKey", "DistributionChannel"), "segment": m("Dim_Segment", "SegmentKey", "Segment")}


def _labels(df: pd.DataFrame, group: str, maps: dict, spec_groups: dict) -> pd.Series:
    if group == "company" and "dc.Company" not in spec_groups[group]:
        return df["Company"].where(df["Company"].notna(), "(all)" if "(all)" in spec_groups[group] else "Unknown")
    key_col = {"company": "CompanyKey", "salesperson": "SalespersonKey", "channel": "ChannelKey", "segment": "SegmentKey"}.get(group)
    if key_col:
        default = {"company": "Unknown", "salesperson": "Unknown_Salesperson", "channel": "Unknown", "segment": "Unknown"}[group]
        keys = pd.to_numeric(df[key_col], errors="coerce") if key_col in df.columns else pd.Series(pd.NA, index=df.index)
        return keys.map(lambda k: maps[group].get(k, default) if pd.notna(k) else default)
    if group == "team":  # the legacy sheet writes a missing team as pd.NA or as the text '<NA>'
        team = df["SalesTeamKey"].astype("string").str.strip()
        return team.where(team.notna() & ~team.isin(["", "<NA>", "nan", "None"]), "MJ-TIK-00").astype(object)
    col = {"brand": "Brand", "category": "Category"}[group]
    return df[col].where(df[col].notna(), "(none)")


def capture_sheets(sheets: dict[str, pd.DataFrame], out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    maps = _label_maps(sheets)
    manifest = {"profile": "legacy_sheets_same_run", "captured_at_utc": _dt.datetime.now(_dt.timezone.utc).isoformat(), "cutoff": MONTH_CUTOFF, "files": {}}
    cutoff = pd.Timestamp(MONTH_CUTOFF)
    for spec in legacy_specs():
        df = sheets.get(SHEET_OF[spec.table], pd.DataFrame()).copy()
        date_col = spec.date_expr.replace("f.", "") if spec.date_expr else None
        if date_col:
            dates = pd.to_datetime(df[date_col], errors="coerce").dt.normalize()
            if spec.apply_cutoff:
                df = df[(dates <= cutoff) | dates.isna()]
                dates = dates[df.index]
            df["month"] = dates.dt.strftime("%Y-%m")
        groupings = {"total": []}
        for g in spec.groups:
            groupings[f"{g}_month" if date_col else g] = [g]
        for g in spec.groups:
            df[f"__{g}"] = _labels(df, g, maps, spec.groups) if len(df) else pd.Series(dtype=object)
        for label, cols in groupings.items():
            keys = [f"__{c}" for c in cols] + (["month"] if date_col and label != "total" else [])
            agg = {"row_count": ("__rc", "size")}
            work = df.assign(__rc=1)
            for m in spec.measures:
                work[m] = pd.to_numeric(work[m], errors="coerce") if m in work.columns else float("nan")
                agg[m] = (m, lambda s: s.sum(min_count=1))
            res = work.groupby(keys, dropna=False).agg(**agg).reset_index() if keys else pd.DataFrame([{k: (work[v[0]].size if v[1] == "size" else v[1](work[v[0]])) for k, v in agg.items()}])
            res = res.rename(columns={f"__{c}": c for c in cols})
            ordered = [c for c in cols] + (["month"] if date_col and label != "total" else []) + list(agg)
            res = res[ordered]
            name = f"{spec.name}__{label}.csv"
            res.sort_values(ordered[: len(ordered) - len(agg)] or ordered[:1]).to_csv(out / name, index=False, float_format="%.6f")
            manifest["files"][name] = {"rows": len(res)}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return manifest
