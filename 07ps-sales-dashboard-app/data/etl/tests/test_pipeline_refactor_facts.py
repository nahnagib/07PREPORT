from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from config.settings import Settings  # noqa: E402
from sales_pipeline.crm.crm_cleaner import CrmCleaner  # noqa: E402
from sales_pipeline.crm.crm_metrics import CrmModelBuilder  # noqa: E402
from sales_pipeline.facts.fact_delivery import DeliveryFactBuilder  # noqa: E402
from sales_pipeline.facts.fact_lead import LeadFactBuilder  # noqa: E402
from sales_pipeline.facts.fact_opportunity import OpportunityFactBuilder  # noqa: E402
from sales_pipeline.facts.fact_pipeline import PipelineFactBuilder  # noqa: E402
from sales_pipeline.facts.fact_sales import SalesFactBuilder  # noqa: E402
from sales_pipeline.facts.quotation_classification import add_delivery_classification, add_quotation_classification, add_quotation_outcome_flags, add_sales_order_classification  # noqa: E402
from sales_pipeline.pipeline import PowerBISalesPipeline  # noqa: E402


def _settings() -> Settings:
    return Settings(
        odoo_url="x",
        odoo_db="x",
        odoo_user="x",
        odoo_api_key="x",
        input_dir=Path("Input"),
        output_dir=Path("Exports"),
        output_file="out.xlsx",
        batch_size=100,
        timezone="Africa/Tripoli",
        assume_utc_for_naive=False,
    )


def _pipeline() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "LeadID": "122",
                "OpportunityID": 10,
                "IsOdooCreatedLead": True,
                "IsETLCreatedLead": False,
                "IsSystemGeneratedLead": False,
            }
        ]
    )


def test_fact_sales_keeps_sales_order_quotation_linkage_and_opportunity() -> None:
    orders = pd.DataFrame(
        [
            {
                "id": 100,
                "name": "SO100",
                "state": "sale",
                "create_date": pd.Timestamp("2026-01-09 09:59:00"),
                "date_order": pd.Timestamp("2026-01-10 10:00:00"),
                "partner_id": "Customer A",
                "partner_id_id": 500,
                "user_id": "Sales A",
                "team_id": "Team A",
                "company_id": "Company A",
                "opportunity_id_id": 10,
                "amount_total": 1200,
                "invoice_status": "to invoice",
            }
        ]
    )

    fact = SalesFactBuilder().build(orders, _pipeline())
    row = fact.iloc[0]

    assert row["SalesDocumentType"] == "Sales Order"
    assert row["OrderID"] == 100
    assert row["QuotationID"] == 100
    assert row["SourceQuotationID"] == 100
    assert row["OpportunityID"] == 10
    assert row["LeadID"] == "122"
    assert bool(row["IsLinkedToOpportunity"])
    assert row["QuotationToSalesOrderMinutes"] == 1441
    assert not bool(row["IsRealQuotation"])
    assert not bool(row["IsSystemGeneratedQuotation"])
    assert row["QuotationClassification"] == "Not Applicable"
    assert not bool(row["IsWonQuotation"])
    assert not bool(row["IsRealSalesOrder"])
    assert row["SalesOrderClassification"] == "System Generated / Non-CRM Sales Order"
    assert "DeliveryID" not in fact.columns
    assert "DeliveryStatus" not in fact.columns
    assert "LeadCreatedDate" not in fact.columns


def test_fact_sales_includes_unconverted_quotations() -> None:
    orders = pd.DataFrame(
        [
            {
                "id": 200,
                "name": "S0200",
                "state": "draft",
                "date_order": pd.Timestamp("2026-01-12 09:00:00"),
                "amount_total": 500,
            }
        ]
    )

    fact = SalesFactBuilder().build(orders, pd.DataFrame())
    row = fact.iloc[0]

    assert row["SalesDocumentType"] == "Quotation"
    assert pd.isna(row["OrderID"])
    assert row["QuotationID"] == 200
    assert row["SourceQuotationID"] == 200
    assert not bool(row["IsLinkedToOpportunity"])
    assert pd.isna(row["QuotationToSalesOrderMinutes"])
    assert not bool(row["IsRealQuotation"])
    assert not bool(row["IsSystemGeneratedQuotation"])
    assert not bool(row["IsWonQuotation"])
    assert row["QuotationClassification"] == "Not Applicable"
    assert not bool(row["IsRealSalesOrder"])
    assert row["SalesOrderClassification"] == "Unclassified"


def test_sales_order_classification_requires_real_quotation() -> None:
    classified = add_sales_order_classification(
        pd.DataFrame(
            [
                {"case": "real", "SalesDocumentType": "Sales Order", "SalesSegment": "B2B", "QuotationID": 1, "IsRealQuotation": True},
                {"case": "system", "SalesDocumentType": "Sales Order", "SalesSegment": "B2B", "QuotationID": 2, "IsRealQuotation": False},
                {"case": "missing_quote", "SalesDocumentType": "Sales Order", "SalesSegment": "B2B", "QuotationID": pd.NA, "IsRealQuotation": True},
                {"case": "quotation", "SalesDocumentType": "Quotation", "SalesSegment": "B2B", "QuotationID": 3, "IsRealQuotation": True},
            ]
        )
    ).set_index("case")

    assert bool(classified.loc["real", "IsRealSalesOrder"])
    assert classified.loc["real", "SalesOrderClassification"] == "Real Sales Order"
    assert not bool(classified.loc["system", "IsRealSalesOrder"])
    assert classified.loc["system", "SalesOrderClassification"] == "System Generated / Non-CRM Sales Order"
    assert not bool(classified.loc["missing_quote", "IsRealSalesOrder"])
    assert classified.loc["missing_quote", "SalesOrderClassification"] == "System Generated / Non-CRM Sales Order"
    assert not bool(classified.loc["quotation", "IsRealSalesOrder"])
    assert classified.loc["quotation", "SalesOrderClassification"] == "Unclassified"


