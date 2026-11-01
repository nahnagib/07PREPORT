"""Opportunity STATUS (the outcome) -- never the kanban STAGE.

Odoo 17 sets the outcome with the Won / Lost buttons on the form, independently of the stage column:
  * Won  -> moves the record to an is_won stage and sets probability 100; it stays active.
  * Lost -> archives the record (active = False), probability 0 and a lost reason; it KEEPS its stage.
crm_enterprise stores it as crm.lead.won_status (won / lost / pending), computed from active and probability only.

Status, in this order:
  1. won_status when Odoo sent one: won -> Won, lost -> Lost, pending -> New (active) / Archived (archived).
  2. Otherwise derived: active AND stage.is_won -> Won; archived AND probability = 0 -> Lost;
     archived AND probability > 0 -> Archived; everything else that is active -> New.

Archived = archived without being marked Lost: it is no outcome and stays out of every pipeline figure.
Stage NAMES are never read: the custom "Won" / "Lost" columns can be renamed or removed without changing a status.
"""
from __future__ import annotations

from typing import Any

import pandas as pd

NEW, WON, LOST, ARCHIVED = "New", "Won", "Lost", "Archived"
STATUSES = (NEW, WON, LOST, ARCHIVED)


def _text(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    return str(value).strip().lower()


def opportunity_status(row: pd.Series | dict, won_stage_ids: set[int]) -> str:
    """New / Won / Lost / Archived of one crm.lead row (columns WonStatus, IsActive, Probability, StageID)."""
    active_value = row.get("IsActive", True)
    active = True if active_value is None or pd.isna(active_value) else bool(active_value)
    won_status = _text(row.get("WonStatus"))
    if won_status == "won":
        return WON
    if won_status == "lost":
        return LOST
    if won_status == "pending":
        return NEW if active else ARCHIVED

    if active:
        stage_id = pd.to_numeric(row.get("StageID"), errors="coerce")
        return WON if pd.notna(stage_id) and int(stage_id) in won_stage_ids else NEW
    probability = pd.to_numeric(row.get("Probability"), errors="coerce")
    return LOST if pd.isna(probability) or float(probability) == 0 else ARCHIVED


def classify_status(row: pd.Series, won_stage_ids: set[int]) -> tuple[bool, bool, bool]:
    """(IsWon, IsLost, IsOpen) of opportunity_status; Archived is none of the three."""
    status = opportunity_status(row, won_stage_ids)
    return status == WON, status == LOST, status == NEW
