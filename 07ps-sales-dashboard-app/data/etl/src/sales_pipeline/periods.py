"""The Product pages' one reporting window (2026-11-14): the rolling LAST 12 MONTHS, replacing calendar YTD.

  last 12 months   today - 12 months (same day) .. today, both ends included (2026-11-14 -> 2025-11-14 .. 2026-11-14)
  prior 12 months  the 12 months before it, ending the day before it starts (2024-11-14 .. 2025-11-13)

The backend's twin is backend/src/lib/last12Months.ts (same rule); keep the two in step.
"""

from __future__ import annotations

from typing import Any

import pandas as pd


def get_last_12m_range(as_of: Any) -> tuple[pd.Timestamp, pd.Timestamp]:
    """(start, end) of the last 12 months ending on `as_of` (a day; Feb 29 -> Feb 28 a year earlier)."""
    end = pd.Timestamp(as_of).normalize()
    return end - pd.DateOffset(months=12), end


def get_prior_12m_range(as_of: Any) -> tuple[pd.Timestamp, pd.Timestamp]:
    """(start, end) of the 12 months before get_last_12m_range(as_of): growth compares the two."""
    start, _ = get_last_12m_range(as_of)
    prior_end = start - pd.Timedelta(days=1)
    return start - pd.DateOffset(months=12), prior_end