def test_sales_order_classification_uses_linked_quotation_reality() -> None:
    classified = add_quotation_classification(
        pd.DataFrame(
            [
                {
                    "case": "real_quote",
                    "SalesDocumentType": "Quotation",
                    "QuotationID": 10,
                    "SalesSegment": "B2B",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                },
                {
                    "case": "real_order",
                    "SalesDocumentType": "Sales Order",
                    "QuotationID": 10,
                    "SalesOrderID": 100,
                    "SalesSegment": "B2B",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                    "SalesOrderDate": pd.Timestamp("2026-01-02 08:00:00"),
                },
                {
                    "case": "system_quote",
                    "SalesDocumentType": "Quotation",
                    "QuotationID": 20,
                    "SalesSegment": "B2B",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                },
                {
                    "case": "system_order",
                    "SalesDocumentType": "Sales Order",
                    "QuotationID": 20,
                    "SalesOrderID": 200,
                    "SalesSegment": "B2B",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                    "SalesOrderDate": pd.Timestamp("2026-01-01 09:00:00"),
                },
                {
                    "case": "missing_link_order",
                    "SalesDocumentType": "Sales Order",
                    "QuotationID": pd.NA,
                    "SalesOrderID": 300,
                    "SalesSegment": "B2B",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                    "SalesOrderDate": pd.Timestamp("2026-01-02 08:00:00"),
                },
            ]
        ),
        refresh_date=pd.Timestamp("2026-01-03 08:00:00"),
    )
    classified = add_sales_order_classification(classified).set_index("case")

    assert bool(classified.loc["real_order", "IsRealSalesOrder"])
    assert classified.loc["real_order", "SalesOrderClassification"] == "Real Sales Order"
    assert not bool(classified.loc["system_order", "IsRealSalesOrder"])
    assert classified.loc["system_order", "SalesOrderClassification"] == "System Generated / Non-CRM Sales Order"
    assert not bool(classified.loc["missing_link_order", "IsRealSalesOrder"])


def test_won_quotation_flag_requires_linked_real_sales_order() -> None:
    classified = add_quotation_classification(
        pd.DataFrame(
            [
                {
                    "case": "real_quote_won",
                    "SalesDocumentType": "Quotation",
                    "QuotationID": 100,
                    "SalesSegment": "B2B",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                },
                {
                    "case": "real_sales_order",
                    "SalesDocumentType": "Sales Order",
                    "QuotationID": 100,
                    "SalesOrderID": 1000,
                    "SalesSegment": "B2B",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                    "SalesOrderDate": pd.Timestamp("2026-01-02 08:00:00"),
                },
                {
                    "case": "real_quote_open",
                    "SalesDocumentType": "Quotation",
                    "QuotationID": 200,
                    "SalesSegment": "B2C",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                },
                {
                    "case": "system_quote",
                    "SalesDocumentType": "Quotation",
                    "QuotationID": 300,
                    "SalesSegment": "B2B",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                },
                {
                    "case": "system_sales_order",
                    "SalesDocumentType": "Sales Order",
                    "QuotationID": 300,
                    "SalesOrderID": 3000,
                    "SalesSegment": "B2B",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                    "SalesOrderDate": pd.Timestamp("2026-01-01 09:00:00"),
                },
            ]
        ),
        refresh_date=pd.Timestamp("2026-01-03 08:00:00"),
    )
    classified = add_sales_order_classification(classified)
    classified = add_quotation_outcome_flags(classified).set_index("case")

    assert bool(classified.loc["real_quote_won", "IsWonQuotation"])
    assert not bool(classified.loc["real_quote_open", "IsWonQuotation"])
    assert not bool(classified.loc["system_quote", "IsWonQuotation"])


def test_won_quotation_flag_normalizes_segment_and_requires_sales_order_date() -> None:
    classified = add_quotation_classification(
        pd.DataFrame(
            [
                {
                    "case": "normalized_segment",
                    "SalesDocumentType": "Sales Order",
                    "QuotationID": 400,
                    "SalesSegment": " b2b ",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                    "SalesOrderDate": "2026-01-02 08:00:00",
                },
                {
                    "case": "blank_sales_order_date",
                    "SalesDocumentType": "Sales Order",
                    "QuotationID": 500,
                    "SalesSegment": "B2B",
                    "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                    "SalesOrderDate": " ",
                },
            ]
        ),
        refresh_date=pd.Timestamp("2026-01-03 08:00:00"),
    )
    classified = add_sales_order_classification(classified)
    classified = add_quotation_outcome_flags(classified).set_index("case")

    assert bool(classified.loc["normalized_segment", "IsRealQuotation"])
    assert not bool(classified.loc["blank_sales_order_date", "IsWonQuotation"])


