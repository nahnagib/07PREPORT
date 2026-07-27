"""SQL/pandas queries mirroring the business logic in backend/src/measures/*.ts,
run directly against the warehouse instead of through the dashboard API.

Blocked customers (dim_customer.IsBlocked) and off-days (fact_offdays,
IsActive=1) are excluded from baseline trend/forecast series by default, but
every exclusion is quantified (not silently dropped) so the report can state
its impact -- e.g. "$X was recorded against blocked customers and excluded".
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

import pandas as pd
from sqlalchemy import Engine, text


@dataclass
class Exclusion:
    label: str
    excluded_value: float
    excluded_rows: int
    total_value: float

    @property
    def pct_of_total(self) -> float:
        return (self.excluded_value / self.total_value * 100) if self.total_value else 0.0


def _read_sql(engine: Engine, sql: str, params: dict) -> pd.DataFrame:
    with engine.connect() as conn:
        return pd.read_sql(text(sql), conn, params=params)


# ---------------------------------------------------------------------------
# Revenue (fact_saleslines) -- powers Tachometer, Revenue Trend, Critical Number
# ---------------------------------------------------------------------------

def revenue_daily(
    engine: Engine, start: dt.date, end: dt.date
) -> tuple[pd.DataFrame, list[Exclusion]]:
    """Daily value/volume, blocked customers and off-days excluded.

    Returns the clean daily series plus a list of Exclusion records
    quantifying what was removed and why.
    """
    raw = _read_sql(
        engine,
        """
        SELECT
            fsl.order_date_date AS order_date,
            fsl.CustomerKey AS customer_key,
            fsl.company_final AS company,
            fsl.Value AS value,
            fsl.Volume AS volume
        FROM fact_saleslines fsl
        WHERE fsl.order_date_date BETWEEN :start AND :end
        """,
        {"start": start, "end": end},
    )
    total_value = float(raw["value"].sum()) if not raw.empty else 0.0

    blocked = _read_sql(
        engine,
        "SELECT CustomerKey AS customer_key FROM dim_customer WHERE IsBlocked = 1",
        {},
    )
    blocked_keys = set(blocked["customer_key"].dropna().tolist())

    offdays = _read_sql(
        engine,
        """
        SELECT Date AS off_date, Company AS company
        FROM fact_offdays
        WHERE IsActive = 1 AND Date BETWEEN :start AND :end
        """,
        {"start": start, "end": end},
    )
    offday_pairs = set(zip(offdays["off_date"], offdays["company"]))

    is_blocked = raw["customer_key"].isin(blocked_keys)
    is_offday = raw.apply(
        lambda r: (r["order_date"], r["company"]) in offday_pairs, axis=1
    ) if not raw.empty else pd.Series([], dtype=bool)

    exclusions = []
    if not raw.empty:
        blocked_rows = raw[is_blocked]
        exclusions.append(Exclusion(
            "Blocked customers", float(blocked_rows["value"].sum()), len(blocked_rows), total_value,
        ))
        offday_rows = raw[is_offday & ~is_blocked]
        exclusions.append(Exclusion(
            "Off-days (forced closures/holidays)", float(offday_rows["value"].sum()), len(offday_rows), total_value,
        ))

    clean = raw[~is_blocked & ~is_offday] if not raw.empty else raw
    daily = (
        clean.groupby("order_date")[["value", "volume"]].sum().reset_index()
        .rename(columns={"order_date": "date"})
        .sort_values("date")
    )
    return daily, exclusions


def revenue_monthly(engine: Engine, start: dt.date, end: dt.date) -> pd.DataFrame:
    daily, _ = revenue_daily(engine, start, end)
    if daily.empty:
        return daily
    monthly = daily.copy()
    monthly["year_month"] = monthly["date"].apply(lambda d: f"{d.year:04d}-{d.month:02d}")
    out = monthly.groupby("year_month")[["value", "volume"]].sum().reset_index()
    out["asp"] = out["value"] / out["volume"].replace(0, pd.NA)
    return out


def targets_monthly(engine: Engine, start_year: int, start_month: int, end_year: int, end_month: int) -> pd.DataFrame:
    return _read_sql(
        engine,
        """
        SELECT Year AS year, Month AS month,
               SUM(Target_Revenue) AS target_revenue,
               SUM(Target_Volume) AS target_volume
        FROM fact_targets
        WHERE TargetLevel = 'Salesperson'
          AND (Year > :sy OR (Year = :sy AND Month >= :sm))
          AND (Year < :ey OR (Year = :ey AND Month <= :em))
        GROUP BY Year, Month
        ORDER BY Year, Month
        """,
        {"sy": start_year, "sm": start_month, "ey": end_year, "em": end_month},
    )


def revenue_breakdown(engine: Engine, start: dt.date, end: dt.date, group_by: str) -> pd.DataFrame:
    """group_by one of: salesperson, sales_team, segment -- for driver analysis."""
    column = {
        "salesperson": "fsl.salesperson",
        "sales_team": "fsl.SalesTeam",
        "segment": "fsl.SalesSegment",
    }[group_by]
    return _read_sql(
        engine,
        f"""
        SELECT {column} AS group_key, SUM(fsl.Value) AS value, SUM(fsl.Volume) AS volume, COUNT(*) AS n
        FROM fact_saleslines fsl
        LEFT JOIN dim_customer dc ON dc.CustomerKey = fsl.CustomerKey
        WHERE fsl.order_date_date BETWEEN :start AND :end
          AND COALESCE(dc.IsBlocked, 0) = 0
        GROUP BY {column}
        ORDER BY value DESC
        """,
        {"start": start, "end": end},
    )


def revenue_by_salesperson_key(engine: Engine, start: dt.date, end: dt.date) -> pd.DataFrame:
    """Actual revenue keyed by SalespersonKey (not name) so it joins cleanly
    against fact_targets for gap/driver analysis -- avoids relying on
    Arabic-text name matching, which is fragile."""
    return _read_sql(
        engine,
        """
        SELECT fsl.SalespersonKey AS salesperson_key, fsl.salesperson AS salesperson,
               SUM(fsl.Value) AS actual_revenue, SUM(fsl.Volume) AS actual_volume
        FROM fact_saleslines fsl
        LEFT JOIN dim_customer dc ON dc.CustomerKey = fsl.CustomerKey
        WHERE fsl.order_date_date BETWEEN :start AND :end
          AND COALESCE(dc.IsBlocked, 0) = 0
        GROUP BY fsl.SalespersonKey, fsl.salesperson
        """,
        {"start": start, "end": end},
    )


def targets_by_salesperson_key(engine: Engine, start_year: int, start_month: int, end_year: int, end_month: int) -> pd.DataFrame:
    return _read_sql(
        engine,
        """
        SELECT SalespersonKey AS salesperson_key, SUM(Target_Revenue) AS target_revenue
        FROM fact_targets
        WHERE TargetLevel = 'Salesperson'
          AND (Year > :sy OR (Year = :sy AND Month >= :sm))
          AND (Year < :ey OR (Year = :ey AND Month <= :em))
        GROUP BY SalespersonKey
        """,
        {"sy": start_year, "sm": start_month, "ey": end_year, "em": end_month},
    )


# ---------------------------------------------------------------------------
# Invoices Engine (invoice-grain rollup of fact_saleslines)
# ---------------------------------------------------------------------------

def invoices_summary(engine: Engine, start: dt.date, end: dt.date) -> pd.DataFrame:
    return _read_sql(
        engine,
        """
        SELECT
            fsl.InvoiceKey AS invoice_key,
            fsl.`Invoice Class` AS invoice_class,
            SUM(fsl.Value) AS invoice_value,
            SUM(fsl.Volume) AS invoice_volume,
            COUNT(*) AS line_count
        FROM fact_saleslines fsl
        WHERE fsl.order_date_date BETWEEN :start AND :end
          AND fsl.InvoiceKey IS NOT NULL
        GROUP BY fsl.InvoiceKey, fsl.`Invoice Class`
        """,
        {"start": start, "end": end},
    )


# ---------------------------------------------------------------------------
# Customer Growth (dim_customer + fact_saleslines)
# ---------------------------------------------------------------------------

def customers_active_in_period(engine: Engine, start: dt.date, end: dt.date) -> pd.DataFrame:
    return _read_sql(
        engine,
        """
        SELECT DISTINCT fsl.CustomerKey AS customer_key
        FROM fact_saleslines fsl
        WHERE fsl.order_date_date BETWEEN :start AND :end
        """,
        {"start": start, "end": end},
    )


def customer_dim(engine: Engine) -> pd.DataFrame:
    return _read_sql(
        engine,
        """
        SELECT CustomerKey AS customer_key, customer, CustomerSegment AS segment,
               CustomerClass_LY AS customer_class, First_Purchase_Date AS first_purchase_date,
               Last_Purchase_Date AS last_purchase_date, IsBlocked AS is_blocked,
               BlockedDate AS blocked_date, BlockedReason AS blocked_reason
        FROM dim_customer
        """,
        {},
    )


# ---------------------------------------------------------------------------
# Pipeline Health / Pipeline Trend (fact_lead, fact_opportunity, fact_sales, fact_delivery)
# ---------------------------------------------------------------------------

def pipeline_funnel(engine: Engine, start: dt.date, end: dt.date) -> dict:
    leads = _read_sql(
        engine,
        "SELECT COUNT(*) AS n FROM fact_lead WHERE LeadCreatedDate BETWEEN :start AND :end",
        {"start": start, "end": end},
    )["n"].iloc[0]
    opps = _read_sql(
        engine,
        "SELECT COUNT(*) AS n FROM fact_opportunity WHERE OpportunityCreatedDate BETWEEN :start AND :end",
        {"start": start, "end": end},
    )["n"].iloc[0]
    quotations = _read_sql(
        engine,
        """SELECT COUNT(*) AS n FROM fact_sales
           WHERE IsRealQuotation = 1 AND QuotationDate BETWEEN :start AND :end""",
        {"start": start, "end": end},
    )["n"].iloc[0]
    orders = _read_sql(
        engine,
        """SELECT COUNT(*) AS n FROM fact_sales
           WHERE IsRealSalesOrder = 1 AND OrderDate BETWEEN :start AND :end""",
        {"start": start, "end": end},
    )["n"].iloc[0]
    # IsRealDelivery is 0 for every row in this live dataset (the flag isn't
    # populated the way its name suggests) -- DeliveryStatus is the actual
    # signal, and DoneDate is when the delivery was completed.
    deliveries = _read_sql(
        engine,
        """SELECT COUNT(*) AS n FROM fact_delivery
           WHERE DeliveryStatus = 'Fully Delivered' AND DoneDate BETWEEN :start AND :end""",
        {"start": start, "end": end},
    )["n"].iloc[0]
    return {
        "leads": int(leads), "opportunities": int(opps), "quotations": int(quotations),
        "sales_orders": int(orders), "deliveries": int(deliveries),
    }


def pipeline_funnel_by_month(engine: Engine, start: dt.date, end: dt.date) -> pd.DataFrame:
    """Bulk version of pipeline_funnel, grouped by month -- used for the
    anomaly-detection monthly panel so we don't run 5 queries per month."""
    leads = _read_sql(
        engine,
        """SELECT CONCAT(YEAR(LeadCreatedDate), '-', LPAD(MONTH(LeadCreatedDate), 2, '0')) AS `year_month`, COUNT(*) AS leads
           FROM fact_lead WHERE LeadCreatedDate BETWEEN :start AND :end GROUP BY `year_month`""",
        {"start": start, "end": end},
    )
    opps = _read_sql(
        engine,
        """SELECT CONCAT(YEAR(OpportunityCreatedDate), '-', LPAD(MONTH(OpportunityCreatedDate), 2, '0')) AS `year_month`, COUNT(*) AS opportunities
           FROM fact_opportunity WHERE OpportunityCreatedDate BETWEEN :start AND :end GROUP BY `year_month`""",
        {"start": start, "end": end},
    )
    quotations = _read_sql(
        engine,
        """SELECT CONCAT(YEAR(QuotationDate), '-', LPAD(MONTH(QuotationDate), 2, '0')) AS `year_month`, COUNT(*) AS quotations
           FROM fact_sales WHERE IsRealQuotation = 1 AND QuotationDate BETWEEN :start AND :end GROUP BY `year_month`""",
        {"start": start, "end": end},
    )
    orders = _read_sql(
        engine,
        """SELECT CONCAT(YEAR(OrderDate), '-', LPAD(MONTH(OrderDate), 2, '0')) AS `year_month`, COUNT(*) AS sales_orders
           FROM fact_sales WHERE IsRealSalesOrder = 1 AND OrderDate BETWEEN :start AND :end GROUP BY `year_month`""",
        {"start": start, "end": end},
    )
    deliveries = _read_sql(
        engine,
        """SELECT CONCAT(YEAR(DoneDate), '-', LPAD(MONTH(DoneDate), 2, '0')) AS `year_month`, COUNT(*) AS deliveries
           FROM fact_delivery WHERE DeliveryStatus = 'Fully Delivered' AND DoneDate BETWEEN :start AND :end
           GROUP BY `year_month`""",
        {"start": start, "end": end},
    )
    out = leads
    for df in (opps, quotations, orders, deliveries):
        out = out.merge(df, on="year_month", how="outer")
    return out.fillna(0).sort_values("year_month").reset_index(drop=True)


