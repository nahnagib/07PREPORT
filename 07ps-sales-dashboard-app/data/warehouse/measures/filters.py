"""Tachometer filter model, date-window logic, and the Salesperson RBAC lock.

Filter -> warehouse dimension mapping (confirmed against the real SalesModel_OneOutput.xlsx
export and the loaded schema, not assumed from names):

    Business Unit / Company   -> dim_company.company_key        (Tika, Majaal)
    Customer Group            -> dim_segment.segment_key        (see note below -- NOT a
                                                                   "customer" table)
    Distribution Channel      -> dim_distribution_channel.channel_key
    Branch                    -> dim_sales_team.sales_team_key  (see note below)
    Sales Person              -> dim_salesperson.salesperson_key
    POS                       -> NOT WIRED. See "POS" note below.

Customer Group -> dim_segment, not dim_customer.CustomerSegment
----------------------------------------------------------------
The manual's "Customer Group: B2B, B2C, Corporate, Internal Company" is NOT backed by
Dim_Customer.CustomerSegment -- that column only ever takes 'B2B', 'B2C', or 'Unknown' in the real
export (verified: 12,094 / 1,843 / 80 rows respectively across 14,017 customers; no 'Corporate' or
'Internal Company' value exists there at all). The four groups the manual describes are backed by
dim_segment / segment_key instead, which the real Dim_Segment sheet defines as exactly five values:
B2B (1), B2C (2), Backoffice (3), Inter Company (4), Unknown (5) -- confirmed populated across
fact_order (real row counts: B2C 31,282 / B2B 4,371 / Backoffice 1,108 / Unknown 176 /
Inter Company 84). "Backoffice" and "Inter Company" are the same two groups the manual calls
"Corporate" and "Internal Company" under different internal labels; segment_key is what every
fact table's filter column and fact_target_plan.segment_key actually use. Filtering by "Customer
Group" in the UI should therefore resolve to segment_key, with the label mapping handled at the
presentation layer (not by trying to make the warehouse's labels match the manual's wording).

Branch -> dim_sales_team, not a separate Branch/Location dimension
-------------------------------------------------------------------
There is no standalone Branch/Location table anywhere in the export. Confirmed (Task C session):
Fact_OffDays' "Branch" column stores sales_team_key-formatted values (e.g. 'TK-BEN-BC-03'), and
dim_sales_team already carries one row per physical team/branch combination (28 rows, each with a
city). "Branch" filtering is sales_team_key filtering.

POS -> confirmed inactive, not wired
--------------------------------------
Searched every column header across all 28 sheets in the real export for anything POS-related;
none exists (the only substring hit, "HasHistoryPostLYTDLastYear", is unrelated -- "Post" not
"POS"). This matches the manual's own "Inactive (not used)" note. No POS filter is implemented
here; if POS data is ever introduced upstream, this would need a real dimension/column added
first, not a UI-only filter with no backing data.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, replace
from datetime import date
from typing import Optional


# ---------------------------------------------------------------------------
# Filter selection
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Filters:
    """One filter selection from the Tachometer Filters Panel. None means "no restriction"."""

    company_key: Optional[int] = None          # Business Unit / Company
    segment_key: Optional[int] = None          # Customer Group (see module docstring)
    channel_key: Optional[int] = None          # Distribution Channel
    sales_team_key: Optional[str] = None       # Branch
    salesperson_key: Optional[int] = None      # Sales Person


# Column name each Filters field maps to on fact_order / fact_order_line / fact_target_plan --
# all three tables use identical column names for these five, so one clause-builder works for all.
_FILTER_COLUMNS = {
    "company_key": "company_key",
    "segment_key": "segment_key",
    "channel_key": "channel_key",
    "sales_team_key": "sales_team_key",
    "salesperson_key": "salesperson_key",
}


def build_where_clause(filters: Filters, table_alias: str = "") -> tuple[str, list]:
    """Build a parametrized SQL WHERE fragment (without the leading 'WHERE') and its params.

    Returns ("1=1", []) if no filters are set, so callers can always do
    f"WHERE {date_clause} AND {filter_clause}" without special-casing "no filters".
    """
    prefix = f"{table_alias}." if table_alias else ""
    clauses = []
    params: list = []
    for field, column in _FILTER_COLUMNS.items():
        value = getattr(filters, field)
        if value is not None:
            clauses.append(f"{prefix}{column} = %s")
            params.append(value)
    if not clauses:
        return "1=1", []
    return " AND ".join(clauses), params


# ---------------------------------------------------------------------------
# Salesperson RBAC lock (role_tier = 'SALESPERSON')
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class UserContext:
    """Minimal fields needed to enforce the Salesperson lock, sourced from app_user + user_role."""

    role_code: str
    salesperson_key: Optional[int] = None


class SalespersonLockError(Exception):
    """Raised when a SALESPERSON-tier user's request tries to escape their own scope."""