def test_quotation_classification_uses_minute_threshold_and_missing_dates() -> None:
    base = pd.Timestamp("2026-01-01 08:00:00")
    classified = add_quotation_classification(
        pd.DataFrame(
            [
                {"case": "one_second", "SalesSegment": "B2B", "QuotationDate": base, "SalesOrderDate": base + pd.Timedelta(seconds=1)},
                {"case": "almost_24_hours", "SalesSegment": "B2B", "QuotationDate": base, "SalesOrderDate": base + pd.Timedelta(hours=23, minutes=59)},
                {"case": "exactly_24_hours", "SalesSegment": "B2B", "QuotationDate": base, "SalesOrderDate": base + pd.Timedelta(hours=24)},
                {"case": "more_than_24_hours", "SalesSegment": "B2B", "QuotationDate": base, "SalesOrderDate": base + pd.Timedelta(hours=24, minutes=1)},
                {"case": "open_older_than_24_hours", "SalesDocumentType": "Quotation", "SalesSegment": "B2B", "QuotationDate": base},
                {"case": "open_younger_than_24_hours", "SalesDocumentType": "Quotation", "SalesSegment": "B2B", "QuotationDate": base + pd.Timedelta(hours=23)},
                {"case": "cancelled_older_than_24_hours", "SalesDocumentType": "Quotation", "SalesSegment": "B2B", "OrderState": "cancel", "QuotationDate": base},
                {"case": "missing_quotation", "SalesSegment": "B2B", "QuotationDate": pd.NaT, "SalesOrderDate": base},
                {"case": "missing_sales_order", "SalesDocumentType": "Sales Order", "SalesSegment": "B2B", "QuotationDate": base, "SalesOrderID": 100},
                {"case": "invalid_sequence", "SalesSegment": "B2B", "QuotationDate": base, "SalesOrderDate": base - pd.Timedelta(minutes=1)},
            ]
        ),
        refresh_date=base + pd.Timedelta(hours=25),
    ).set_index("case")

    assert classified.loc["one_second", "QuotationToSalesOrderMinutes"] == 0
    assert classified.loc["one_second", "QuotationClassification"] == "System Generated Quotation"
    assert bool(classified.loc["one_second", "IsSystemGeneratedQuotation"])
    assert classified.loc["almost_24_hours", "QuotationToSalesOrderMinutes"] == 1439
    assert classified.loc["almost_24_hours", "QuotationClassification"] == "System Generated Quotation"
    assert classified.loc["exactly_24_hours", "QuotationToSalesOrderMinutes"] == 1440
    assert classified.loc["exactly_24_hours", "QuotationClassification"] == "Real Quotation"
    assert bool(classified.loc["exactly_24_hours", "IsRealQuotation"])
    assert classified.loc["more_than_24_hours", "QuotationToSalesOrderMinutes"] == 1441
    assert classified.loc["more_than_24_hours", "QuotationClassification"] == "Real Quotation"
    assert classified.loc["more_than_24_hours", "QuotationRealReason"] == "Real - Converted After 24h"
    assert classified.loc["open_older_than_24_hours", "QuotationAgeMinutes"] == 1500
    assert bool(classified.loc["open_older_than_24_hours", "IsRealQuotation"])
    assert classified.loc["open_older_than_24_hours", "QuotationRealReason"] == "Real - Still Open After 24h"
    assert not bool(classified.loc["open_younger_than_24_hours", "IsRealQuotation"])
    assert classified.loc["open_younger_than_24_hours", "QuotationRealReason"] == "Not Applicable"
    assert bool(classified.loc["cancelled_older_than_24_hours", "IsRealQuotation"])
    assert classified.loc["cancelled_older_than_24_hours", "QuotationRealReason"] == "Real - Lost/Cancelled After 24h"
    assert pd.isna(classified.loc["missing_quotation", "QuotationToSalesOrderMinutes"])
    assert classified.loc["missing_quotation", "QuotationClassification"] == "Unclassified"
    assert not bool(classified.loc["missing_quotation", "IsRealQuotation"])
    assert pd.isna(classified.loc["missing_sales_order", "QuotationToSalesOrderMinutes"])
    assert classified.loc["missing_sales_order", "QuotationClassification"] == "Unclassified"
    assert not bool(classified.loc["missing_sales_order", "IsRealQuotation"])
    assert classified.loc["invalid_sequence", "QuotationToSalesOrderMinutes"] == -1
    assert classified.loc["invalid_sequence", "QuotationClassification"] == "Invalid Date Sequence"
    assert classified.loc["invalid_sequence", "QuotationRealReason"] == "Invalid - Sales Order Before Quotation"
    assert not bool(classified.loc["invalid_sequence", "IsRealQuotation"])
    assert not bool(classified.loc["invalid_sequence", "IsSystemGeneratedQuotation"])


def test_fact_delivery_uses_move_quantities_for_partial_status() -> None:
    fact_sales = pd.DataFrame(
        [
            {
                "SalesDocumentType": "Sales Order",
                "OrderID": 100,
                "OrderNumber": "SO100",
                "QuotationID": 100,
                "SourceQuotationID": 100,
                "Customer": "Customer A",
                "OrderDate": pd.Timestamp("2026-01-10"),
                "IsRealSalesOrder": True,
            }
        ]
    )
    pickings = pd.DataFrame(
        [
            {
                "id": 900,
                "name": "WH/OUT/900",
                "sale_id_id": 100,
                "sale_id": "SO100",
                "state": "assigned",
                "scheduled_date": pd.Timestamp("2026-01-13 09:00:00"),
            }
        ]
    )
    moves = pd.DataFrame(
        [
            {
                "id": 1,
                "picking_id_id": 900,
                "product_uom_qty": 10,
                "quantity_done": 4,
                "state": "assigned",
            }
        ]
    )

    fact = DeliveryFactBuilder().build(pickings, moves, fact_sales)
    row = fact.iloc[0]

    assert row["DeliveryStatus"] == "Partially Delivered"
    assert row["SalesOrderID"] == 100
    assert row["OrderedQuantity"] == 10
    assert row["DeliveredQuantity"] == 4
    assert row["RemainingQuantity"] == 6
    assert row["OrderDate"] == pd.Timestamp("2026-01-10")
    assert row["OrderDateKey"] == 20260110
    assert "IsRealSalesOrder" in fact.columns
    assert bool(row["IsRealSalesOrder"])
    assert bool(row["IsRealDelivery"])
    assert row["DeliveryClassification"] == "Real Delivery"
    assert "LeadCreatedDate" not in fact.columns
    assert "OpportunityCreatedDate" not in fact.columns
    assert "SalesOrderDate" not in fact.columns


