"""Date dimension and off days.

dim_date covers ETL_DIM_DATE_START (default 2018-01-01) to 31 December of next year; departments extend it with
``ensure_date_range`` before loading facts whose dates fall outside (old invoices, far due dates). Rows are a
pure function of the date, so extending never changes an existing row.
"""

from __future__ import annotations

import datetime as _dt
from typing import Mapping

import pandas as pd

from core.keys import UNKNOWN, UNKNOWN_TEXT

WEEKLY_REST_DAY = "Friday"  # same as the legacy pipeline (PipelineSettings.weekly_rest_day_name)


def date_key(value: _dt.date | None) -> int:
    return UNKNOWN if value is None or pd.isna(value) else int(pd.Timestamp(value).strftime("%Y%m%d"))


def build_dates(start: _dt.date, end: _dt.date, rest_day: str = WEEKLY_REST_DAY) -> pd.DataFrame:
    days = pd.date_range(start=start, end=end, freq="D")
    dim = pd.DataFrame({"Date": days})
    return pd.DataFrame({
        "DateKey": dim["Date"].dt.strftime("%Y%m%d").astype("int64"),
        "Date": dim["Date"].dt.date,
        "Year": dim["Date"].dt.year,
        "Month": dim["Date"].dt.month,
        "MonthName": dim["Date"].dt.strftime("%b"),
        "YearMonth": dim["Date"].dt.to_period("M").astype(str),
        "Quarter": dim["Date"].dt.to_period("Q").astype(str),
        "DayOfMonth": dim["Date"].dt.day,
        "DayOfYear": dim["Date"].dt.dayofyear,
        "WeekdayNumber": dim["Date"].dt.weekday,
        "WeekdayName": dim["Date"].dt.strftime("%A"),
        "IsWeeklyRestDay": (dim["Date"].dt.strftime("%A") == rest_day).astype(int),
    })


def default_range(as_of: _dt.date, start: _dt.date) -> tuple[_dt.date, _dt.date]:
    return start, _dt.date(as_of.year + 1, 12, 31)


def build_offdays(raw_offdays: pd.DataFrame, company_keys: Mapping[str, int], country: str | None = "Libya") -> pd.DataFrame:
    """Same filters as the legacy OffDaysFactBuilder: active rows only, the business country only; one row per
    (date, type, company, branch). Blank company/branch = every company/branch (-1)."""
    df = raw_offdays.copy()
    df = df[df["IsActive"].fillna(False).astype(bool) & df["Date"].notna()]
    if country:
        df = df[df["Country"].astype(str).str.strip().str.lower() == country.strip().lower()]
    company_key = [
        int(k) if k is not None and not pd.isna(k) else company_keys.get(_company(c), UNKNOWN)
        for k, c in zip(df["CompanyKey"], df["Company"])
    ]
    out = pd.DataFrame({
        "DateKey": df["Date"].map(date_key).astype("int64").to_numpy(),
        "OffDayType": df["OffDayType"].fillna("unspecified").astype(str).str.strip().str.lower().to_numpy(),
        "CompanyKey": company_key,
        "SalesTeamKey": df["Branch"].map(lambda b: b.strip() if isinstance(b, str) and b.strip() else UNKNOWN_TEXT).to_numpy(),
        "Date": df["Date"].to_numpy(),
        "Country": df["Country"].to_numpy(),
        "Company": df["Company"].to_numpy(),
        "Branch": df["Branch"].to_numpy(),
        "HolidayName": df["HolidayName"].to_numpy(),
        "Reason": df["Reason"].to_numpy(),
    })
    return out.drop_duplicates(subset=["DateKey", "OffDayType", "CompanyKey", "SalesTeamKey"], keep="first").reset_index(drop=True)


def _company(value) -> str:
    from core.transforms.reference import company_display_name

    return company_display_name(value.strip()) if isinstance(value, str) and value.strip() else ""
