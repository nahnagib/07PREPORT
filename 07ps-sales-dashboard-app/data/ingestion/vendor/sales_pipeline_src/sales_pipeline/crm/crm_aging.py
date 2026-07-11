from __future__ import annotations

import pandas as pd


AGING_LABELS = ["0-30 days", "30-60 days", "60-90 days", "90+ days"]


def aging_bucket(days: object) -> str:
    if pd.isna(days):
        return "Unknown"
    value = float(days)
    if value <= 30:
        return "0-30 days"
    if value <= 60:
        return "30-60 days"
    if value <= 90:
        return "60-90 days"
    return "90+ days"