def test_fact_delivery_adds_not_delivered_row_when_order_has_no_picking() -> None:
    fact_sales = pd.DataFrame(
        [
            {
                "SalesDocumentType": "Sales Order",
                "OrderID": 101,
                "OrderNumber": "SO101",
                "QuotationID": 101,
                "SourceQuotationID": 101,
                "OrderDateTime": pd.Timestamp("2026-01-11 14:30:00"),
                "OrderVolume": 7,
                "IsRealSalesOrder": True,
            }
        ]
    )

    fact = DeliveryFactBuilder().build(pd.DataFrame(), pd.DataFrame(), fact_sales)
    row = fact.iloc[0]

    assert row["DeliveryFactID"] == "NO-PICK-101"
    assert row["SalesOrderID"] == 101
    assert row["DeliveryStatus"] == "Not Delivered"
    assert row["OrderDate"] == pd.Timestamp("2026-01-11")
    assert row["OrderDateKey"] == 20260111
    assert row["OrderedQuantity"] == 7
    assert row["DeliveredQuantity"] == 0
    assert not bool(row["IsRealDelivery"])
    assert row["DeliveryClassification"] == "Unclassified"


def test_delivery_classification_follows_real_sales_order_chain() -> None:
    classified = add_delivery_classification(
        pd.DataFrame(
            [
                {"case": "real", "DeliveryID": 900, "SalesOrderID": 100, "IsRealSalesOrder": True},
                {"case": "system", "DeliveryID": 901, "SalesOrderID": 101, "IsRealSalesOrder": False},
                {"case": "without_sales_order", "DeliveryID": 902, "SalesOrderID": pd.NA, "IsRealSalesOrder": False},
            ]
        )
    ).set_index("case")

    assert bool(classified.loc["real", "IsRealDelivery"])
    assert classified.loc["real", "DeliveryClassification"] == "Real Delivery"
    assert not bool(classified.loc["system", "IsRealDelivery"])
    assert classified.loc["system", "DeliveryClassification"] == "System Generated / Non-CRM Delivery"
    assert not bool(classified.loc["without_sales_order", "IsRealDelivery"])
    assert classified.loc["without_sales_order", "DeliveryClassification"] == "Unclassified"


def test_fact_delivery_marks_non_real_sales_order_delivery_as_system_generated() -> None:
    fact_sales = pd.DataFrame(
        [
            {
                "SalesDocumentType": "Sales Order",
                "OrderID": 101,
                "OrderNumber": "SO101",
                "IsRealSalesOrder": False,
            }
        ]
    )
    pickings = pd.DataFrame(
        [
            {
                "id": 901,
                "name": "WH/OUT/901",
                "sale_id_id": 101,
                "sale_id": "SO101",
                "state": "done",
            }
        ]
    )

    fact = DeliveryFactBuilder().build(pickings, pd.DataFrame(), fact_sales)
    row = fact.iloc[0]

    assert not bool(row["IsRealSalesOrder"])
    assert not bool(row["IsRealDelivery"])
    assert row["DeliveryClassification"] == "System Generated / Non-CRM Delivery"


def test_fact_delivery_uses_order_number_fallback_for_real_sales_order() -> None:
    fact_sales = pd.DataFrame(
        [
            {
                "SalesDocumentType": "Sales Order",
                "OrderID": 103,
                "OrderNumber": "SO103",
                "IsRealSalesOrder": True,
            }
        ]
    )
    pickings = pd.DataFrame(
        [
            {
                "id": 903,
                "name": "WH/OUT/903",
                "sale_id_id": pd.NA,
                "origin": "SO103",
                "state": "done",
            }
        ]
    )

    fact = DeliveryFactBuilder().build(pickings, pd.DataFrame(), fact_sales)
    row = fact.iloc[0]

    assert row["SalesOrderID"] == 103
    assert bool(row["IsRealSalesOrder"])
    assert bool(row["IsRealDelivery"])
    assert row["DeliveryClassification"] == "Real Delivery"


def test_delivery_without_sales_order_is_retained_and_not_real() -> None:
    pickings = pd.DataFrame(
        [
            {
                "id": 902,
                "name": "WH/OUT/902",
                "sale_id_id": pd.NA,
                "state": "done",
                "scheduled_date": pd.Timestamp("2026-01-13 09:00:00"),
                "date_done": pd.Timestamp("2026-01-13 11:00:00"),
            }
        ]
    )

    fact = DeliveryFactBuilder().build(pickings, pd.DataFrame(), pd.DataFrame())
    row = fact.iloc[0]

    assert row["DeliveryID"] == 902
    assert pd.isna(row["SalesOrderID"])
    assert not bool(row["IsRealDelivery"])
    assert row["DeliveryClassification"] == "Unclassified"


def test_orphan_opportunity_gets_etl_lead_history_row() -> None:
    settings = _settings()
    leads = pd.DataFrame(
        [
            {"id": 10, "name": "Real Lead", "type": "lead", "active": True, "create_date": "2026-01-01 08:00:00"},
            {
                "id": 20,
                "name": "Linked Opportunity",
                "type": "opportunity",
                "active": True,
                "lead_id_id": 10,
                "create_date": "2026-01-02 08:00:00",
                "date_open": "2026-01-02 09:00:00",
            },
            {
                "id": 30,
                "name": "Orphan Opportunity",
                "type": "opportunity",
                "active": True,
                "create_date": "2026-01-03 08:00:00",
                "date_open": "2026-01-03 09:00:00",
            },
        ]
    )

    fact_ready = CrmCleaner(settings).normalize_leads(leads, pd.DataFrame())

    opportunities = fact_ready[fact_ready["OpportunityID"].notna()]
    systematic = fact_ready[fact_ready["LeadType"].eq("Systematic")]
    orphan = opportunities[opportunities["OpportunityID"].eq(30)].iloc[0]
    linked = opportunities[opportunities["OpportunityID"].eq(20)].iloc[0]
    etl_lead = systematic.iloc[0]

    assert len(opportunities) == 2
    assert len(systematic) == 1
    assert linked["LeadID"] == "10"
    assert linked["LeadCreationSource"] == "Odoo"
    assert orphan["LeadID"] == "ETL-LEAD-30"
    assert orphan["PipelineRecordID"] == "OPP-30"
    assert orphan["LeadCreationSource"] == "Odoo"
    assert not bool(orphan["IsSystemGeneratedLead"])
    assert etl_lead["LeadID"] == "ETL-LEAD-30"
    assert etl_lead["PipelineRecordID"] == "LEAD-ETL-LEAD-30"
    assert etl_lead["LeadCreationSource"] == "ETL"
    assert bool(etl_lead["IsETLCreatedLead"])
    assert not bool(etl_lead["IsOdooCreatedLead"])
    assert etl_lead["CreatedDate"] == orphan["OpenDate"] - pd.Timedelta(minutes=1)


