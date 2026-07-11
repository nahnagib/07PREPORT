"""Canned Odoo XML-RPC-shaped mock data, keyed by model name, for MockOdooClient.

Field lists and which fields are many2one were read directly from the vendored repository
source (sales_pipeline/odoo/*.py, sales_pipeline/inventory.py) - not guessed - so the mock
exercises the exact same ``available_fields()`` / ``flatten_many2one_columns()`` code paths the
real pipeline runs against production Odoo. Many2one values use Odoo's own wire format:
``[id, "Display Name"]``; a missing/false relation is Odoo's ``False`` (not None, not empty list).

Data is a small, hand-built scenario (2 companies, 2 sales teams, 3 customers, 5 products, ~10
sale.report rows) sized to exercise multiple business-rule branches at once:
  - quotation age both under and over the 24h REAL_QUOTATION_THRESHOLD_HOURS
  - a won opportunity (stage.is_won / probability=100) and a lost one (active=False)
  - a lead never converted to an opportunity (stays in Fact_Lead, not Fact_Opportunity)
  - an opportunity with no matching real Odoo crm.lead row (exercises the pipeline's synthetic
    ETL-lead-history construction: LeadID = "ETL-LEAD-{OpportunityID}")
  - a delivery (stock.picking/stock.move) linked back to a confirmed sale.order

This is NOT a claim that these numbers reconcile against real production Odoo data - there is no
live Odoo access in this session. See ../README.md's "Validation & reconciliation" section for
what this mock run does and does not prove.
"""
from __future__ import annotations

# --- shared reference values --------------------------------------------------------------
COMPANY_MAJAAL = [1, "Majaal"]
COMPANY_TIKA = [2, "Tika"]

PARTNER_B2B_1 = [101, "Al Waha Trading Co."]
PARTNER_B2B_2 = [103, "Benghazi Retail Group"]
PARTNER_B2C_1 = [102, "Ahmed Khalil"]

USER_1 = [201, "Salma Al-Fitouri"]
USER_2 = [202, "Omar Bin Younis"]

TEAM_B2B = [301, "Tripoli B2B Team"]
TEAM_B2C = [302, "Benghazi Retail Team"]

STAGE_NEW = [401, "New"]
STAGE_QUALIFIED = [402, "Qualified"]
STAGE_WON = [403, "Won"]

LOST_REASON_PRICE = [501, "Price too high"]
LOST_REASON_COMPETITOR = [502, "Chose competitor"]

PRODUCT_1 = [601, "TIKA Olive Oil 1L"]
PRODUCT_2 = [602, "TIKA Tomato Paste 400g"]
PRODUCT_3 = [603, "Majaal Detergent 5L"]
PRODUCT_ODOO_ONLY = [604, "New SKU Not Yet In Master List"]

LOCATION_TRIPOLI_WH = [701, "Tripoli/WH/Stock"]
LOCATION_BENGHAZI_WH = [702, "Benghazi/WH/Stock"]


def _field_types(names, many2one, many2many=None):
    many2many = many2many or set()
    out = {}
    for n in names:
        if n in many2one:
            out[n] = {"type": "many2one"}
        elif n in many2many:
            out[n] = {"type": "many2many"}
        else:
            out[n] = {"type": "char"}
    return out


