from __future__ import annotations

import pandas as pd

from sales_pipeline.crm.active_flags import build_active_flag, coerce_nullable_bool
from sales_pipeline.crm.crm_cleaner import date_key


class OpportunityFactBuilder:
    COLUMNS = [
        "OpportunityID",
        "LeadID",
        "JourneyKey",
        "PipelineRecordID",
        "OpportunityName",
        "OpportunityCreatedDate",
        "OpportunityCreatedDateKey",
        "ExpectedCloseDate",
        "ExpectedCloseDateKey",
        "StageID",
        "Stage",
        "Probability",
        "ProbabilityBucket",
        "ExpectedRevenue",
        "ProratedRevenue",
        "IsActiveOpportunity",
        "IsWon",
        "IsLost",
        "IsOpen",
        "LostReason",
        "LostReasonID",
        "Salesperson",
        "SalespersonID",
        "SalespersonKey",
        "SalesTeam",
        "SalesTeamID",
        "SalesTeamKey",
        "SalesSegment",
        "SegmentKey",
        "Company",
        "CompanyKey",
        "Customer",
        "CustomerID",
        "CustomerKey",
        "HasQuotation",
        "FirstQuotationDate",
        "FirstQuotationDateKey",
        "LastQuotationID",
        "LastQuotationDate",
        "LastQuotationValue",
        "LastQuotationStatus",
        "DaysSinceLastQuotation",
        "OpportunityAge",
        # Added for the Activity Momentum dashboard page: already computed upstream on the
        # crm_spine by PipelineFactBuilder (see facts/fact_pipeline.py) and passed through
        # `out = crm_spine.copy()` above unchanged -- these were simply never selected into this
        # builder's output before. No new derivation logic; this only exposes existing columns.
        "ActivityState",
        "NextActivityDate",
        "HasNextStep",
        "HasRecentActivity",
        "IsInactive",
        "DaysSinceUpdate",
        "Count",
    ]

    def build(
        self,
        crm_spine: pd.DataFrame,
        fact_sales: pd.DataFrame | None = None,
        refresh_date: object | None = None,
    ) -> pd.DataFrame:
        if crm_spine.empty:
            return pd.DataFrame(columns=self.COLUMNS)
        out = crm_spine.copy()
        pipeline_record_id = out.get("PipelineRecordID", pd.Series(pd.NA, index=out.index)).astype("string")
        opportunity_id = out.get("OpportunityID", pd.Series(pd.NA, index=out.index))
        lead_type = out.get("LeadType", pd.Series(pd.NA, index=out.index)).astype("string").str.strip().str.lower()
        opportunity_mask = (
            opportunity_id.notna()
            & ~lead_type.isin(["lead", "systematic"])
            & (pipeline_record_id.str.startswith("OPP-", na=False) | lead_type.eq("opportunity"))
        )
        out = out.loc[opportunity_mask].copy()
        if out.empty:
            return pd.DataFrame(columns=self.COLUMNS)

        opportunity_created = pd.to_datetime(out.get("OpenDate", pd.Series(pd.NaT, index=out.index)), errors="coerce").combine_first(
            pd.to_datetime(out.get("CreatedDate", pd.Series(pd.NaT, index=out.index)), errors="coerce")
        )
        out["OpportunityName"] = out.get("LeadName", pd.Series(pd.NA, index=out.index))
        out["OpportunityCreatedDate"] = pd.to_datetime(out.get("OpportunityCreatedDate", pd.Series(pd.NaT, index=out.index)), errors="coerce").combine_first(opportunity_created)
        out["OpportunityCreatedDateKey"] = date_key(out["OpportunityCreatedDate"])
        out["HasQuotation"] = out.get("HasQuotation", pd.Series(False, index=out.index)).astype("boolean").fillna(False).astype(bool)
        out["FirstQuotationDate"] = pd.to_datetime(out.get("QuotationDate", pd.Series(pd.NaT, index=out.index)), errors="coerce")
        out["FirstQuotationDateKey"] = date_key(out["FirstQuotationDate"])
        out["IsActiveOpportunity"] = build_active_flag(out.get("IsActive", pd.Series(pd.NA, index=out.index)))
        out["OpportunityAge"] = pd.to_numeric(out.get("DaysInPipeline", pd.Series(pd.NA, index=out.index)), errors="coerce")
        out["Count"] = 1
        out = self._attach_latest_quotation(out, fact_sales, refresh_date)

        for col in self.COLUMNS:
            if col not in out.columns:
                out[col] = pd.NA
        return out[self.COLUMNS]

    @classmethod
    def _attach_latest_quotation(
        cls,
        opportunities: pd.DataFrame,
        fact_sales: pd.DataFrame | None,
        refresh_date: object | None,
    ) -> pd.DataFrame:
        out = opportunities.copy()
        last_cols = [
            "LastQuotationID",
            "LastQuotationDate",
            "LastQuotationValue",
            "LastQuotationStatus",
            "DaysSinceLastQuotation",
        ]
        out = out.drop(columns=last_cols, errors="ignore")
        for col in last_cols:
            out[col] = pd.NA

        if fact_sales is None or fact_sales.empty:
            return out

        source = fact_sales.copy()
        opportunity_id = pd.to_numeric(source.get("OpportunityID", pd.Series(pd.NA, index=source.index)), errors="coerce").astype("Int64")
        quotation_id = pd.to_numeric(source.get("QuotationID", pd.Series(pd.NA, index=source.index)), errors="coerce").astype("Int64")
        quotation_date = pd.to_datetime(source.get("QuotationDate", pd.Series(pd.NaT, index=source.index)), errors="coerce")
        document_type = source.get("SalesDocumentType", pd.Series(pd.NA, index=source.index)).astype("string").str.strip()
        sales_segment = source.get("SalesSegment", pd.Series(pd.NA, index=source.index)).astype("string").str.strip().str.upper()
        is_real_quotation = coerce_nullable_bool(source.get("IsRealQuotation", pd.Series(False, index=source.index))).fillna(False).astype(bool)

        valid = (
            document_type.eq("Quotation")
            & sales_segment.eq("B2B")
            & is_real_quotation
            & opportunity_id.notna()
            & quotation_id.notna()
            & quotation_date.notna()
        )
        if not valid.any():
            return out

        document_number_col = "SalesDocumentNumber" if "SalesDocumentNumber" in source.columns else "OrderNumber"
        quotes = pd.DataFrame(
            {
                "_OpportunityID": opportunity_id[valid],
                "LastQuotationID": quotation_id[valid],
                "LastQuotationDate": quotation_date[valid],
                "LastQuotationValue": pd.to_numeric(source.get("OrderValue", pd.Series(pd.NA, index=source.index)), errors="coerce")[valid],
                "LastQuotationStatus": source.get("OrderState", pd.Series(pd.NA, index=source.index))[valid],
                "_SalesDocumentNumber": source.get(document_number_col, pd.Series(pd.NA, index=source.index)).astype("string")[valid],
            }
        )
        quotes = quotes.sort_values(
            ["_OpportunityID", "LastQuotationDate", "LastQuotationID", "_SalesDocumentNumber"],
            kind="mergesort",
        )
        latest = quotes.groupby("_OpportunityID", as_index=False).tail(1).copy()

        refresh = cls._refresh_timestamp(refresh_date)
        days = pd.Series(pd.NA, index=latest.index, dtype="Int64")
        has_date = latest["LastQuotationDate"].notna()
        days.loc[has_date] = ((refresh - latest.loc[has_date, "LastQuotationDate"]).dt.total_seconds() // 86400).astype("int64")
        latest["DaysSinceLastQuotation"] = days
        latest = latest.drop(columns=["_SalesDocumentNumber"])

        out["_OpportunityID"] = pd.to_numeric(out["OpportunityID"], errors="coerce").astype("Int64")
        out = out.drop(columns=last_cols, errors="ignore").merge(latest, on="_OpportunityID", how="left", validate="m:1")
        out = out.drop(columns=["_OpportunityID"], errors="ignore")
        for col in last_cols:
            if col not in out.columns:
                out[col] = pd.NA
        return out

    @staticmethod
    def _refresh_timestamp(refresh_date: object | None) -> pd.Timestamp:
        refresh = pd.Timestamp.now() if refresh_date is None else pd.Timestamp(refresh_date)
        if refresh.tzinfo is not None:
            refresh = refresh.tz_convert(None)
        return refresh