def test_missing_crm_sales_link_is_flow_gap_not_qa_error() -> None:
    leads = pd.DataFrame(
        [
            {
                "LeadID": pd.NA,
                "OpportunityID": 30,
                "LeadName": "Direct Opportunity",
                "StageID": 1,
                "SalespersonID": 2,
                "ExpectedRevenue": 1000,
            }
        ]
    )
    orders = pd.DataFrame(
        [
            {
                "id": 101,
                "name": "SO101",
                "opportunity_id_id": pd.NA,
            }
        ]
    )

    issues = CrmModelBuilder.build_missing_links(leads, orders)

    assert issues.empty


def test_etl_lead_history_completes_orphan_opportunity_journey() -> None:
    settings = _settings()
    leads = pd.DataFrame(
        [
            {
                "id": 30,
                "name": "Direct Opportunity",
                "type": "opportunity",
                "active": True,
                "create_date": "2026-01-03 08:00:00",
                "date_open": "2026-01-03 09:00:00",
            }
        ]
    )

    normalized = CrmCleaner(settings).normalize_leads(leads, pd.DataFrame())
    fact_pipeline = PipelineFactBuilder().build(normalized)
    pipeline = PowerBISalesPipeline(settings)
    pipeline_fact, _, _ = pipeline._attach_journey_flow_tracking(fact_pipeline, pd.DataFrame(), pd.DataFrame())
    opportunity = pipeline_fact[pipeline_fact["PipelineRecordID"].eq("OPP-30")].iloc[0]

    assert opportunity["LeadID"] == "ETL-LEAD-30"
    assert opportunity["JourneyKey"] == "ETL-LEAD-30"
    assert bool(opportunity["HasLead"])
    assert opportunity["JourneyType"] == "Lead to Opportunity Only"
    assert opportunity["FlowType"] == "Opportunity"
    assert opportunity["LeadCreatedDate"] == opportunity["OpportunityCreatedDate"] - pd.Timedelta(minutes=1)


def test_crm_spine_splits_into_clean_lead_and_opportunity_facts() -> None:
    crm_spine = pd.DataFrame(
        [
            {
                "PipelineRecordID": "LEAD-10",
                "LeadID": "10",
                "OdooLeadID": 10,
                "LeadName": "Lead A",
                "LeadType": "lead",
                "JourneyKey": "LEAD-10",
                "LeadCreatedDate": pd.Timestamp("2026-01-01 08:00:00"),
                "CreatedDateKey": 20260101,
                "Source": "Website",
                "IsOdooCreatedLead": True,
                "IsETLCreatedLead": False,
                "LeadCreationSource": "Odoo",
                "HasOpportunity": True,
                "OpportunityID": 20,
                "CustomerKey": 1,
            },
            {
                "PipelineRecordID": "OPP-20",
                "LeadID": "10",
                "OpportunityID": 20,
                "LeadName": "Opportunity A",
                "LeadType": "opportunity",
                "JourneyKey": "LEAD-10",
                "OpportunityCreatedDate": pd.Timestamp("2026-01-02 09:00:00"),
                "Stage": "New",
                "Probability": 25,
                "ExpectedRevenue": 1000,
                "HasQuotation": True,
                "QuotationDate": pd.Timestamp("2026-01-03 10:00:00"),
                "CustomerKey": 1,
            },
        ]
    )

    fact_lead = LeadFactBuilder().build(crm_spine)
    fact_opportunity = OpportunityFactBuilder().build(crm_spine)

    assert len(fact_lead) == 1
    assert fact_lead.iloc[0]["LeadSource"] == "Website"
    assert bool(fact_lead.iloc[0]["IsConvertedToOpportunity"])
    assert "IsInactiveLead" not in fact_lead.columns
    assert "QuotationID" not in fact_lead.columns
    assert "SalesOrderID" not in fact_lead.columns
    assert len(fact_opportunity) == 1
    assert fact_opportunity.iloc[0]["OpportunityID"] == 20
    assert fact_opportunity.iloc[0]["FirstQuotationDate"] == pd.Timestamp("2026-01-03 10:00:00")
    assert "IsInactiveOpportunity" not in fact_opportunity.columns
    assert "DeliveryID" not in fact_opportunity.columns