SALE_REPORT_RECORDS = [
    {
        "id": i + 1,
        "date": date,
        "name": order_name,
        "partner_id": partner,
        "product_id": product,
        "user_id": user,
        "team_id": team,
        "company_id": company,
        "price_subtotal": subtotal,
        "price_total": round(subtotal * 1.1, 2),
        "qty_invoiced": qty,
        "state": state,
        "invoice_status": invoice_status,
    }
    for i, (date, order_name, partner, product, user, team, company, subtotal, qty, state, invoice_status) in enumerate([
        ("2026-06-01 09:15:00", "S00101", PARTNER_B2B_1, PRODUCT_1, USER_1, TEAM_B2B, COMPANY_TIKA, 450.00, 30, "sale", "invoiced"),
        ("2026-06-02 10:00:00", "S00101", PARTNER_B2B_1, PRODUCT_2, USER_1, TEAM_B2B, COMPANY_TIKA, 220.00, 55, "sale", "invoiced"),
        ("2026-06-05 14:30:00", "S00102", PARTNER_B2B_2, PRODUCT_1, USER_2, TEAM_B2B, COMPANY_TIKA, 600.00, 40, "sale", "invoiced"),
        ("2026-06-10 11:00:00", "S00103", PARTNER_B2C_1, PRODUCT_3, USER_2, TEAM_B2C, COMPANY_MAJAAL, 150.00, 10, "sale", "invoiced"),
        ("2026-06-12 16:45:00", "S00104", PARTNER_B2B_1, PRODUCT_ODOO_ONLY, USER_1, TEAM_B2B, COMPANY_TIKA, 320.00, 20, "sale", "to invoice"),
        ("2026-06-15 08:30:00", "S00105", PARTNER_B2B_2, PRODUCT_2, USER_2, TEAM_B2B, COMPANY_TIKA, 275.00, 60, "sale", "invoiced"),
        ("2026-06-18 13:00:00", "S00106", PARTNER_B2C_1, PRODUCT_3, USER_2, TEAM_B2C, COMPANY_MAJAAL, 90.00, 6, "sale", "invoiced"),
        ("2026-06-20 09:45:00", "S00107", PARTNER_B2B_1, PRODUCT_1, USER_1, TEAM_B2B, COMPANY_TIKA, 510.00, 34, "sale", "to invoice"),
        ("2026-06-22 15:15:00", "S00108", PARTNER_B2B_2, PRODUCT_2, USER_2, TEAM_B2B, COMPANY_TIKA, 198.00, 44, "sale", "invoiced"),
        ("2026-06-25 10:30:00", "S00109", PARTNER_B2C_1, PRODUCT_3, USER_2, TEAM_B2C, COMPANY_MAJAAL, 135.00, 9, "sale", "invoiced"),
    ])
]

