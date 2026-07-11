from __future__ import annotations

import pandas as pd

from sales_pipeline.crm.crm_cleaner import date_key
from sales_pipeline.facts.quotation_classification import (
    add_quotation_classification,
    add_quotation_outcome_flags,
    add_sales_order_classification,
)


class SalesFactBuilder:
    COLUMNS = [
        "SalesDocumentID",
        "SalesDocumentType",
        "QuotationID",
        "SourceQuotationID",
        "OrderID",
        "SalesOrderID",
        "OrderNumber",
        "JourneyKey",
        "QuotationDate",
        "SalesOrderDate",
        "QuotationAgeMinutes",
        "QuotationAgeHours",
        "QuotationToSalesOrderMinutes",
        "QuotationToSalesOrderHours",
        "IsRealQuotation",
        "IsSystemGeneratedQuotation",
        "IsWonQuotation",
        "QuotationClassification",
        "QuotationRealReason",
        "IsRealSalesOrder",
        "SalesOrderClassification",
        "OrderDate",
        "OrderDateTime",
        "DateKey",
        "CustomerKey",
        "Customer",
        "CustomerID",
        "Salesperson",
        "SalespersonKey",
        "SalesTeam",
        "SalesTeamKey",
        "SalesSegment",
        "SegmentKey",
        "SalesCity",
        "SalesTeamStatus",
        "DistributionChannel",
        "ChannelKey",
        "Company",
        "CompanyKey",
        "OpportunityID",
        "LeadID",
        "IsLinkedToOpportunity",
        "OrderValue",
        "OrderVolume",
        "InvoiceStatus",
        "OrderState",
        "InvoiceKey",
    ]

    def build(
        self,
        orders: pd.DataFrame,
        pipeline: pd.DataFrame,
        fact_orders: pd.DataFrame | None = None,
        refresh_date: object | None = None,
    ) -> pd.DataFrame:
        out = pd.DataFrame(index=orders.index)
        if orders.empty:
            return pd.DataFrame(columns=self.COLUMNS)

        order_id = pd.to_numeric(orders.get("id", pd.Series(index=orders.index, dtype="object")), errors="coerce").astype("Int64")
        state = orders.get("state", pd.Series(pd.NA, index=orders.index)).astype("string").str.strip().str.lower()
        is_sales_order = state.isin(["sale", "done"])

        out["SalesDocumentID"] = order_id
        out["SalesDocumentType"] = "Quotation"
        out.loc[is_sales_order, "SalesDocumentType"] = "Sales Order"
        out["QuotationID"] = order_id
        out["SourceQuotationID"] = order_id
        out["OrderID"] = order_id.where(is_sales_order, pd.NA).astype("Int64")
        out["SalesOrderID"] = out["OrderID"]
        out["OrderNumber"] = orders.get("name", pd.Series(pd.NA, index=orders.index))
        out["OrderDateTime"] = pd.to_datetime(orders.get("date_order", pd.Series(pd.NaT, index=orders.index)), errors="coerce")
        order_create_date = pd.to_datetime(orders.get("create_date", pd.Series(pd.NaT, index=orders.index)), errors="coerce")
        out["QuotationDate"] = order_create_date.combine_first(out["OrderDateTime"])
        out["SalesOrderDate"] = out["OrderDateTime"].where(is_sales_order, pd.NaT)
        out = add_quotation_classification(out, refresh_date=refresh_date)
        out = add_sales_order_classification(out)
        out = add_quotation_outcome_flags(out)
        out["OrderDate"] = out["OrderDateTime"].dt.normalize()
        out["DateKey"] = date_key(out["OrderDateTime"])
        out["Customer"] = orders.get("partner_id", pd.Series(pd.NA, index=orders.index))
        out["CustomerID"] = pd.to_numeric(orders.get("partner_id_id", pd.Series(pd.NA, index=orders.index)), errors="coerce").astype("Int64")
        out["Salesperson"] = orders.get("user_id", pd.Series(pd.NA, index=orders.index))
        out["SalesTeam"] = orders.get("team_id", pd.Series(pd.NA, index=orders.index))
        out["Company"] = orders.get("company_id", pd.Series(pd.NA, index=orders.index))
        out["OpportunityID"] = pd.to_numeric(orders.get("opportunity_id_id", pd.Series(pd.NA, index=orders.index)), errors="coerce").astype("Int64")
        out["LeadID"] = self._lead_id_for_opportunity(out["OpportunityID"], pipeline)
        out["JourneyKey"] = self._journey_key(out["LeadID"], out["OpportunityID"], out["SourceQuotationID"])
        out["IsLinkedToOpportunity"] = out["OpportunityID"].notna()
        out["OrderValue"] = pd.to_numeric(orders.get("amount_total", pd.Series(pd.NA, index=orders.index)), errors="coerce")
        out["OrderVolume"] = pd.NA
        out["InvoiceStatus"] = orders.get("invoice_status", pd.Series(pd.NA, index=orders.index))
        out["OrderState"] = orders.get("state", pd.Series(pd.NA, index=orders.index))

        if fact_orders is not None and not fact_orders.empty and {"order_number", "OrderVolume"}.issubset(fact_orders.columns):
            order_volume = fact_orders[["order_number", "OrderVolume"]].dropna(subset=["order_number"]).drop_duplicates("order_number")
            out = out.merge(order_volume, left_on="OrderNumber", right_on="order_number", how="left", validate="m:1", suffixes=("", "_fact"))
            fact_volume = pd.to_numeric(out["OrderVolume_fact"], errors="coerce")
            base_volume = pd.to_numeric(out["OrderVolume"], errors="coerce")
            out["OrderVolume"] = fact_volume.where(fact_volume.notna(), base_volume)
            out = out.drop(columns=["order_number", "OrderVolume_fact"], errors="ignore")

        for col in self.COLUMNS:
            if col not in out.columns:
                out[col] = pd.NA
        return out[self.COLUMNS]

    def project(self, sales: pd.DataFrame, refresh_date: object | None = None) -> pd.DataFrame:
        out = add_quotation_classification(sales, refresh_date=refresh_date)
        out = add_sales_order_classification(out)
        out = add_quotation_outcome_flags(out)
        for col in self.COLUMNS:
            if col not in out.columns:
                out[col] = pd.NA
        return out[self.COLUMNS]

    @staticmethod
    def _lead_id_for_opportunity(opportunity_id: pd.Series, pipeline: pd.DataFrame) -> pd.Series:
        if pipeline.empty or not {"OpportunityID", "LeadID"}.issubset(pipeline.columns):
            return pd.Series(pd.NA, index=opportunity_id.index, dtype="object")
        lookup = pipeline[["OpportunityID", "LeadID"]].dropna(subset=["OpportunityID"]).drop_duplicates("OpportunityID")
        lookup["_OpportunityID"] = pd.to_numeric(lookup["OpportunityID"], errors="coerce").astype("Int64")
        lead_map = dict(zip(lookup["_OpportunityID"].astype("string"), lookup["LeadID"]))
        return opportunity_id.astype("string").map(lead_map)

    @staticmethod
    def _journey_key(lead_id: pd.Series, opportunity_id: pd.Series, quotation_id: pd.Series) -> pd.Series:
        out = pd.Series(pd.NA, index=quotation_id.index, dtype="object")
        lead_text = lead_id.astype("string")
        opportunity_text = opportunity_id.astype("string")
        quotation_text = quotation_id.astype("string")
        has_lead = lead_id.notna()
        has_opportunity = opportunity_id.notna()
        has_quotation = quotation_id.notna()
        out.loc[has_lead] = "LEAD-" + lead_text[has_lead]
        etl_lead = has_lead & lead_text.str.startswith("ETL-LEAD-", na=False)
        out.loc[etl_lead] = lead_text[etl_lead]
        out.loc[~has_lead & has_opportunity] = "OPP-" + opportunity_text[~has_lead & has_opportunity]
        out.loc[~has_lead & ~has_opportunity & has_quotation] = "QUOTE-" + quotation_text[~has_lead & ~has_opportunity & has_quotation]
        return out
