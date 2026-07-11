from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass
class CrmValidationSummary:
    crm_leads_fetched: int = 0
    crm_opportunities_fetched: int = 0
    quotations_fetched: int = 0
    sales_orders_fetched: int = 0
    deliveries_fetched: int = 0
    crm_output_sheets_exported: int = 0
    qa_issues_count: int = 0


class CrmModelBuilder:
    @staticmethod
    def build_missing_links(leads: pd.DataFrame, orders: pd.DataFrame) -> pd.DataFrame:
        """Return structural CRM data issues, not natural journey skips.

        Sales documents without CRM links and opportunities without quotations
        are valid flow outcomes. They are analyzed through JourneyKey, Has*
        flags, JourneyType, and FlowType instead of being counted as QA errors.
        """
        rows: list[dict[str, object]] = []
        for _, row in leads.iterrows():
            lead_id = row.get("LeadID")
            opportunity_id = row.get("OpportunityID", row.get("OdooLeadID", lead_id))
            opportunity_key = pd.to_numeric(pd.Series([opportunity_id]), errors="coerce").dropna()
            is_opportunity = not opportunity_key.empty
            if not is_opportunity:
                continue
            source_id = int(opportunity_key.iloc[0])
            if pd.isna(row.get("StageID")):
                rows.append(
                    {
                        "IssueType": "opportunity has missing stage",
                        "LeadID": lead_id,
                        "SourceModel": "crm.lead",
                        "SourceID": source_id,
                        "SourceDocument": row.get("LeadName"),
                        "Notes": "StageID is blank",
                    }
                )
            if pd.isna(row.get("SalespersonID")):
                rows.append(
                    {
                        "IssueType": "opportunity has missing salesperson",
                        "LeadID": lead_id,
                        "SourceModel": "crm.lead",
                        "SourceID": source_id,
                        "SourceDocument": row.get("LeadName"),
                        "Notes": "SalespersonID is blank",
                    }
                )
            if pd.isna(row.get("ExpectedRevenue")):
                rows.append(
                    {
                        "IssueType": "opportunity has missing expected revenue",
                        "LeadID": lead_id,
                        "SourceModel": "crm.lead",
                        "SourceID": source_id,
                        "SourceDocument": row.get("LeadName"),
                        "Notes": "ExpectedRevenue is blank",
                    }
                )
        return pd.DataFrame(rows, columns=["IssueType", "LeadID", "SourceModel", "SourceID", "SourceDocument", "Notes"])