SALE_ORDER_RECORDS = [
    {"id": 1, "name": "S00101", "opportunity_id": [9001, "Al Waha - Bulk Olive Oil Deal"], "partner_id": PARTNER_B2B_1,
     "user_id": USER_1, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "date_order": "2026-05-28 09:00:00", "create_date": "2026-05-28 09:00:00", "write_date": "2026-06-01 09:15:00",
     "amount_untaxed": 670.00, "amount_total": 737.00, "state": "sale", "invoice_status": "invoiced",
     "delivery_status": "full", "validity_date": "2026-06-15", "origin": False, "client_order_ref": False},
    {"id": 2, "name": "S00102", "opportunity_id": [9002, "Benghazi Retail - New Account"], "partner_id": PARTNER_B2B_2,
     "user_id": USER_2, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "date_order": "2026-06-01 08:00:00", "create_date": "2026-06-01 08:00:00", "write_date": "2026-06-05 14:30:00",
     "amount_untaxed": 600.00, "amount_total": 660.00, "state": "sale", "invoice_status": "invoiced",
     "delivery_status": "full", "validity_date": "2026-06-20", "origin": False, "client_order_ref": False},
    {"id": 3, "name": "S00103", "opportunity_id": False, "partner_id": PARTNER_B2C_1,
     "user_id": USER_2, "team_id": TEAM_B2C, "company_id": COMPANY_MAJAAL,
     "date_order": "2026-06-10 11:00:00", "create_date": "2026-06-10 11:00:00", "write_date": "2026-06-10 11:00:00",
     "amount_untaxed": 150.00, "amount_total": 165.00, "state": "sale", "invoice_status": "invoiced",
     "delivery_status": "full", "validity_date": False, "origin": False, "client_order_ref": False},
    {"id": 4, "name": "S00104", "opportunity_id": [9003, "Al Waha - New SKU Trial"], "partner_id": PARTNER_B2B_1,
     "user_id": USER_1, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "date_order": "2026-06-12 16:45:00", "create_date": "2026-06-12 16:45:00", "write_date": "2026-06-12 16:45:00",
     "amount_untaxed": 320.00, "amount_total": 352.00, "state": "sent", "invoice_status": "to invoice",
     "delivery_status": "pending", "validity_date": "2026-07-12", "origin": False, "client_order_ref": False},
    {"id": 5, "name": "S00105", "opportunity_id": [9004, "Benghazi Retail - Repeat Order"], "partner_id": PARTNER_B2B_2,
     "user_id": USER_2, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "date_order": "2026-06-10 08:00:00", "create_date": "2026-06-10 08:00:00", "write_date": "2026-06-15 08:30:00",
     "amount_untaxed": 275.00, "amount_total": 302.50, "state": "sale", "invoice_status": "invoiced",
     "delivery_status": "full", "validity_date": "2026-06-25", "origin": False, "client_order_ref": False},
    {"id": 6, "name": "S00106", "opportunity_id": False, "partner_id": PARTNER_B2C_1,
     "user_id": USER_2, "team_id": TEAM_B2C, "company_id": COMPANY_MAJAAL,
     "date_order": "2026-06-18 13:00:00", "create_date": "2026-06-18 13:00:00", "write_date": "2026-06-18 13:00:00",
     "amount_untaxed": 90.00, "amount_total": 99.00, "state": "sale", "invoice_status": "invoiced",
     "delivery_status": "full", "validity_date": False, "origin": False, "client_order_ref": False},
    {"id": 7, "name": "S00107", "opportunity_id": [9005, "Al Waha - Quick Reorder"], "partner_id": PARTNER_B2B_1,
     "user_id": USER_1, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "date_order": "2026-06-20 09:00:00", "create_date": "2026-06-20 09:00:00", "write_date": "2026-06-20 09:45:00",
     "amount_untaxed": 510.00, "amount_total": 561.00, "state": "sent", "invoice_status": "to invoice",
     "delivery_status": "pending", "validity_date": "2026-07-20", "origin": False, "client_order_ref": False},
    {"id": 8, "name": "S00108", "opportunity_id": [9006, "Benghazi Retail - Q3 Stock-Up"], "partner_id": PARTNER_B2B_2,
     "user_id": USER_2, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "date_order": "2026-06-16 10:00:00", "create_date": "2026-06-16 10:00:00", "write_date": "2026-06-22 15:15:00",
     "amount_untaxed": 198.00, "amount_total": 217.80, "state": "sale", "invoice_status": "invoiced",
     "delivery_status": "full", "validity_date": "2026-06-30", "origin": False, "client_order_ref": False},
    {"id": 9, "name": "S00109", "opportunity_id": [9007, "Ahmed Khalil - Repeat Buyer"], "partner_id": PARTNER_B2C_1,
     "user_id": USER_2, "team_id": TEAM_B2C, "company_id": COMPANY_MAJAAL,
     "date_order": "2026-06-25 09:50:00", "create_date": "2026-06-25 09:50:00", "write_date": "2026-06-25 10:30:00",
     "amount_untaxed": 135.00, "amount_total": 148.50, "state": "sale", "invoice_status": "invoiced",
     "delivery_status": "full", "validity_date": "2026-07-05", "origin": False, "client_order_ref": False},
]