def invoices_by_month(engine: Engine, start: dt.date, end: dt.date) -> pd.DataFrame:
    """Bulk version of invoices_summary, aggregated straight to monthly
    avg-sales-per-invoice/count instead of one query per month."""
    df = _read_sql(
        engine,
        """
        SELECT CONCAT(YEAR(fsl.order_date_date), '-', LPAD(MONTH(fsl.order_date_date), 2, '0')) AS `year_month`,
               fsl.InvoiceKey AS invoice_key, SUM(fsl.Value) AS invoice_value
        FROM fact_saleslines fsl
        WHERE fsl.order_date_date BETWEEN :start AND :end AND fsl.InvoiceKey IS NOT NULL
        GROUP BY `year_month`, fsl.InvoiceKey
        """,
        {"start": start, "end": end},
    )
    if df.empty:
        return df
    return (
        df.groupby("year_month")
        .agg(avg_sales_per_invoice=("invoice_value", "mean"), invoice_count=("invoice_key", "count"))
        .reset_index()
    )


def opportunities_detail(engine: Engine, start: dt.date, end: dt.date) -> pd.DataFrame:
    """Row-level opportunities for SHAP driver analysis and win-rate/aging stats."""
    return _read_sql(
        engine,
        """
        SELECT OpportunityID AS opportunity_id, OpportunityCreatedDate AS created_date,
               Stage AS stage, Probability AS probability, ExpectedRevenue AS expected_revenue,
               IsWon AS is_won, IsLost AS is_lost, IsOpen AS is_open, LostReason AS lost_reason,
               Salesperson AS salesperson, SalesTeam AS sales_team, SalesSegment AS segment,
               Company AS company, OpportunityAge AS age_days, DaysSinceLastQuotation AS days_since_quotation
        FROM fact_opportunity
        WHERE OpportunityCreatedDate BETWEEN :start AND :end
        """,
        {"start": start, "end": end},
    )


