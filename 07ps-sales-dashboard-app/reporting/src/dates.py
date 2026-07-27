"""Date-window helpers mirroring backend/src/measures/filters.ts's MTD/YTD/
LMTD/LYTD windows, so the reporting pipeline's period comparisons line up
with what the live dashboard shows."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass


@dataclass(frozen=True)
class Window:
    start: dt.date
    end: dt.date


def ytd(anchor: dt.date) -> Window:
    return Window(dt.date(anchor.year, 1, 1), anchor)


def mtd(anchor: dt.date) -> Window:
    return Window(dt.date(anchor.year, anchor.month, 1), anchor)


def lytd(anchor: dt.date) -> Window:
    """Last-year YTD: Jan 1 of last year through the same day-of-year last year."""
    try:
        same_day_last_year = anchor.replace(year=anchor.year - 1)
    except ValueError:  # Feb 29 with no Feb 29 last year
        same_day_last_year = anchor.replace(year=anchor.year - 1, day=28)
    return Window(dt.date(anchor.year - 1, 1, 1), same_day_last_year)


def lmtd(anchor: dt.date) -> Window:
    try:
        same_day_last_year = anchor.replace(year=anchor.year - 1)
    except ValueError:
        same_day_last_year = anchor.replace(year=anchor.year - 1, day=28)
    return Window(dt.date(anchor.year - 1, anchor.month, 1), same_day_last_year)


def previous_month(anchor: dt.date) -> Window:
    first_of_this_month = dt.date(anchor.year, anchor.month, 1)
    last_of_prev_month = first_of_this_month - dt.timedelta(days=1)
    return Window(dt.date(last_of_prev_month.year, last_of_prev_month.month, 1), last_of_prev_month)


def full_history_start() -> dt.date:
    return dt.date(2021, 1, 1)