CRM_LEAD_RECORDS = [
    {"id": 9001, "name": "Al Waha - Bulk Olive Oil Deal", "type": "opportunity", "active": True,
     "create_date": "2026-05-20 09:00:00", "write_date": "2026-06-01 09:15:00", "date_open": "2026-05-20 09:00:00",
     "date_closed": "2026-06-01 09:15:00", "date_deadline": "2026-06-10", "expected_revenue": 670.00,
     "prorated_revenue": 670.00, "probability": 100.0, "automated_probability": 100.0, "lead_id": False,
     "parent_id": False, "stage_id": STAGE_WON, "user_id": USER_1, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "partner_id": PARTNER_B2B_1, "contact_name": "Al Waha Trading Co.", "email_from": "purchasing@alwaha.example",
     "phone": "+218-91-000-0001", "mobile": False, "city": "Tripoli", "country_id": [231, "Libya"],
     "source_id": False, "medium_id": False, "campaign_id": False, "tag_ids": [],
     "lost_reason_id": False, "won_status": "won", "day_open": 0.5, "day_close": 12.0,
     "activity_date_deadline": False, "activity_summary": False, "activity_state": False,
     "activity_type_id": False, "activity_user_id": False, "recurring_revenue": 0},
    {"id": 9002, "name": "Benghazi Retail - New Account", "type": "opportunity", "active": True,
     "create_date": "2026-05-25 08:00:00", "write_date": "2026-06-05 14:30:00", "date_open": "2026-05-25 08:00:00",
     "date_closed": "2026-06-05 14:30:00", "date_deadline": "2026-06-15", "expected_revenue": 600.00,
     "prorated_revenue": 600.00, "probability": 100.0, "automated_probability": 100.0, "lead_id": False,
     "parent_id": False, "stage_id": STAGE_WON, "user_id": USER_2, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "partner_id": PARTNER_B2B_2, "contact_name": "Benghazi Retail Group", "email_from": "orders@bnretail.example",
     "phone": "+218-92-000-0002", "mobile": False, "city": "Benghazi", "country_id": [231, "Libya"],
     "source_id": False, "medium_id": False, "campaign_id": False, "tag_ids": [],
     "lost_reason_id": False, "won_status": "won", "day_open": 0.3, "day_close": 11.5,
     "activity_date_deadline": False, "activity_summary": False, "activity_state": False,
     "activity_type_id": False, "activity_user_id": False, "recurring_revenue": 0},
    {"id": 9003, "name": "Al Waha - New SKU Trial", "type": "opportunity", "active": True,
     "create_date": "2026-06-12 16:00:00", "write_date": "2026-06-12 16:45:00", "date_open": "2026-06-12 16:00:00",
     "date_closed": False, "date_deadline": "2026-07-12", "expected_revenue": 320.00,
     "prorated_revenue": 224.00, "probability": 70.0, "automated_probability": 65.0, "lead_id": False,
     "parent_id": False, "stage_id": STAGE_QUALIFIED, "user_id": USER_1, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "partner_id": PARTNER_B2B_1, "contact_name": "Al Waha Trading Co.", "email_from": "purchasing@alwaha.example",
     "phone": "+218-91-000-0001", "mobile": False, "city": "Tripoli", "country_id": [231, "Libya"],
     "source_id": False, "medium_id": False, "campaign_id": False, "tag_ids": [],
     "lost_reason_id": False, "won_status": False, "day_open": 0.0, "day_close": False,
     "activity_date_deadline": False, "activity_summary": False, "activity_state": False,
     "activity_type_id": False, "activity_user_id": False, "recurring_revenue": 0},
    {"id": 9004, "name": "Benghazi Retail - Repeat Order", "type": "opportunity", "active": True,
     "create_date": "2026-06-10 07:30:00", "write_date": "2026-06-15 08:30:00", "date_open": "2026-06-10 07:30:00",
     "date_closed": "2026-06-15 08:30:00", "date_deadline": "2026-06-25", "expected_revenue": 275.00,
     "prorated_revenue": 275.00, "probability": 100.0, "automated_probability": 100.0, "lead_id": False,
     "parent_id": False, "stage_id": STAGE_WON, "user_id": USER_2, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "partner_id": PARTNER_B2B_2, "contact_name": "Benghazi Retail Group", "email_from": "orders@bnretail.example",
     "phone": "+218-92-000-0002", "mobile": False, "city": "Benghazi", "country_id": [231, "Libya"],
     "source_id": False, "medium_id": False, "campaign_id": False, "tag_ids": [],
     "lost_reason_id": False, "won_status": "won", "day_open": 0.2, "day_close": 5.0,
     "activity_date_deadline": False, "activity_summary": False, "activity_state": False,
     "activity_type_id": False, "activity_user_id": False, "recurring_revenue": 0},
    {"id": 9005, "name": "Al Waha - Quick Reorder", "type": "opportunity", "active": True,
     "create_date": "2026-06-20 08:45:00", "write_date": "2026-06-20 09:45:00", "date_open": "2026-06-20 08:45:00",
     "date_closed": False, "date_deadline": "2026-07-20", "expected_revenue": 510.00,
     "prorated_revenue": 357.00, "probability": 70.0, "automated_probability": 60.0, "lead_id": False,
     "parent_id": False, "stage_id": STAGE_QUALIFIED, "user_id": USER_1, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "partner_id": PARTNER_B2B_1, "contact_name": "Al Waha Trading Co.", "email_from": "purchasing@alwaha.example",
     "phone": "+218-91-000-0001", "mobile": False, "city": "Tripoli", "country_id": [231, "Libya"],
     "source_id": False, "medium_id": False, "campaign_id": False, "tag_ids": [],
     "lost_reason_id": False, "won_status": False, "day_open": 0.0, "day_close": False,
     "activity_date_deadline": False, "activity_summary": False, "activity_state": False,
     "activity_type_id": False, "activity_user_id": False, "recurring_revenue": 0},
    {"id": 9006, "name": "Benghazi Retail - Q3 Stock-Up", "type": "opportunity", "active": True,
     "create_date": "2026-06-15 09:00:00", "write_date": "2026-06-22 15:15:00", "date_open": "2026-06-15 09:00:00",
     "date_closed": "2026-06-22 15:15:00", "date_deadline": "2026-06-30", "expected_revenue": 198.00,
     "prorated_revenue": 198.00, "probability": 100.0, "automated_probability": 100.0, "lead_id": False,
     "parent_id": False, "stage_id": STAGE_WON, "user_id": USER_2, "team_id": TEAM_B2B, "company_id": COMPANY_TIKA,
     "partner_id": PARTNER_B2B_2, "contact_name": "Benghazi Retail Group", "email_from": "orders@bnretail.example",
     "phone": "+218-92-000-0002", "mobile": False, "city": "Benghazi", "country_id": [231, "Libya"],
     "source_id": False, "medium_id": False, "campaign_id": False, "tag_ids": [],
     "lost_reason_id": False, "won_status": "won", "day_open": 0.3, "day_close": 7.3,
     "activity_date_deadline": False, "activity_summary": False, "activity_state": False,
     "activity_type_id": False, "activity_user_id": False, "recurring_revenue": 0},
    {"id": 9008, "name": "Tripoli Wholesale - Bulk Detergent Bid", "type": "opportunity", "active": False,
     "create_date": "2026-05-15 10:00:00", "write_date": "2026-05-30 12:00:00", "date_open": "2026-05-15 10:00:00",
     "date_closed": "2026-05-30 12:00:00", "date_deadline": "2026-06-01", "expected_revenue": 900.00,
     "prorated_revenue": 0.0, "probability": 0.0, "automated_probability": 5.0, "lead_id": False,
     "parent_id": False, "stage_id": STAGE_QUALIFIED, "user_id": USER_2, "team_id": TEAM_B2C, "company_id": COMPANY_MAJAAL,
     "partner_id": False, "contact_name": "Tripoli Wholesale Traders", "email_from": "info@tripoliwholesale.example",
     "phone": False, "mobile": False, "city": "Tripoli", "country_id": [231, "Libya"],
     "source_id": False, "medium_id": False, "campaign_id": False, "tag_ids": [],
     "lost_reason_id": LOST_REASON_PRICE, "won_status": "lost", "day_open": 0.1, "day_close": 15.0,
     "activity_date_deadline": False, "activity_summary": False, "activity_state": False,
     "activity_type_id": False, "activity_user_id": False, "recurring_revenue": 0},
    {"id": 9101, "name": "Sabratha Mini-Market - Cold Inbound", "type": "lead", "active": True,
     "create_date": "2026-06-28 09:00:00", "write_date": "2026-06-28 09:00:00", "date_open": False,
     "date_closed": False, "date_deadline": False, "expected_revenue": 0.0,
     "prorated_revenue": 0.0, "probability": 10.0, "automated_probability": 10.0, "lead_id": False,
     "parent_id": False, "stage_id": STAGE_NEW, "user_id": USER_2, "team_id": TEAM_B2C, "company_id": COMPANY_MAJAAL,
     "partner_id": False, "contact_name": "Sabratha Mini-Market", "email_from": "hello@sabrathamm.example",
     "phone": False, "mobile": "+218-93-000-0009", "city": "Sabratha", "country_id": [231, "Libya"],
     "source_id": False, "medium_id": False, "campaign_id": False, "tag_ids": [],
     "lost_reason_id": False, "won_status": False, "day_open": False, "day_close": False,
     "activity_date_deadline": False, "activity_summary": False, "activity_state": False,
     "activity_type_id": False, "activity_user_id": False, "recurring_revenue": 0},
]

