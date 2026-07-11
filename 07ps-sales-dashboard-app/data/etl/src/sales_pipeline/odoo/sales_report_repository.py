from __future__ import annotations

import logging
import math
from typing import Any

import pandas as pd

from sales_pipeline.odoo.client import OdooClient


SALE_REPORT_FIELDS = [
    "date",
    "name",
    "partner_id",
    "product_id",
    "user_id",
    "team_id",
    "company_id",
    "price_subtotal",
    "price_total",
    "qty_invoiced",
    "state",
    "invoice_status",
]

OLD_EXPORT_COLUMN_MAP = {
    "date": "Order Date",
    "name": "Related Order",
    "partner_id": "Customer",
    "product_id": "Product",
    "user_id": "Salesperson",
    "team_id": "Sales Team",
    "company_id": "Company",
    "price_subtotal": "Untaxed Total",
    "price_total": "Total",
    "qty_invoiced": "Qty Invoiced",
    "state": "Status",
    "invoice_status": "Invoice Status",
}


def flatten_many2one(value: Any) -> Any:
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return value[1]
    if value is False or value is None:
        return ""
    return value


def safe_datetime_to_local(series: pd.Series, timezone: str, assume_utc_for_naive: bool = False) -> pd.Series:
    text = series.astype("string").str.strip()
    tz_mask = text.str.contains(r"(?:Z|[+-]\d{2}:?\d{2})$", regex=True, na=False)
    out = pd.Series(pd.NaT, index=series.index, dtype="datetime64[ns]")
    if tz_mask.any():
        aware = pd.to_datetime(text[tz_mask], errors="coerce", utc=True)
        out.loc[tz_mask] = aware.dt.tz_convert(timezone).dt.tz_localize(None)
    if (~tz_mask).any():
        naive = pd.to_datetime(text[~tz_mask], errors="coerce")
        if assume_utc_for_naive:
            naive = naive.dt.tz_localize("UTC").dt.tz_convert(timezone).dt.tz_localize(None)
        out.loc[~tz_mask] = naive
    return out


def odoo_utc_datetime_to_local(series: pd.Series, timezone: str) -> pd.Series:
    """Convert Odoo API datetime values from UTC into the business timezone.

    Odoo datetime fields are stored and returned in UTC. Many XML-RPC values are
    naive strings, so sales reporting must localize those values as UTC first,
    convert to the configured business timezone, and only then derive date keys.
    """
    return safe_datetime_to_local(series, timezone, assume_utc_for_naive=True)


class SalesReportRepository:
    def __init__(self, client: OdooClient, batch_size: int = 500, timezone: str = "Africa/Tripoli", assume_utc_for_naive: bool = False) -> None:
        self.client = client
        self.batch_size = batch_size
        self.timezone = timezone
        self.assume_utc_for_naive = assume_utc_for_naive
        self.logger = logging.getLogger(__name__)

    def fetch_sale_report(self, domain: list[Any] | None = None) -> pd.DataFrame:
        domain = domain or []
        total = self.client.search_count("sale.report", domain)
        self.logger.info("sale.report rows available: %s", f"{total:,}")
        if total == 0:
            return pd.DataFrame(columns=list(OLD_EXPORT_COLUMN_MAP.values()))

        pages = math.ceil(total / self.batch_size)
        rows: list[dict[str, Any]] = []
        for page in range(pages):
            offset = page * self.batch_size
            self.logger.info("Fetching sale.report batch %s/%s offset=%s limit=%s", page + 1, pages, offset, self.batch_size)
            chunk = self.client.search_read("sale.report", domain, SALE_REPORT_FIELDS, offset=offset, limit=self.batch_size, order="id")
            rows.extend(self._normalize_records(chunk))

        df = pd.DataFrame(rows, columns=SALE_REPORT_FIELDS + ["OdooProductID"]).rename(columns=OLD_EXPORT_COLUMN_MAP)
        df["Order Date"] = safe_datetime_to_local(df["Order Date"], self.timezone, self.assume_utc_for_naive)
        return df

    @staticmethod
    def _normalize_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        many2one = {field for field in SALE_REPORT_FIELDS if field.endswith("_id")}
        normalized: list[dict[str, Any]] = []
        for rec in records:
            row = {}
            for field in SALE_REPORT_FIELDS:
                value = rec.get(field, "")
                row[field] = flatten_many2one(value) if field in many2one else ("" if value is None or value is False else value)
            product = rec.get("product_id")
            row["OdooProductID"] = product[0] if isinstance(product, (list, tuple)) and product else pd.NA
            normalized.append(row)
        return normalized
