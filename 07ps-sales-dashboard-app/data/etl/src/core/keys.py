"""Key conventions shared by every department (docs/adding-a-department.md).

* Join keys are named ``<Entity>Key`` everywhere (CustomerKey, CompanyKey, SalespersonKey, ...).
* Every dimension has an Unknown/Unassigned member: -1 for integer keys, '-1' for text keys
  (SalesTeamKey, ProductMasterKey). Facts never hold NULL keys -- they fall back to the -1 member and the
  task reports the fallback (RunContext.record_fallback).
"""

from __future__ import annotations

from typing import Any, Mapping

import pandas as pd

UNKNOWN = -1
UNKNOWN_TEXT = "-1"


def int_key(value: Any) -> int:
    """An integer key, or -1 for anything missing/False/unparseable."""
    if value is None or value is False:
        return UNKNOWN
    if isinstance(value, (list, tuple)):  # Odoo many2one [id, name]
        return int(value[0]) if value else UNKNOWN
    try:
        if pd.isna(value):
            return UNKNOWN
    except (TypeError, ValueError):
        pass
    try:
        return int(value)
    except (TypeError, ValueError):
        return UNKNOWN


def text_key(value: Any) -> str:
    if value is None or value is False:
        return UNKNOWN_TEXT
    try:
        if pd.isna(value):
            return UNKNOWN_TEXT
    except (TypeError, ValueError):
        pass
    text = str(value).strip()
    return text or UNKNOWN_TEXT


def lookup_keys(source_ids: pd.Series, mapping: Mapping[Any, Any], unknown: Any = UNKNOWN) -> tuple[pd.Series, list[Any]]:
    """Maps source ids to keys; unmapped/missing ids get ``unknown``. Returns (keys, the distinct source ids
    that fell back) so the caller can report them."""
    mapped = source_ids.map(lambda v: mapping.get(v) if v is not None and not (isinstance(v, float) and pd.isna(v)) else None)
    fell_back = source_ids[mapped.isna() & source_ids.notna()]
    keys = mapped.where(mapped.notna(), unknown)
    return keys, sorted(set(fell_back.tolist()), key=str)