CRM_STAGE_RECORDS = [
    {"id": 401, "name": "New", "sequence": 1, "is_won": False, "fold": False, "team_id": TEAM_B2B},
    {"id": 402, "name": "Qualified", "sequence": 2, "is_won": False, "fold": False, "team_id": TEAM_B2B},
    {"id": 403, "name": "Won", "sequence": 3, "is_won": True, "fold": True, "team_id": TEAM_B2B},
]

CRM_LOST_REASON_RECORDS = [
    {"id": 501, "name": "Price too high", "active": True},
    {"id": 502, "name": "Chose competitor", "active": True},
]

STOCK_PICKING_RECORDS = [
    {"id": 801, "name": "WH/OUT/00101", "sale_id": [1, "S00101"], "origin": "S00101", "partner_id": PARTNER_B2B_1,
     "user_id": USER_1, "company_id": COMPANY_TIKA, "picking_type_code": "outgoing",
     "scheduled_date": "2026-06-02 09:00:00", "date_done": "2026-06-02 10:30:00", "state": "done",
     "create_date": "2026-05-28 09:05:00", "write_date": "2026-06-02 10:30:00"},
    {"id": 802, "name": "WH/OUT/00102", "sale_id": [2, "S00102"], "origin": "S00102", "partner_id": PARTNER_B2B_2,
     "user_id": USER_2, "company_id": COMPANY_TIKA, "picking_type_code": "outgoing",
     "scheduled_date": "2026-06-06 09:00:00", "date_done": "2026-06-06 11:15:00", "state": "done",
     "create_date": "2026-06-01 08:05:00", "write_date": "2026-06-06 11:15:00"},
    {"id": 803, "name": "WH/OUT/00105", "sale_id": [5, "S00105"], "origin": "S00105", "partner_id": PARTNER_B2B_2,
     "user_id": USER_2, "company_id": COMPANY_TIKA, "picking_type_code": "outgoing",
     "scheduled_date": "2026-06-16 09:00:00", "date_done": False, "state": "assigned",
     "create_date": "2026-06-10 08:05:00", "write_date": "2026-06-15 08:35:00"},
]

