"""OrderValue must be in the company currency (LYD), converted like Odoo's sale.report: amount_total / currency_rate."""
import pandas as pd

from sales_pipeline.facts.fact_sales import SalesFactBuilder


def test_order_value_is_converted_to_company_currency():
    # S41505 (USD pricelist): amount_total 685,545 USD at currency_rate 0.1 -> 6,855,450 LYD, as Odoo's sale.report shows.
    rows = [("S41505", "draft", 685545.0, 0.1), ("LYD", "sale", 1000.0, 1.0), ("NORATE", "sale", 500.0, None), ("ZERO", "sale", 250.0, 0.0)]
    orders = pd.DataFrame([
        {"id": i + 1, "name": n, "state": s, "amount_total": a, "currency_rate": r,
         "date_order": pd.Timestamp("2026-10-10"), "create_date": pd.Timestamp("2026-10-10")}
        for i, (n, s, a, r) in enumerate(rows)
    ])
    out = SalesFactBuilder().build(orders, pd.DataFrame(columns=["OpportunityID", "LeadID"]), None, refresh_date=pd.Timestamp("2026-10-27"))
    value = dict(zip(out["OrderNumber"], out["OrderValue"]))
    assert value["S41505"] == 6855450.0
    assert value["LYD"] == 1000.0
    assert value["NORATE"] == 500.0  # missing rate -> 1, like Odoo
    assert value["ZERO"] == 250.0  # zero rate -> 1, like Odoo
