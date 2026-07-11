from __future__ import annotations

import os
from pathlib import Path
import sys

import pandas as pd


PROJECT_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = PROJECT_DIR / "src"
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from config.settings import Settings  # noqa: E402
from sales_pipeline.legacy_transform import (  # noqa: E402
    BCGMatrixBuilder,
    PipelineSettings,
    ProductCostDimensionBuilder,
    ProductCostMatcher,
    SegmentDimensionBuilder,
)
from sales_pipeline.odoo import OdooClient, ProductCostRepository  # noqa: E402
from refresh_product_outputs import MODEL_PATH, _print_bcg_refresh_summary, _upsert_model_sheets  # noqa: E402


QA_PATH = MODEL_PATH.parent / "QA_MissingProductCost.xlsx"


def main() -> int:
    settings = Settings.from_env(PROJECT_DIR / ".env")
    settings.validate()
    client = OdooClient(
        url=settings.odoo_url,
        db=settings.odoo_db,
        username=settings.odoo_user,
        api_key=settings.odoo_api_key,
        timeout_seconds=settings.rpc_timeout_seconds,
        max_retries=settings.max_retries,
    )
    client.authenticate()

    # Product cost is sourced directly from Odoo product.product standard_price.
    raw_cost = ProductCostRepository(client, settings.batch_size).fetch_product_costs()
    try:
        dim_product = pd.read_excel(MODEL_PATH, sheet_name="Dim_Product")
    except ValueError:
        dim_product = pd.DataFrame()
    dim_product_cost = ProductCostDimensionBuilder().build(raw_cost, dim_product=dim_product)
    sales_lines = pd.read_excel(
        MODEL_PATH,
        sheet_name="Fact_SalesLines",
        usecols=lambda name: name in {
            "Company", "company_final", "company", "ProductKey", "OdooProductID",
            "SegmentKey", "SalesSegment",
            "SKU", "product_name_raw", "product_name_clean", "product_name",
            "ProductNameRaw", "ProductName", "ProductNameClean",
            "order_date_date", "date_order", "OrderDate", "order_date",
            "qty_invoiced", "quantity", "Volume", "Value", "line_total",
            "untaxed_total", "invoice_status", "order_state",
        },
    )
    dim_segment = SegmentDimensionBuilder(PipelineSettings()).build(pd.DataFrame(), pd.DataFrame())
    if "SalesSegment" in sales_lines.columns:
        sales_lines["SalesSegment"] = sales_lines["SalesSegment"].apply(SegmentDimensionBuilder.normalize_segment)
        sales_lines["SegmentKey"] = sales_lines["SalesSegment"].map(SegmentDimensionBuilder.segment_key_map()).astype("Int64")
    fact_bcg = BCGMatrixBuilder.build(sales_lines, dim_product_cost, dim_product=dim_product)
    qa_missing = ProductCostMatcher.missing_cost_qa(sales_lines, dim_product_cost)

    # Replace only the two requested model worksheets.
    _upsert_model_sheets(
        MODEL_PATH,
        {"Dim_ProductCost": dim_product_cost, "Dim_Segment": dim_segment, "Fact_BCGMatrix": fact_bcg},
    )
    temp_qa = QA_PATH.with_name(f".{QA_PATH.stem}.tmp.xlsx")
    try:
        qa_missing.to_excel(temp_qa, index=False)
        os.replace(temp_qa, QA_PATH)
    finally:
        temp_qa.unlink(missing_ok=True)

    print(f"Dim_ProductCost rows: {len(dim_product_cost)}")
    print(f"Missing product cost count: {len(qa_missing)}")
    _print_bcg_refresh_summary(fact_bcg, sales_lines, dim_segment)
    print("BCG class count YTD:")
    print(fact_bcg["bcg_class_YTD"].value_counts(dropna=False).to_string())
    print("BCG class count LYTD:")
    print(fact_bcg["bcg_class_LYTD"].value_counts(dropna=False).to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
