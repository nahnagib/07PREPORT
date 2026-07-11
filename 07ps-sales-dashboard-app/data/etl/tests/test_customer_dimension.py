from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sales_pipeline.legacy_transform import (  # noqa: E402
    CustomerDimensionBuilder,
    PipelineSettings,
    SalesOrgMaps,
)


class DummyBlockedCustomersLoader:
    def load(self, path):
        return pd.DataFrame(
            columns=[
                "CustomerID",
                "CustomerName",
                "IsBlocked",
                "BlockedDate",
                "UnblockedDate",
                "BlockedReason",
                "Notes",
            ]
        )


def builder() -> CustomerDimensionBuilder:
    sales_org = SalesOrgMaps(
        people_active=pd.DataFrame(),
        teams=pd.DataFrame(),
        person_to_teamkey={"Alice": "TEAM-1"},
        teamkey_to_meta={"TEAM-1": {"team_name": "Team 1"}},
        teamname_to_key={},
        person_to_channel={"Alice": "Direct"},
        teamkey_to_channel={},
    )
    return CustomerDimensionBuilder(sales_org, PipelineSettings(), DummyBlockedCustomersLoader())


def sales_frame(customer_ids=None, customers=None) -> pd.DataFrame:
    customers = customers or ["Acme Co", "Beta LLC", "Acme Co"]
    data = {
        "customer": customers,
        "order_date_date": pd.to_datetime(["2025-01-10", "2025-02-11", "2024-03-12"][: len(customers)]),
        "Value": [100.0, 200.0, 300.0][: len(customers)],
        "Company": ["Main"] * len(customers),
        "salesperson": ["Alice"] * len(customers),
        "SalesSegment": ["B2B"] * len(customers),
    }
    if customer_ids is not None:
        data["customer_id"] = customer_ids
    return pd.DataFrame(data)


def customer_ids_for(dim: pd.DataFrame) -> dict[str, str]:
    return dict(zip(dim["customer"], dim["CustomerID"]))


def test_customer_id_generated_when_no_customer_id_column():
    dim = builder().build(sales_frame(customer_ids=None), blocked_customers_path=None)

    assert dim["CustomerID"].notna().all()
    assert (dim["CustomerID"].astype(str).str.strip() != "").all()
    assert dim["CustomerID"].astype(str).str.startswith("CUST-").all()


def test_customer_id_generated_when_customer_id_column_all_null():
    dim = builder().build(sales_frame(customer_ids=[pd.NA, None, float("nan")]), blocked_customers_path=None)

    assert dim["CustomerID"].notna().all()
    assert dim["CustomerID"].astype(str).str.startswith("CUST-").all()


def test_customer_id_mixed_valid_and_null_values():
    dim = builder().build(sales_frame(customer_ids=["ODOO-1", None, "ODOO-1"]), blocked_customers_path=None)
    ids = customer_ids_for(dim)

    assert ids["Acme Co"] == "ODOO-1"
    assert ids["Beta LLC"].startswith("CUST-")
    assert dim["CustomerID"].notna().all()


def test_blank_and_null_string_customer_ids_are_synthetic():
    dim = builder().build(
        sales_frame(customer_ids=["", " null ", "nan"], customers=["Blank Co", "Null Co", "Nan Co"]),
        blocked_customers_path=None,
    )

    assert dim["CustomerID"].astype(str).str.startswith("CUST-").all()
    assert dim["CustomerID"].notna().all()


def test_synthetic_customer_ids_are_stable_across_row_order_changes():
    base = sales_frame(customer_ids=[None, None, None], customers=["Acme Co", "Beta LLC", "Gamma Inc"])
    shuffled = base.sample(frac=1, random_state=42).reset_index(drop=True)

    first = customer_ids_for(builder().build(base, blocked_customers_path=None))
    second = customer_ids_for(builder().build(shuffled, blocked_customers_path=None))

    assert first == second