STOCK_MOVE_RECORDS = [
    {"id": 901, "picking_id": [801, "WH/OUT/00101"], "sale_line_id": [1001, "S00101 line"], "origin": "S00101",
     "product_uom_qty": 30, "product_qty": 30, "quantity_done": 30, "quantity": 30, "state": "done",
     "date": "2026-06-02 10:30:00", "create_date": "2026-05-28 09:05:00", "write_date": "2026-06-02 10:30:00"},
    {"id": 902, "picking_id": [802, "WH/OUT/00102"], "sale_line_id": [1002, "S00102 line"], "origin": "S00102",
     "product_uom_qty": 40, "product_qty": 40, "quantity_done": 40, "quantity": 40, "state": "done",
     "date": "2026-06-06 11:15:00", "create_date": "2026-06-01 08:05:00", "write_date": "2026-06-06 11:15:00"},
    {"id": 903, "picking_id": [803, "WH/OUT/00105"], "sale_line_id": [1005, "S00105 line"], "origin": "S00105",
     "product_uom_qty": 60, "product_qty": 60, "quantity_done": 0, "quantity": 0, "state": "assigned",
     "date": "2026-06-16 09:00:00", "create_date": "2026-06-10 08:05:00", "write_date": "2026-06-15 08:35:00"},
]