def test_crm_active_flags_cover_active_inactive_null_and_etl_rows() -> None:
    leads = pd.DataFrame(
        [
            {"id": 10, "name": "Active Lead", "type": "lead", "active": True, "create_date": "2026-01-01 08:00:00"},
            {"id": 11, "name": "Inactive Lead", "type": "lead", "active": False, "create_date": "2026-01-01 09:00:00"},
            {
                "id": 20,
                "name": "Converted Active Opportunity",
                "type": "opportunity",
                "active": True,
                "lead_id_id": 10,
                "create_date": "2026-01-02 08:00:00",
                "date_open": "2026-01-02 09:00:00",
            },
            {
                "id": 30,
                "name": "Inactive Direct Opportunity",
                "type": "opportunity",
                "active": False,
                "create_date": "2026-01-03 08:00:00",
                "date_open": "2026-01-03 09:00:00",
            },
            {
                "id": 40,
                "name": "Unknown Direct Opportunity",
                "type": "opportunity",
                "active": pd.NA,
                "create_date": "2026-01-04 08:00:00",
                "date_open": "2026-01-04 09:00:00",
            },
        ]
    )

    normalized = CrmCleaner(_settings()).normalize_leads(leads, pd.DataFrame())
    crm_spine = PipelineFactBuilder().build(normalized)
    fact_lead = LeadFactBuilder().build(crm_spine).set_index("LeadID")
    fact_opportunity = OpportunityFactBuilder().build(crm_spine).set_index("OpportunityID")

    assert bool(fact_lead.loc["10", "IsActiveLead"])
    assert not bool(fact_lead.loc["11", "IsActiveLead"])
    assert not bool(fact_lead.loc["ETL-LEAD-30", "IsActiveLead"])
    assert not bool(fact_lead.loc["ETL-LEAD-40", "IsActiveLead"])
    assert "IsInactiveLead" not in fact_lead.columns
    assert bool(fact_opportunity.loc[20, "IsActiveOpportunity"])
    assert not bool(fact_opportunity.loc[30, "IsActiveOpportunity"])
    assert not bool(fact_opportunity.loc[40, "IsActiveOpportunity"])
    assert "IsInactiveOpportunity" not in fact_opportunity.columns


def test_fact_opportunity_excludes_lead_rows_even_when_opportunity_id_is_present() -> None:
    crm_spine = pd.DataFrame(
        [
            {
                "PipelineRecordID": "LEAD-10",
                "LeadID": "10",
                "LeadType": "lead",
                "OpportunityID": 20,
            },
            {
                "PipelineRecordID": "OPP-20",
                "LeadID": "10",
                "OpportunityID": 20,
                "LeadType": "opportunity",
            },
            {
                "PipelineRecordID": "OPP-99",
                "LeadID": "99",
                "OpportunityID": 99,
                "LeadType": "lead",
            },
        ]
    )

    fact_opportunity = OpportunityFactBuilder().build(crm_spine)

    assert fact_opportunity["OpportunityID"].tolist() == [20]


def test_fact_opportunity_adds_latest_real_b2b_quotation() -> None:
    crm_spine = pd.DataFrame(
        [
            {
                "PipelineRecordID": "OPP-20",
                "LeadType": "opportunity",
                "OpportunityID": 20,
                "QuotationDate": pd.Timestamp("2026-01-01 09:00:00"),
            },
            {
                "PipelineRecordID": "OPP-21",
                "LeadType": "opportunity",
                "OpportunityID": 21,
            },
        ]
    )
    fact_sales = pd.DataFrame(
        [
            {
                "SalesDocumentType": "Quotation",
                "SalesSegment": "B2B",
                "IsRealQuotation": True,
                "OpportunityID": 20,
                "QuotationID": 200,
                "QuotationDate": pd.Timestamp("2026-01-02 12:00:00"),
                "OrderValue": 100.0,
                "OrderState": "draft",
                "OrderNumber": "S0200",
            },
            {
                "SalesDocumentType": "Quotation",
                "SalesSegment": "B2B",
                "IsRealQuotation": True,
                "OpportunityID": 20,
                "QuotationID": 201,
                "QuotationDate": pd.Timestamp("2026-01-05 12:00:00"),
                "OrderValue": 250.0,
                "OrderState": "sent",
                "OrderNumber": "S0201",
            },
        ]
    )

    fact = OpportunityFactBuilder().build(
        crm_spine,
        fact_sales,
        refresh_date=pd.Timestamp("2026-01-10 12:00:00"),
    ).set_index("OpportunityID")

    assert fact.loc[20, "FirstQuotationDate"] == pd.Timestamp("2026-01-01 09:00:00")
    assert fact.loc[20, "LastQuotationID"] == 201
    assert fact.loc[20, "LastQuotationDate"] == pd.Timestamp("2026-01-05 12:00:00")
    assert fact.loc[20, "LastQuotationValue"] == 250.0
    assert fact.loc[20, "LastQuotationStatus"] == "sent"
    assert fact.loc[20, "DaysSinceLastQuotation"] == 5
    assert pd.isna(fact.loc[21, "LastQuotationID"])
    assert pd.isna(fact.loc[21, "LastQuotationDate"])
    assert pd.isna(fact.loc[21, "DaysSinceLastQuotation"])


def test_fact_opportunity_latest_quotation_excludes_non_eligible_sales_rows() -> None:
    crm_spine = pd.DataFrame(
        [
            {"PipelineRecordID": "OPP-30", "LeadType": "opportunity", "OpportunityID": 30},
            {"PipelineRecordID": "OPP-31", "LeadType": "opportunity", "OpportunityID": 31},
            {"PipelineRecordID": "OPP-32", "LeadType": "opportunity", "OpportunityID": 32},
        ]
    )
    fact_sales = pd.DataFrame(
        [
            {
                "SalesDocumentType": "Quotation",
                "SalesSegment": "B2C",
                "IsRealQuotation": True,
                "OpportunityID": 30,
                "QuotationID": 300,
                "QuotationDate": pd.Timestamp("2026-01-05"),
            },
            {
                "SalesDocumentType": "Quotation",
                "SalesSegment": "B2B",
                "IsRealQuotation": False,
                "OpportunityID": 31,
                "QuotationID": 310,
                "QuotationDate": pd.Timestamp("2026-01-05"),
            },
            {
                "SalesDocumentType": "Quotation",
                "SalesSegment": "B2B",
                "IsRealQuotation": True,
                "OpportunityID": pd.NA,
                "QuotationID": 320,
                "QuotationDate": pd.Timestamp("2026-01-05"),
            },
            {
                "SalesDocumentType": "Quotation",
                "SalesSegment": "B2B",
                "IsRealQuotation": True,
                "OpportunityID": 32,
                "QuotationID": pd.NA,
                "QuotationDate": pd.Timestamp("2026-01-06"),
            },
        ]
    )

    fact = OpportunityFactBuilder().build(crm_spine, fact_sales, refresh_date=pd.Timestamp("2026-01-10")).set_index("OpportunityID")

    assert pd.isna(fact.loc[30, "LastQuotationID"])
    assert pd.isna(fact.loc[31, "LastQuotationID"])
    assert pd.isna(fact.loc[32, "LastQuotationID"])


