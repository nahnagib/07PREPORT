"""Company, currency and payment term dimensions from raw_odoo_*."""

from __future__ import annotations

from typing import Iterable

import pandas as pd

from core.keys import UNKNOWN
from sales_pipeline.product_matching import normalize_match_company


def company_display_name(odoo_name: str) -> str:
    """'TIKA' -> 'Tika', 'Majaal' -> 'Majaal' (the names the pages and PRODUCTS.xlsx use); others unchanged."""
    return normalize_match_company(odoo_name) or odoo_name


def build_companies(raw_company: pd.DataFrame, scope: Iterable[int]) -> pd.DataFrame:
    scope = set(scope)
    live = raw_company[raw_company["_deleted_at"].isna()] if "_deleted_at" in raw_company else raw_company
    return pd.DataFrame({
        "CompanyKey": live["id"].astype("int64"),
        "Company": live["name"].map(company_display_name),
        "odoo_name": live["name"],
        "CurrencyKey": live["currency_id"].map(lambda v: UNKNOWN if pd.isna(v) else int(v)),
        "currency": live["currency_name"],
        "is_in_scope": live["id"].map(lambda i: int(i in scope)),
    }).reset_index(drop=True)


def build_currencies(raw_currency: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame({
        "CurrencyKey": raw_currency["id"].astype("int64"),
        "currency": raw_currency["name"],
        "symbol": raw_currency["symbol"],
        "decimal_places": raw_currency["decimal_places"],
        "active": raw_currency["active"].fillna(True).astype(int),
    }).reset_index(drop=True)


def build_payment_terms(raw_term: pd.DataFrame, raw_line: pd.DataFrame) -> pd.DataFrame:
    lines = raw_line[raw_line["_deleted_at"].isna()] if "_deleted_at" in raw_line else raw_line
    stats = lines.groupby("payment_id").agg(max_days=("nb_days", "max"), line_count=("id", "count"))
    out = pd.DataFrame({
        "PaymentTermKey": raw_term["id"].astype("int64"),
        "payment_term": raw_term["name"].fillna("(unnamed)"),
        "CompanyKey": raw_term["company_id"].map(lambda v: UNKNOWN if pd.isna(v) else int(v)),
        "active": raw_term["active"].fillna(True).astype(int),
    })
    out["max_days"] = out["PaymentTermKey"].map(stats["max_days"]).astype("Int64")
    out["line_count"] = out["PaymentTermKey"].map(stats["line_count"]).fillna(0).astype(int)
    out["is_instalment"] = (out["line_count"] > 1).astype(int)
    return out.reset_index(drop=True)