PRODUCT_COST_RECORDS = [
    {"id": 601, "product_tmpl_id": [6001, "TIKA Olive Oil 1L"], "name": "TIKA Olive Oil 1L",
     "display_name": "TIKA Olive Oil 1L", "default_code": "XT-TA-01-001", "company_id": COMPANY_TIKA,
     "standard_price": 9.50, "active": True},
    {"id": 602, "product_tmpl_id": [6002, "TIKA Tomato Paste 400g"], "name": "TIKA Tomato Paste 400g",
     "display_name": "TIKA Tomato Paste 400g", "default_code": "XT-TA-02-004", "company_id": COMPANY_TIKA,
     "standard_price": 2.10, "active": True},
    {"id": 603, "product_tmpl_id": [6003, "Majaal Detergent 5L"], "name": "Majaal Detergent 5L",
     "display_name": "Majaal Detergent 5L", "default_code": "MJ-DET-005", "company_id": COMPANY_MAJAAL,
     "standard_price": 6.75, "active": True},
    {"id": 604, "product_tmpl_id": [6004, "New SKU Not Yet In Master List"], "name": "New SKU Not Yet In Master List",
     "display_name": "New SKU Not Yet In Master List", "default_code": False, "company_id": COMPANY_TIKA,
     "standard_price": 4.20, "active": True},
]

STOCK_QUANT_RECORDS = [
    {"id": 1101, "product_id": PRODUCT_1, "company_id": COMPANY_TIKA, "location_id": LOCATION_TRIPOLI_WH,
     "quantity": 480, "reserved_quantity": 30, "value": 4560.00, "inventory_value": 4560.00},
    {"id": 1102, "product_id": PRODUCT_2, "company_id": COMPANY_TIKA, "location_id": LOCATION_TRIPOLI_WH,
     "quantity": 920, "reserved_quantity": 55, "value": 1932.00, "inventory_value": 1932.00},
    {"id": 1103, "product_id": PRODUCT_3, "company_id": COMPANY_MAJAAL, "location_id": LOCATION_BENGHAZI_WH,
     "quantity": 210, "reserved_quantity": 10, "value": 1417.50, "inventory_value": 1417.50},
    {"id": 1104, "product_id": PRODUCT_ODOO_ONLY, "company_id": COMPANY_TIKA, "location_id": LOCATION_TRIPOLI_WH,
     "quantity": 60, "reserved_quantity": 20, "value": 252.00, "inventory_value": 252.00},
]

STOCK_LOCATION_RECORDS = [
    {"id": 701, "name": "Stock", "complete_name": "Tripoli/WH/Stock", "usage": "internal",
     "scrap_location": False, "active": True, "warehouse_id": [1, "Tripoli WH"]},
    {"id": 702, "name": "Stock", "complete_name": "Benghazi/WH/Stock", "usage": "internal",
     "scrap_location": False, "active": True, "warehouse_id": [2, "Benghazi WH"]},
]

RES_COMPANY_RECORDS = [
    {"id": 1, "name": "Majaal"},
    {"id": 2, "name": "Tika"},
]