def test_fact_opportunity_latest_quotation_tie_breaks_by_highest_quotation_id() -> None:
    crm_spine = pd.DataFrame(
        [
            {
                "PipelineRecordID": "OPP-40",
                "LeadType": "opportunity",
                "OpportunityID": 40,
            }
        ]
    )
    fact_sales = pd.DataFrame(
        [
            {
                "SalesDocumentType": "Quotation",
                "SalesSegment": "B2B",
                "IsRealQuotation": True,
                "OpportunityID": 40,
                "QuotationID": 400,
                "QuotationDate": pd.Timestamp("2026-01-05 08:00:00"),
                "OrderNumber": "S0402",
            },
            {
                "SalesDocumentType": "Quotation",
                "SalesSegment": "B2B",
                "IsRealQuotation": True,
                "OpportunityID": 40,
                "QuotationID": 401,
                "QuotationDate": pd.Timestamp("2026-01-05 08:00:00"),
                "OrderNumber": "S0401",
            },
        ]
    )

    fact = OpportunityFactBuilder().build(crm_spine, fact_sales, refresh_date=pd.Timestamp("2026-01-10")).iloc[0]

    assert fact["LastQuotationID"] == 401


def test_journey_flow_tracking_classifies_full_and_direct_sales() -> None:
    settings = _settings()
    pipeline = PowerBISalesPipeline(settings)
    fact_pipeline = pd.DataFrame(
        [
            {
                "PipelineRecordID": "LEAD-10",
                "LeadID": "10",
                "LeadType": "lead",
                "CreatedDate": pd.Timestamp("2026-01-01 08:00:00"),
            },
            {
                "PipelineRecordID": "OPP-20",
                "LeadID": "10",
                "OpportunityID": 20,
                "LeadType": "opportunity",
                "CreatedDate": pd.Timestamp("2026-01-02 08:00:00"),
                "OpenDate": pd.Timestamp("2026-01-02 09:00:00"),
            },
        ]
    )
    fact_sales = pd.DataFrame(
        [
            {
                "OrderNumber": "SO100",
                "SalesDocumentType": "Sales Order",
                "LeadID": "10",
                "OpportunityID": 20,
                "QuotationID": 100,
                "SourceQuotationID": 100,
                "SalesOrderID": 100,
                "JourneyKey": "LEAD-10",
                "SalesSegment": "B2B",
                "QuotationDate": pd.Timestamp("2026-01-04 09:00:00"),
                "SalesOrderDate": pd.Timestamp("2026-01-05 10:00:00"),
            },
            {
                "OrderNumber": "SO101",
                "SalesDocumentType": "Sales Order",
                "QuotationID": 101,
                "SourceQuotationID": 101,
                "SalesOrderID": 101,
                "JourneyKey": "QUOTE-101",
                "SalesSegment": "B2B",
                "QuotationDate": pd.Timestamp("2026-01-05 09:00:00"),
                "SalesOrderDate": pd.Timestamp("2026-01-06 10:00:00"),
            },
        ]
    )
    fact_delivery = pd.DataFrame(
        [
            {
                "DeliveryFactID": "PICK-900",
                "PickingID": 900,
                "DeliveryID": 900,
                "SalesOrderID": 100,
                "JourneyKey": "LEAD-10",
                "DoneDate": pd.Timestamp("2026-01-07 10:00:00"),
                "DeliveryStatus": "Fully Delivered",
                "IsRealDelivery": True,
            }
        ]
    )

    _, sales, delivery = pipeline._attach_journey_flow_tracking(fact_pipeline, fact_sales, fact_delivery)
    sales_by_order = sales.set_index("OrderNumber")

    assert sales_by_order.loc["SO100", "JourneyType"] == "Full Flow"
    assert sales_by_order.loc["SO100", "FlowType"] == "Delivered"
    assert bool(sales_by_order.loc["SO100", "HasLead"])
    assert bool(sales_by_order.loc["SO100", "HasDelivery"])
    assert sales_by_order.loc["SO101", "JourneyType"] == "Direct Quotation to Sales"
    assert sales_by_order.loc["SO101", "FlowType"] == "Sales Order"
    assert not bool(sales_by_order.loc["SO101", "HasOpportunity"])
    assert delivery.iloc[0]["DeliveryDate"] == pd.Timestamp("2026-01-07 10:00:00")


def test_data_quality_flags_missing_sales_order_quotation_linkage() -> None:
    fact_pipeline = pd.DataFrame(
        [
            {
                "PipelineRecordID": "LEAD-10",
                "LeadID": "10",
                "LeadType": "lead",
                "IsOdooCreatedLead": True,
                "IsETLCreatedLead": False,
                "JourneyKey": "LEAD-10",
                "HasLead": True,
                "FlowType": "Lead",
            }
        ]
    )
    fact_sales = pd.DataFrame(
        [
            {
                "SalesDocumentType": "Sales Order",
                "SalesOrderID": 100,
                "OrderID": 100,
                "QuotationID": pd.NA,
                "SourceQuotationID": pd.NA,
                "JourneyKey": "QUOTE-100",
                "FlowType": "Sales Order",
            }
        ]
    )
    fact_delivery = pd.DataFrame(
        columns=["SalesOrderID", "JourneyKey", "DeliveryStatus", "FlowType"]
    )

    fact_orders = pd.DataFrame({"InvoiceKey": [35818, 35818], "OrderKey": ["SO100", "SO101"]})
    checks = PowerBISalesPipeline._build_pipeline_data_quality_checks(fact_pipeline, fact_sales, fact_delivery, fact_orders=fact_orders)
    by_check = checks.set_index("CheckName")

    assert by_check.loc["Every sales order has quotation linkage", "Status"] == "FAIL"
    assert by_check.loc["Fact_Orders duplicate InvoiceKey rows", "Status"] == "INFO"
    assert by_check.loc["Fact_Orders duplicate InvoiceKey rows", "MetricValue"] == 1


