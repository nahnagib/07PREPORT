from __future__ import annotations

import pandas as pd


REAL_QUOTATION_THRESHOLD_HOURS = 24
REAL_QUOTATION_THRESHOLD_MINUTES = REAL_QUOTATION_THRESHOLD_HOURS * 60

QUOTATION_CLASSIFICATION_COLUMNS = [
    "QuotationAgeMinutes",
    "QuotationAgeHours",
    "QuotationToSalesOrderMinutes",
    "QuotationToSalesOrderHours",
    "IsRealQuotation",
    "IsSystemGeneratedQuotation",
    "IsWonQuotation",
    "QuotationClassification",
    "QuotationRealReason",
]

SALES_ORDER_CLASSIFICATION_COLUMNS = [
    "IsRealSalesOrder",
    "SalesOrderClassification",
]

DELIVERY_CLASSIFICATION_COLUMNS = [
    "IsRealSalesOrder",
    "IsRealDelivery",
    "DeliveryClassification",
]


def add_quotation_classification(
    frame: pd.DataFrame,
    quotation_col: str = "QuotationDate",
    sales_order_col: str = "SalesOrderDate",
    refresh_date: object | None = None,
) -> pd.DataFrame:
    out = frame.copy()
    quotation_date = pd.to_datetime(out.get(quotation_col, pd.Series(pd.NaT, index=out.index)), errors="coerce")
    sales_order_date = pd.to_datetime(out.get(sales_order_col, pd.Series(pd.NaT, index=out.index)), errors="coerce")
    sales_document_type = out.get("SalesDocumentType", pd.Series(pd.NA, index=out.index)).astype("string").str.strip()
    order_state = out.get("OrderState", pd.Series(pd.NA, index=out.index)).astype("string").str.strip().str.lower()
    sales_segment = out.get("SalesSegment", pd.Series(pd.NA, index=out.index)).astype("string").str.strip().str.upper()
    is_b2b = sales_segment.eq("B2B").fillna(False).astype(bool)
    is_sales_order = sales_document_type.eq("Sales Order")
    is_lost_or_cancelled = order_state.isin(["cancel", "cancelled", "lost"])
    quote_key = _quotation_key(out)
    linked_sales_order_date = sales_order_date.combine_first(_linked_sales_order_date(quote_key, sales_order_date, is_sales_order))
    has_sales_order_link = linked_sales_order_date.notna() | pd.to_numeric(out.get("SalesOrderID", pd.Series(pd.NA, index=out.index)), errors="coerce").notna()

    refresh = _refresh_timestamp(refresh_date)
    age_end = linked_sales_order_date.where(has_sales_order_link, refresh)
    missing_age_end = has_sales_order_link & linked_sales_order_date.isna()

    age_seconds = (age_end - quotation_date).dt.total_seconds()
    to_sales_order_seconds = (linked_sales_order_date - quotation_date).dt.total_seconds()

    age_minutes = pd.Series(pd.NA, index=out.index, dtype="Int64")
    has_age_dates = quotation_date.notna() & age_end.notna()
    age_minutes.loc[has_age_dates] = (age_seconds.loc[has_age_dates] // 60).astype("int64")

    age_hours = pd.Series(pd.NA, index=out.index, dtype="Float64")
    age_hours.loc[has_age_dates] = age_seconds.loc[has_age_dates] / 3600

    to_sales_order_minutes = pd.Series(pd.NA, index=out.index, dtype="Int64")
    has_to_sales_order_dates = quotation_date.notna() & linked_sales_order_date.notna()
    to_sales_order_minutes.loc[has_to_sales_order_dates] = (to_sales_order_seconds.loc[has_to_sales_order_dates] // 60).astype("int64")

    to_sales_order_hours = pd.Series(pd.NA, index=out.index, dtype="Float64")
    to_sales_order_hours.loc[has_to_sales_order_dates] = to_sales_order_seconds.loc[has_to_sales_order_dates] / 3600

    invalid = (has_to_sales_order_dates & to_sales_order_minutes.lt(0).fillna(False)).astype(bool)
    missing_dates = quotation_date.isna() | missing_age_end
    real = (is_b2b & ~missing_dates & ~invalid & age_minutes.ge(REAL_QUOTATION_THRESHOLD_MINUTES).fillna(False)).astype(bool)
    system_generated = (
        is_b2b
        & has_sales_order_link
        & ~missing_dates
        & ~invalid
        & age_minutes.lt(REAL_QUOTATION_THRESHOLD_MINUTES).fillna(False)
    ).astype(bool)

    reason = pd.Series("Not Applicable", index=out.index, dtype="string")
    reason.loc[missing_dates] = "Unclassified - Missing Dates"
    reason.loc[system_generated] = "System - Converted Within 24h"
    reason.loc[real & has_sales_order_link] = "Real - Converted After 24h"
    reason.loc[real & ~has_sales_order_link & is_lost_or_cancelled] = "Real - Lost/Cancelled After 24h"
    reason.loc[real & ~has_sales_order_link & ~is_lost_or_cancelled] = "Real - Still Open After 24h"
    reason.loc[invalid] = "Invalid - Sales Order Before Quotation"

    classification = pd.Series("Not Applicable", index=out.index, dtype="string")
    classification.loc[missing_dates] = "Unclassified"
    classification.loc[system_generated] = "System Generated Quotation"
    classification.loc[real] = "Real Quotation"
    classification.loc[invalid] = "Invalid Date Sequence"

    out["QuotationAgeMinutes"] = age_minutes
    out["QuotationAgeHours"] = age_hours
    out["QuotationToSalesOrderMinutes"] = to_sales_order_minutes
    out["QuotationToSalesOrderHours"] = to_sales_order_hours
    out["IsRealQuotation"] = real
    out["IsSystemGeneratedQuotation"] = system_generated
    out["QuotationClassification"] = classification
    out["QuotationRealReason"] = reason
    return out


def add_sales_order_classification(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    sales_document_type = out.get("SalesDocumentType", pd.Series(pd.NA, index=out.index)).astype("string")
    is_sales_order = sales_document_type.eq("Sales Order")
    sales_segment = out.get("SalesSegment", pd.Series(pd.NA, index=out.index)).astype("string").str.strip().str.upper()
    is_b2b = sales_segment.eq("B2B").fillna(False).astype(bool)
    quote_key = _quotation_key(out)
    has_quotation_link = quote_key.notna()
    is_real_quotation = _coerce_bool_series(out.get("IsRealQuotation", pd.Series(False, index=out.index)))
    linked_quotation_real = quote_key.map(_linked_quotation_real_by_key(quote_key, is_sales_order, is_real_quotation)).astype("boolean")
    linked_quotation_real = linked_quotation_real.where(linked_quotation_real.notna(), is_real_quotation).fillna(False).astype(bool)
    is_real_sales_order = (is_sales_order & is_b2b & has_quotation_link & linked_quotation_real).astype(bool)

    classification = pd.Series("Unclassified", index=out.index, dtype="string")
    classification.loc[is_sales_order & ~is_real_sales_order] = "System Generated / Non-CRM Sales Order"
    classification.loc[is_real_sales_order] = "Real Sales Order"

    out["IsRealSalesOrder"] = is_real_sales_order
    out["SalesOrderClassification"] = classification
    return out


def add_quotation_outcome_flags(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    sales_document_type = out.get("SalesDocumentType", pd.Series(pd.NA, index=out.index)).astype("string")
    is_quotation_row = sales_document_type.eq("Quotation")
    quote_key = _quotation_key(out)
    is_real_quotation = _coerce_bool_series(out.get("IsRealQuotation", pd.Series(False, index=out.index)))
    is_real_sales_order = _coerce_bool_series(out.get("IsRealSalesOrder", pd.Series(False, index=out.index)))
    sales_order_real_by_quote = _linked_sales_order_real_by_key(quote_key, sales_document_type.eq("Sales Order"), is_real_sales_order)
    linked_real_sales_order = quote_key.map(sales_order_real_by_quote).astype("boolean").fillna(False).astype(bool)
    is_won_quotation = (is_quotation_row & is_real_quotation & linked_real_sales_order).astype(bool)

    out["IsWonQuotation"] = is_won_quotation
    return out


def add_delivery_classification(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()

    sales_order_id = out.get("SalesOrderID", pd.Series(pd.NA, index=out.index))
    delivery_id = out.get("DeliveryID", pd.Series(pd.NA, index=out.index))
    picking_id = out.get("PickingID", pd.Series(pd.NA, index=out.index))

    has_sales_order = pd.to_numeric(sales_order_id, errors="coerce").notna()
    has_delivery = (
        pd.to_numeric(delivery_id, errors="coerce").notna()
        | pd.to_numeric(picking_id, errors="coerce").notna()
    )

    if "IsRealSalesOrder" in out.columns and out["IsRealSalesOrder"].notna().any():
        is_real_sales_order = _coerce_bool_series(out["IsRealSalesOrder"])
        is_real_delivery = (has_delivery & has_sales_order & is_real_sales_order).astype(bool)
    elif "IsRealDelivery" in out.columns:
        is_real_delivery = (
            has_delivery
            & has_sales_order
            & _coerce_bool_series(out["IsRealDelivery"])
        ).astype(bool)
    else:
        is_real_delivery = pd.Series(False, index=out.index)

    classification = pd.Series("Unclassified", index=out.index, dtype="string")
    classification.loc[has_delivery & has_sales_order & ~is_real_delivery] = "System Generated / Non-CRM Delivery"
    classification.loc[is_real_delivery] = "Real Delivery"

    out["IsRealDelivery"] = is_real_delivery
    out["DeliveryClassification"] = classification
    return out


def _coerce_bool_series(series: pd.Series) -> pd.Series:
    if pd.api.types.is_bool_dtype(series):
        return series.fillna(False).astype(bool)
    text = series.astype("string").str.strip().str.lower()
    mapped = text.map(
        {
            "true": True,
            "1": True,
            "yes": True,
            "y": True,
            "false": False,
            "0": False,
            "no": False,
            "n": False,
        }
    )
    return mapped.astype("boolean").fillna(False).astype(bool)


def _refresh_timestamp(refresh_date: object | None) -> pd.Timestamp:
    refresh = pd.Timestamp.now() if refresh_date is None else pd.Timestamp(refresh_date)
    if refresh.tzinfo is not None:
        refresh = refresh.tz_convert(None)
    return refresh


def _quotation_key(frame: pd.DataFrame) -> pd.Series:
    source = frame.get("SourceQuotationID", pd.Series(pd.NA, index=frame.index)).astype("string")
    quotation = frame.get("QuotationID", pd.Series(pd.NA, index=frame.index)).astype("string")
    key = source.where(source.notna(), quotation)
    return key.astype("string").str.strip().replace({"": pd.NA, "<NA>": pd.NA, "nan": pd.NA, "None": pd.NA})


def _linked_sales_order_date(quote_key: pd.Series, sales_order_date: pd.Series, is_sales_order: pd.Series) -> pd.Series:
    linked = pd.Series(pd.NaT, index=quote_key.index)
    source = pd.DataFrame({"QuotationKey": quote_key, "SalesOrderDate": sales_order_date, "IsSalesOrder": is_sales_order})
    source = source[source["IsSalesOrder"] & source["QuotationKey"].notna() & source["SalesOrderDate"].notna()]
    if source.empty:
        return linked
    by_key = source.groupby("QuotationKey")["SalesOrderDate"].min()
    return quote_key.map(by_key)


def _linked_quotation_real_by_key(quote_key: pd.Series, is_sales_order: pd.Series, is_real_quotation: pd.Series) -> dict[str, bool]:
    source = pd.DataFrame({"QuotationKey": quote_key, "IsSalesOrder": is_sales_order, "IsRealQuotation": is_real_quotation})
    quotes = source[source["QuotationKey"].notna() & ~source["IsSalesOrder"]]
    if quotes.empty:
        return {}
    return quotes.groupby("QuotationKey")["IsRealQuotation"].max().astype(bool).to_dict()


def _linked_sales_order_real_by_key(quote_key: pd.Series, is_sales_order: pd.Series, is_real_sales_order: pd.Series) -> dict[str, bool]:
    source = pd.DataFrame({"QuotationKey": quote_key, "IsSalesOrder": is_sales_order, "IsRealSalesOrder": is_real_sales_order})
    sales_orders = source[source["QuotationKey"].notna() & source["IsSalesOrder"]]
    if sales_orders.empty:
        return {}
    return sales_orders.groupby("QuotationKey")["IsRealSalesOrder"].max().astype(bool).to_dict()