def apply_salesperson_lock(filters: Filters, user: UserContext) -> Filters:
    """Enforce the manual's rule: "For sales users, all filters are locked except the assigned
    salesperson. Each salesperson sees only their own data."

    Behavior for a SALESPERSON-tier user:
      - company_key / segment_key / channel_key / sales_team_key are forced to None (unlocked
        filters are meaningless once salesperson_key pins the result to one person's own records;
        forcing them off rather than silently intersecting them avoids a UI bug where a stale
        Company selection makes a salesperson's own dashboard show zero rows).
      - salesperson_key is forced to the user's own dim_salesperson key from app_user, regardless
        of whatever was passed in. If the caller explicitly passed a *different* salesperson_key,
        that is treated as a bug/attempted scope escape and raises rather than silently
        overriding it, so a caller integrating this can't ship a UI bug that quietly leaks another
        salesperson's numbers.

    Any other role_code is returned unchanged -- this function only ever restricts, never expands,
    a caller's filters.
    """
    if user.role_code != "SALESPERSON":
        return filters

    if user.salesperson_key is None:
        raise SalespersonLockError(
            "User has SALESPERSON role but no salesperson_key on app_user -- cannot scope any "
            "query. This is a data setup problem (app_user row is missing salesperson_key), not "
            "something to default around."
        )

    if filters.salesperson_key is not None and filters.salesperson_key != user.salesperson_key:
        raise SalespersonLockError(
            f"SALESPERSON-tier user (salesperson_key={user.salesperson_key}) requested data for "
            f"a different salesperson_key={filters.salesperson_key}. Refusing rather than "
            f"silently redirecting or silently honoring it."
        )

    return Filters(
        company_key=None,
        segment_key=None,
        channel_key=None,
        sales_team_key=None,
        salesperson_key=user.salesperson_key,
    )


# ---------------------------------------------------------------------------
# Date windows: MTD / YTD / LMTD / LYTD / FLM / FLY
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class DateWindow:
    start: date
    end: date


def mtd_window(anchor: date) -> DateWindow:
    """Month-to-Date: start of the selected month through the selected date (inclusive)."""
    return DateWindow(start=date(anchor.year, anchor.month, 1), end=anchor)


def ytd_window(anchor: date) -> DateWindow:
    """Year-to-Date: start of the selected year through the selected date (inclusive)."""
    return DateWindow(start=date(anchor.year, 1, 1), end=anchor)


def _shift_one_year_back(anchor: date) -> date:
    """Same month/day, prior year. Feb 29 on a non-leap prior year falls back to Feb 28 --
    the only case this can't map 1:1, and this is the conventional resolution."""
    try:
        return anchor.replace(year=anchor.year - 1)
    except ValueError:
        # anchor was Feb 29 and (year-1) is not a leap year
        return date(anchor.year - 1, 2, 28)


def lmtd_window(anchor: date) -> DateWindow:
    """Last-year MTD: same day-of-month/month window, one calendar year earlier."""
    return mtd_window(_shift_one_year_back(anchor))


def lytd_window(anchor: date) -> DateWindow:
    """Last-year YTD: same year-to-date window, one calendar year earlier."""
    return ytd_window(_shift_one_year_back(anchor))


def fly_window(anchor: date) -> DateWindow:
    """Full Last Year: the entire calendar year before the selected date's year."""
    y = anchor.year - 1
    return DateWindow(start=date(y, 1, 1), end=date(y, 12, 31))


def flm_window(anchor: date) -> DateWindow:
    """Full Last Month: the entire calendar month before the selected date's month."""
    if anchor.month == 1:
        y, m = anchor.year - 1, 12
    else:
        y, m = anchor.year, anchor.month - 1
    last_day = calendar.monthrange(y, m)[1]
    return DateWindow(start=date(y, m, 1), end=date(y, m, last_day))


# ---------------------------------------------------------------------------
# FY/FM Target-to-date proration (simple calendar-day method, confirmed -- see
# ../../ingestion/README.md / project decision log; the vendored pipeline has no existing
# proration logic for this, confirmed by searching it for "prorat"/"to_date"/"run_rate" etc.)
# ---------------------------------------------------------------------------

def month_elapsed_fraction(anchor: date) -> float:
    """Fraction of the selected month elapsed as of the selected date (day_of_month / days_in_month).

    Used to prorate a Full-Month Target down to a Month-to-Date target-to-date figure:
        MTD Target-to-date = FM Target * month_elapsed_fraction(anchor)
    """
    days_in_month = calendar.monthrange(anchor.year, anchor.month)[1]
    return anchor.day / days_in_month


def prorate_mtd_target(fm_target: Optional[float], anchor: date) -> Optional[float]:
    if fm_target is None:
        return None
    return fm_target * month_elapsed_fraction(anchor)


def prorate_ytd_target(
    completed_months_target_sum: Optional[float],
    fm_target_current_month: Optional[float],
    anchor: date,
) -> Optional[float]:
    """YTD Target-to-date = sum of FULL targets for months fully completed before the selected
    month, plus the current (partial) month's target prorated by day-of-month.

    This deliberately does NOT divide the Full-Year Target by 365/366 and multiply by
    day-of-year -- fact_target_plan's monthly target figures are not uniform month to month (real
    data ranges from roughly LYD 60K to LYD 1.8M per team per month), so a flat annual-ratio
    approach would misstate a to-date figure for a business with seasonal monthly targets. Summing
    completed whole months plus a prorated partial month uses the actual monthly target
    granularity the source data provides.
    """
    completed = completed_months_target_sum or 0
    current_prorated = prorate_mtd_target(fm_target_current_month, anchor) or 0
    if completed_months_target_sum is None and fm_target_current_month is None:
        return None
    return completed + current_prorated


def replace_filters(filters: Filters, **kwargs) -> Filters:
    """Small convenience wrapper around dataclasses.replace for callers that don't want to import
    dataclasses directly."""
    return replace(filters, **kwargs)