def quotations_detail(engine: Engine, start: dt.date, end: dt.date) -> pd.DataFrame:
    return _read_sql(
        engine,
        """
        SELECT SalesDocumentID AS doc_id, QuotationDate AS quotation_date, OrderDate AS order_date,
               IsRealQuotation AS is_real_quotation, IsWonQuotation AS is_won, IsRealSalesOrder AS is_real_order,
               OrderValue AS order_value, SalesSegment AS segment, Salesperson AS salesperson
        FROM fact_sales
        WHERE IsRealQuotation = 1 AND QuotationDate BETWEEN :start AND :end
        """,
        {"start": start, "end": end},
    )


# ---------------------------------------------------------------------------
# Activity Momentum -- fact_opportunity has no HasNextStep/ActivityState/etc.
# columns in this live schema (unlike what the dashboard's TS types assume).
# We approximate engagement from what actually exists: DaysSinceLastQuotation,
# OpportunityAge, IsOpen/IsWon/IsLost.
# ---------------------------------------------------------------------------

def activity_proxy(engine: Engine, start: dt.date, end: dt.date, inactive_days_threshold: int = 30) -> pd.DataFrame:
    return _read_sql(
        engine,
        """
        SELECT OpportunityID AS opportunity_id, Stage AS stage, IsOpen AS is_open,
               IsWon AS is_won, IsLost AS is_lost, LostReason AS lost_reason,
               OpportunityAge AS age_days, DaysSinceLastQuotation AS days_since_quotation,
               OpportunityCreatedDate AS created_date
        FROM fact_opportunity
        WHERE OpportunityCreatedDate BETWEEN :start AND :end
        """,
        {"start": start, "end": end},
    )