def test_fact_orders_alignment_carries_quotation_classification_fields() -> None:
    fact_orders = pd.DataFrame([{"order_number": "SO100", "OrderDateTime": pd.Timestamp("2026-01-02 08:00:00")}])
    fact_sales = pd.DataFrame(
        [
            {
                "OrderNumber": "SO100",
                "SalesDocumentType": "Sales Order",
                "QuotationDate": pd.Timestamp("2026-01-01 08:00:00"),
                "SalesOrderDate": pd.Timestamp("2026-01-02 08:00:00"),
                "QuotationToSalesOrderMinutes": 1440,
                "QuotationToSalesOrderHours": 24.0,
                "IsRealQuotation": True,
                "IsSystemGeneratedQuotation": False,
                "QuotationClassification": "Real Quotation",
                "IsRealSalesOrder": True,
                "SalesOrderClassification": "Real Sales Order",
            }
        ]
    )

    aligned = PowerBISalesPipeline._align_fact_orders_with_fact_sales(fact_orders, fact_sales)
    row = aligned.iloc[0]

    assert row["QuotationToSalesOrderMinutes"] == 1440
    assert row["QuotationToSalesOrderHours"] == 24.0
    assert bool(row["IsRealQuotation"])
    assert not bool(row["IsSystemGeneratedQuotation"])
    assert row["QuotationClassification"] == "Real Quotation"
    assert bool(row["IsRealSalesOrder"])
    assert row["SalesOrderClassification"] == "Real Sales Order"


def test_data_quality_flags_non_chronological_journey_dates() -> None:
    fact_pipeline = pd.DataFrame(
        [
            {
                "PipelineRecordID": "OPP-20",
                "LeadID": "10",
                "OpportunityID": 20,
                "LeadType": "opportunity",
                "JourneyKey": "LEAD-10",
                "HasLead": True,
                "FlowType": "Opportunity",
                "LeadCreatedDate": pd.Timestamp("2026-01-03 10:00:00"),
                "OpportunityCreatedDate": pd.Timestamp("2026-01-02 10:00:00"),
            }
        ]
    )
    fact_sales = pd.DataFrame(
        [
            {
                "SalesDocumentType": "Quotation",
                "QuotationID": 100,
                "SourceQuotationID": 100,
                "JourneyKey": "LEAD-10",
                "FlowType": "Quotation",
                "QuotationDate": pd.Timestamp("2026-01-04 10:00:00"),
            }
        ]
    )
    fact_delivery = pd.DataFrame(columns=["SalesOrderID", "JourneyKey", "DeliveryStatus", "FlowType"])

    checks = PowerBISalesPipeline._build_pipeline_data_quality_checks(fact_pipeline, fact_sales, fact_delivery)
    by_check = checks.set_index("CheckName")

    assert by_check.loc["Opportunity lead history predates opportunity", "Status"] == "FAIL"
    assert by_check.loc["Journey timeline dates are chronological", "Status"] == "FAIL"


def test_fact_orders_order_key_is_unique_while_invoice_key_can_repeat() -> None:
    settings = _settings()
    pipeline = PowerBISalesPipeline(settings)
    fact_orders = pd.DataFrame(
        [
            {"order_number": "SO100", "DateKey": 20260101, "InvoiceKey": 35818},
            {"order_number": "SO101", "DateKey": 20260102, "InvoiceKey": 35818},
        ]
    )
    dim_invoice = pd.DataFrame(
        [
            {"InvoiceKey": 35818, "order_number": "SO100"},
            {"InvoiceKey": 35819, "order_number": "SO101"},
        ]
    )
    dim_date = pd.DataFrame({"DateKey": [20260101, 20260102]})
    fact_sales = pd.DataFrame({"DateKey": [20260101, 20260102]})

    fact_orders = pipeline._ensure_fact_orders_order_key(fact_orders)
    pipeline._validate_model_key_integrity(
        {
            "Fact_Orders": fact_orders,
            "Dim_Invoice": dim_invoice,
            "Dim_Date": dim_date,
            "Fact_Sales": fact_sales,
        },
        refresh_date=pd.Timestamp("2026-01-02").date(),
    )

    assert fact_orders["OrderKey"].tolist() == ["SO100", "SO101"]
    assert fact_orders["OrderKey"].is_unique


def test_dim_date_is_built_from_sales_order_date_coverage_and_refresh_date() -> None:
    settings = _settings()
    pipeline = PowerBISalesPipeline(settings)
    dim_date = pipeline._extend_dim_date_for_sales_and_delivery(
        {
            "Fact_Orders": pd.DataFrame({"OrderDateTime": pd.to_datetime(["2021-01-30", "2026-05-14"])}),
            "Fact_Sales": pd.DataFrame({"OrderDateTime": pd.to_datetime(["2026-05-14"])}),
        },
        refresh_date=pd.Timestamp("2026-05-20").date(),
    )

    assert dim_date["Date"].min() == pd.Timestamp("2021-01-30")
    assert dim_date["Date"].max() == pd.Timestamp("2026-05-20")
    assert 20210130 in set(dim_date["DateKey"])
    assert 20260514 in set(dim_date["DateKey"])
    assert 20260520 in set(dim_date["DateKey"])
