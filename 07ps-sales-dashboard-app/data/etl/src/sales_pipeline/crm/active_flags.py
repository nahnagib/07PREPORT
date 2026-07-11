from __future__ import annotations

import pandas as pd


def coerce_nullable_bool(series: pd.Series) -> pd.Series:
    """Convert Odoo-style boolean values while preserving unknown source values."""
    normalized = series.copy()
    if pd.api.types.is_bool_dtype(normalized):
        return normalized.astype("boolean")
    if pd.api.types.is_numeric_dtype(normalized):
        return pd.to_numeric(normalized, errors="coerce").map({1: True, 0: False}).astype("boolean")

    text = normalized.astype("string").str.strip().str.lower()
    mapped = text.map(
        {
            "true": True,
            "t": True,
            "yes": True,
            "y": True,
            "1": True,
            "active": True,
            "false": False,
            "f": False,
            "no": False,
            "n": False,
            "0": False,
            "inactive": False,
        }
    )
    return mapped.astype("boolean")


def build_active_flag(active_source: pd.Series) -> pd.Series:
    active_bool = coerce_nullable_bool(active_source)
    return active_bool.fillna(False).astype(bool)
