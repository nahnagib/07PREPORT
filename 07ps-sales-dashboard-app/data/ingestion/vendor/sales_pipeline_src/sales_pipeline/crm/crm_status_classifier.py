from __future__ import annotations

from typing import Any

import pandas as pd


def _text(value: Any) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip().lower()


def classify_status(row: pd.Series, won_stage_ids: set[int]) -> tuple[bool, bool, bool]:
    probability = pd.to_numeric(row.get("Probability"), errors="coerce")
    stage = _text(row.get("Stage"))
    won_status = _text(row.get("WonStatus"))
    lost_reason = _text(row.get("LostReason"))
    stage_id = pd.to_numeric(row.get("StageID"), errors="coerce")
    active_value = row.get("IsActive", True)
    active = True if pd.isna(active_value) else bool(active_value)

    is_won_stage = pd.notna(stage_id) and int(stage_id) in won_stage_ids
    is_won = bool((pd.notna(probability) and float(probability) >= 100) or is_won_stage or "won" in stage or "won" in won_status)
    is_lost = bool((lost_reason != "") or ((not active) and not is_won) or ("lost" in stage))
    is_open = not is_won and not is_lost
    return is_won, is_lost, is_open