_MANY2ONE = {
    "lead_id", "parent_id", "stage_id", "user_id", "team_id", "company_id", "partner_id",
    "country_id", "source_id", "medium_id", "campaign_id", "lost_reason_id", "activity_type_id",
    "activity_user_id", "opportunity_id", "sale_id", "picking_id", "sale_line_id",
    "product_tmpl_id", "product_id", "location_id", "warehouse_id",
}
_MANY2MANY = {"tag_ids"}

MOCK_ODOO_DATA = {
    "sale.report": {
        "records": SALE_REPORT_RECORDS,
        "field_types": _field_types(
            ["date", "name", "partner_id", "product_id", "user_id", "team_id", "company_id",
             "price_subtotal", "price_total", "qty_invoiced", "state", "invoice_status"],
            _MANY2ONE,
        ),
    },
    "crm.lead": {
        "records": CRM_LEAD_RECORDS,
        "field_types": _field_types(
            ["id", "name", "type", "active", "create_date", "write_date", "date_open", "date_closed",
             "date_deadline", "expected_revenue", "prorated_revenue", "probability", "automated_probability",
             "lead_id", "parent_id", "stage_id", "user_id", "team_id", "company_id", "partner_id",
             "contact_name", "email_from", "phone", "mobile", "city", "country_id", "source_id", "medium_id",
             "campaign_id", "tag_ids", "lost_reason_id", "won_status", "day_open", "day_close",
             "activity_date_deadline", "activity_summary", "activity_state", "activity_type_id",
             "activity_user_id", "recurring_revenue"],
            _MANY2ONE, _MANY2MANY,
        ),
    },
    "crm.stage": {
        "records": CRM_STAGE_RECORDS,
        "field_types": _field_types(["id", "name", "sequence", "is_won", "fold", "team_id"], _MANY2ONE),
    },
    "crm.lost.reason": {
        "records": CRM_LOST_REASON_RECORDS,
        "field_types": _field_types(["id", "name", "active"], _MANY2ONE),
    },
    "sale.order": {
        "records": SALE_ORDER_RECORDS,
        "field_types": _field_types(
            ["id", "name", "opportunity_id", "partner_id", "user_id", "team_id", "company_id",
             "date_order", "create_date", "write_date", "amount_untaxed", "amount_total", "state",
             "invoice_status", "delivery_status", "validity_date", "origin", "client_order_ref"],
            _MANY2ONE,
        ),
    },
    "stock.picking": {
        "records": STOCK_PICKING_RECORDS,
        "field_types": _field_types(
            ["id", "name", "sale_id", "origin", "partner_id", "user_id", "company_id",
             "picking_type_code", "scheduled_date", "date_done", "state", "create_date", "write_date"],
            _MANY2ONE,
        ),
    },
    "stock.move": {
        "records": STOCK_MOVE_RECORDS,
        "field_types": _field_types(
            ["id", "picking_id", "sale_line_id", "origin", "product_uom_qty", "product_qty",
             "quantity_done", "quantity", "state", "date", "create_date", "write_date"],
            _MANY2ONE,
        ),
    },
    "product.product": {
        "records": PRODUCT_COST_RECORDS,
        "field_types": _field_types(
            ["id", "product_tmpl_id", "name", "display_name", "default_code", "company_id",
             "standard_price", "active"],
            _MANY2ONE,
        ),
    },
    "stock.quant": {
        "records": STOCK_QUANT_RECORDS,
        "field_types": _field_types(
            ["id", "product_id", "company_id", "location_id", "quantity", "reserved_quantity",
             "value", "inventory_value"],
            _MANY2ONE,
        ),
    },
    "stock.location": {
        "records": STOCK_LOCATION_RECORDS,
        "field_types": _field_types(
            ["id", "name", "complete_name", "usage", "scrap_location", "active", "warehouse_id"],
            _MANY2ONE,
        ),
    },
    "res.company": {
        "records": RES_COMPANY_RECORDS,
        "field_types": _field_types(["id", "name"], _MANY2ONE),
    },
}
