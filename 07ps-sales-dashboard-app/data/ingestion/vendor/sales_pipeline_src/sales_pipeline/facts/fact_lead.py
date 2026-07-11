from __future__ import annotations

import pandas as pd

from sales_pipeline.crm.active_flags import build_active_flag


class LeadFactBuilder:
    COLUMNS = [
        "LeadID",
        "OdooLeadID",
        "PipelineRecordID",
        "JourneyKey",
        "LeadName",
        "LeadType",
        "LeadCreatedDate",
        "LeadCreatedDateKey",
        "LeadSource",
        "Medium",
        "Campaign",
        "Tags",
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
        "IsOdooCreatedLead",
        "IsETLCreatedLead",
        "LeadCreationSource",
        "GeneratedLeadReason",
        "IsActiveLead",
        "IsConvertedToOpportunity",
        "OpportunityID",
        "LeadAgeDays",
        "Count",
    ]

    def build(self, crm_spine: pd.DataFrame) -> pd.DataFrame:
        if crm_spine.empty:
            return pd.DataFrame(columns=self.COLUMNS)
        out = crm_spine.copy()
        lead_type = out.get("LeadType", pd.Series(pd.NA, index=out.index)).astype("string").str.strip().str.lower()
        is_etl_lead = out.get("IsETLCreatedLead", pd.Series(False, index=out.index)).astype("boolean").fillna(False).astype(bool)
        lead_mask = (lead_type.isin(["lead", "systematic"]) | is_etl_lead) & out.get("LeadID", pd.Series(pd.NA, index=out.index)).notna()
        out = out.loc[lead_mask].copy()
        if out.empty:
            return pd.DataFrame(columns=self.COLUMNS)

        out["LeadCreatedDate"] = pd.to_datetime(out.get("LeadCreatedDate", out.get("CreatedDate", pd.Series(pd.NaT, index=out.index))), errors="coerce")
        out["LeadCreatedDateKey"] = out.get("LeadCreatedDateKey", out.get("CreatedDateKey", pd.Series(pd.NA, index=out.index)))
        out["LeadSource"] = out.get("Source", pd.Series(pd.NA, index=out.index))
        out["IsConvertedToOpportunity"] = out.get("HasOpportunity", pd.Series(False, index=out.index)).astype("boolean").fillna(False).astype(bool)
        out["IsActiveLead"] = build_active_flag(out.get("IsActive", pd.Series(pd.NA, index=out.index)))
        out["LeadAgeDays"] = pd.to_numeric(out.get("DaysInPipeline", pd.Series(pd.NA, index=out.index)), errors="coerce")
        out["Count"] = 1

        for col in self.COLUMNS:
            if col not in out.columns:
                out[col] = pd.NA
        return out[self.COLUMNS]
