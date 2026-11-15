from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from sales_pipeline.legacy_transform import DataFrameUtils, TextUtils
from sales_pipeline import odoo_products
from sales_pipeline.odoo.base_repository import OdooRepositoryBase, flatten_many2one_columns
from sales_pipeline.odoo.client import OdooClient


# Avg daily sales threshold above which a product is classified as a Fast Mover.
# Raise this value to tighten the Fast Mover definition.
FAST_MOVER_THRESHOLD: float = 5.0

STOCK_QUANT_FIELDS = [
    "id",
    "product_id",
    "company_id",
    "location_id",
    "quantity",
    "reserved_quantity",
    "value",
    "inventory_value",
    # when the stock arrived (UTC): Stock Aging on the Stock Velocity page (2026-11-07)
    "in_date",
]

STOCK_LOCATION_FIELDS = [
    "id",
    "name",
    "complete_name",
    "usage",
    "scrap_location",
    "active",
    "warehouse_id",
]

RES_COMPANY_FIELDS = ["id", "name"]

# The receipt layers of the stock still on hand (remaining_qty > 0): Stock Aging on the Stock Velocity page (2026-11-10).
# create_date = when those units were received (UTC).
VALUATION_LAYER_FIELDS = ["id", "product_id", "company_id", "remaining_qty", "remaining_value", "create_date"]
VALUATION_LAYER_DOMAIN = [["remaining_qty", ">", 0]]

FACT_INVENTORY_COLUMNS = [
    "SnapshotDate",
    "SnapshotDateKey",
    "Company",
    "CompanyKey",
    "ProductKey",
    "ProductName",
    "OdooProductID",
    "OdooProductName",
    "SKU",
    "LocationID",
    "LocationName",
    "WarehouseName",
    "OnHandQty",
    "ReservedQty",
    "AvailableQty",
    "ProductCost",
    "InventoryValue",
    "InventoryStatus",
    # Business classification columns — computed during ETL, used directly in Power BI
    "DOH",
    "Avg_Daily_Sales",
    "Velocity_Class",
    "ProductCompanyKey",
    "StockClass",
    "InDate",
]

QA_INVENTORY_COLUMNS = ["CheckName", "MetricValue", "Status", "Notes"]


class InventoryRepository(OdooRepositoryBase):
    """Extract current inventory snapshots from Odoo."""

    def __init__(self, client: OdooClient, batch_size: int = 500) -> None:
        super().__init__(client, batch_size)
        self.field_availability = pd.DataFrame()

    def fetch_stock_quants(self) -> pd.DataFrame:
        fields, qa, meta = self.available_fields("stock.quant", STOCK_QUANT_FIELDS)
        self.field_availability = pd.concat([self.field_availability, qa], ignore_index=True)
        rows = self.search_read_all("stock.quant", [], fields, order="id")
        return flatten_many2one_columns(rows, meta)

    def fetch_locations(self) -> pd.DataFrame:
        fields, qa, meta = self.available_fields("stock.location", STOCK_LOCATION_FIELDS)
        self.field_availability = pd.concat([self.field_availability, qa], ignore_index=True)
        rows = self.search_read_all(
            "stock.location",
            [],
            fields,
            order="id",
            context={"active_test": False},
        )
        return flatten_many2one_columns(rows, meta)

    def fetch_valuation_layers(self) -> pd.DataFrame:
        fields, qa, meta = self.available_fields("stock.valuation.layer", VALUATION_LAYER_FIELDS)
        self.field_availability = pd.concat([self.field_availability, qa], ignore_index=True)
        rows = self.search_read_all("stock.valuation.layer", VALUATION_LAYER_DOMAIN, fields, order="id")
        return flatten_many2one_columns(rows, meta)

    def fetch_companies(self) -> pd.DataFrame:
        fields, qa, meta = self.available_fields("res.company", RES_COMPANY_FIELDS)
        self.field_availability = pd.concat([self.field_availability, qa], ignore_index=True)
        rows = self.search_read_all(
            "res.company",
            [],
            fields,
            order="id",
            context={"active_test": False},
        )
        return flatten_many2one_columns(rows, meta)


@dataclass(frozen=True)
class InventoryBuildResult:
    fact_inventory: pd.DataFrame
    dim_product: pd.DataFrame
    dim_company: pd.DataFrame
    qa_data_quality: pd.DataFrame
    products_added_count: int
    internal_rows_count: int


class InventoryModelBuilder:
    """Build Fact_Inventory and inventory QA tables."""

    logger = logging.getLogger(__name__)

    def build(
        self,
        *,
        stock_quants: pd.DataFrame,
        locations: pd.DataFrame,
        product_raw: pd.DataFrame,
        dim_product: pd.DataFrame,
        dim_company: pd.DataFrame,
        snapshot_date: Any,
        companies: pd.DataFrame | None = None,
        include_qa: bool = True,
        product_sales_summary: pd.DataFrame | None = None,
        stock_locations_config: dict[str, Any] | None = None,
    ) -> InventoryBuildResult:
        """
        product_sales_summary: optional DataFrame with columns [ProductKey, Avg_Daily_Sales].
        When provided, Avg_Daily_Sales is joined into Fact_Inventory, DOH is calculated
        from OnHandQty / Avg_Daily_Sales, and Velocity_Class is populated. Missing sales
        history defaults to zero.
        """
        snapshot = pd.Timestamp(snapshot_date).normalize()
        if stock_quants is None or stock_quants.empty:
            fact = pd.DataFrame(columns=FACT_INVENTORY_COLUMNS)
            qa = self._build_qa(fact, 0, include_qa=include_qa)
            return InventoryBuildResult(
                fact_inventory=fact,
                dim_product=dim_product,
                dim_company=dim_company,
                qa_data_quality=qa,
                products_added_count=0,
                internal_rows_count=0,
            )

        quants = self._normalize_quants(stock_quants)
        quants = self._backfill_company_names(quants, companies if companies is not None else pd.DataFrame())
        internal_locations = self._internal_locations(locations)
        inventory = quants.merge(
            internal_locations,
            left_on="LocationID",
            right_on="LocationID",
            how="inner",
            validate="m:1",
        )
        internal_rows_count = len(inventory)
        inventory["StockClass"] = self.classify_locations(inventory["WarehouseName"], stock_locations_config or {})

        product_lookup = self._product_lookup(product_raw)
        inventory = inventory.merge(
            product_lookup,
            on="OdooProductID",
            how="left",
            validate="m:1",
        )
        inventory = self._coalesce_odoo_product_names(inventory)
        inventory = self._attach_products(inventory, dim_product)
        dim_product_augmented, products_added_count = dim_product, 0
        dim_company_augmented = self._add_missing_companies(dim_company, inventory)
        inventory = self._attach_company_keys(inventory, dim_company_augmented)
        inventory = self._attach_product_cost(inventory, product_lookup)

        fact = self._build_fact(inventory, snapshot, product_sales_summary=product_sales_summary)
        qa_data_quality = self._build_qa(fact, products_added_count, include_qa=include_qa)
        return InventoryBuildResult(
            fact_inventory=fact,
            dim_product=dim_product_augmented,
            dim_company=dim_company_augmented,
            qa_data_quality=qa_data_quality,
            products_added_count=products_added_count,
            internal_rows_count=internal_rows_count,
        )

    STOCK_CLASS_FINISHED_GOODS = "FinishedGoods"
    STOCK_CLASS_RAW_MATERIALS = "RawMaterials"
    STOCK_CLASS_IN_TRANSIT = "InTransit"

    @classmethod
    def classify_locations(cls, warehouse_names: pd.Series, config: dict[str, Any]) -> pd.Series:
        """Internal location -> FinishedGoods / RawMaterials / InTransit by warehouse name (config lists,
        compared trimmed and case-insensitive). Anything not listed is finished goods."""
        def names(key: str) -> set[str]:
            return {str(v).strip().upper() for v in config.get(key, [])}

        wh = warehouse_names.astype("string").fillna("").str.strip().str.upper()
        return pd.Series(
            np.select(
                [wh.isin(names("raw_materials_warehouses")), wh.isin(names("in_transit_warehouses"))],
                [cls.STOCK_CLASS_RAW_MATERIALS, cls.STOCK_CLASS_IN_TRANSIT],
                default=cls.STOCK_CLASS_FINISHED_GOODS,
            ),
            index=warehouse_names.index,
            dtype="string",
        )

    @staticmethod
    def _normalize_quants(stock_quants: pd.DataFrame) -> pd.DataFrame:
        raw = DataFrameUtils.ensure_columns(
            stock_quants.copy(),
            [
                "id",
                "product_id",
                "product_id_id",
                "company_id",
                "company_id_id",
                "location_id",
                "location_id_id",
                "quantity",
                "reserved_quantity",
                "value",
                "inventory_value",
                "in_date",
            ],
        )
        out = pd.DataFrame(index=raw.index)
        out["OdooProductID"] = pd.to_numeric(raw["product_id_id"], errors="coerce").astype("Int64")
        out["OdooProductName"] = raw["product_id"]
        out["Company"] = raw["company_id"].apply(TextUtils.normalize_company)
        out["OdooCompanyID"] = pd.to_numeric(raw["company_id_id"], errors="coerce").astype("Int64")
        out["LocationID"] = pd.to_numeric(raw["location_id_id"], errors="coerce").astype("Int64")
        out["OnHandQty"] = pd.to_numeric(raw["quantity"], errors="coerce").fillna(0.0)
        out["ReservedQty"] = pd.to_numeric(raw["reserved_quantity"], errors="coerce").fillna(0.0)
        out["AvailableQty"] = out["OnHandQty"] - out["ReservedQty"]
        value = pd.to_numeric(raw["value"], errors="coerce")
        inventory_value = pd.to_numeric(raw["inventory_value"], errors="coerce")
        out["OdooTotalValue"] = value.combine_first(inventory_value)
        # Odoo sends False for an empty datetime; kept naive UTC like every other Odoo datetime in the extract
        out["InDate"] = pd.to_datetime(raw["in_date"].where(raw["in_date"].astype(str).ne("False")), errors="coerce", utc=True).dt.tz_localize(None)
        return out

    @staticmethod
    def normalize_valuation_layers(layers: pd.DataFrame | None, companies: pd.DataFrame | None = None) -> pd.DataFrame:
        """Odoo stock.valuation.layer rows (remaining_qty > 0) -> Company, ProductKey (Odoo product id),
        ProductCompanyKey, LayerDate (create_date, UTC naive), RemainingQty, RemainingValue. Company from the layer's
        company_id (name as normalized everywhere else; res.company names when the many2one has none)."""
        columns = ["Company", "ProductKey", "ProductCompanyKey", "LayerDate", "RemainingQty", "RemainingValue"]
        if layers is None or layers.empty:
            return pd.DataFrame(columns=columns)
        raw = DataFrameUtils.ensure_columns(layers.copy(), ["product_id_id", "company_id", "company_id_id", "remaining_qty", "remaining_value", "create_date"])
        out = pd.DataFrame(index=raw.index)
        out["OdooCompanyID"] = pd.to_numeric(raw["company_id_id"], errors="coerce").astype("Int64")
        out["Company"] = raw["company_id"].apply(TextUtils.normalize_company)
        out = InventoryModelBuilder._backfill_company_names(out, companies if companies is not None else pd.DataFrame())
        pid = pd.to_numeric(raw["product_id_id"], errors="coerce").astype("Int64")
        out["ProductKey"] = pid.astype("string").fillna(odoo_products.UNKNOWN_PRODUCT_KEY)
        out["ProductCompanyKey"] = odoo_products.product_company_keys(out["Company"], out["ProductKey"])
        out["LayerDate"] = pd.to_datetime(raw["create_date"].where(raw["create_date"].astype(str).ne("False")), errors="coerce")
        out["RemainingQty"] = pd.to_numeric(raw["remaining_qty"], errors="coerce").fillna(0.0)
        out["RemainingValue"] = pd.to_numeric(raw["remaining_value"], errors="coerce").fillna(0.0)
        return out[columns].reset_index(drop=True)

    @staticmethod
    def _backfill_company_names(quants: pd.DataFrame, companies: pd.DataFrame) -> pd.DataFrame:
        if companies is None or companies.empty or "OdooCompanyID" not in quants.columns:
            return quants
        raw = DataFrameUtils.ensure_columns(companies.copy(), ["id", "name"])
        lookup = pd.DataFrame(
            {
                "OdooCompanyID": pd.to_numeric(raw["id"], errors="coerce").astype("Int64"),
                "_CompanyFromResCompany": raw["name"].apply(TextUtils.normalize_company),
            }
        ).dropna(subset=["OdooCompanyID"]).drop_duplicates("OdooCompanyID", keep="first")
        out = quants.merge(lookup, on="OdooCompanyID", how="left", validate="m:1")
        company_blank = out["Company"].astype("string").str.strip().replace("", pd.NA).isna()
        out.loc[company_blank, "Company"] = out.loc[company_blank, "_CompanyFromResCompany"]
        return out.drop(columns=["_CompanyFromResCompany"], errors="ignore")

    @staticmethod
    def _internal_locations(locations: pd.DataFrame) -> pd.DataFrame:
        if locations is None or locations.empty:
            return pd.DataFrame(columns=["LocationID", "LocationName", "WarehouseName"])
        raw = DataFrameUtils.ensure_columns(
            locations.copy(),
            ["id", "name", "complete_name", "usage", "scrap_location", "active", "warehouse_id"],
        )
        usage = raw["usage"].astype("string").str.strip().str.lower()
        scrap = raw["scrap_location"].fillna(False).astype(bool)
        active = raw["active"].fillna(True).astype(bool)
        internal = raw.loc[usage.eq("internal") & ~scrap & active].copy()
        out = pd.DataFrame(index=internal.index)
        out["LocationID"] = pd.to_numeric(internal["id"], errors="coerce").astype("Int64")
        out["LocationName"] = internal["complete_name"].where(
            internal["complete_name"].astype("string").str.strip().replace("", pd.NA).notna(),
            internal["name"],
        )
        warehouse_from_field = internal["warehouse_id"].where(
            internal["warehouse_id"].astype("string").str.strip().replace("", pd.NA).notna(),
            pd.NA,
        )
        warehouse_from_path = out["LocationName"].astype("string").str.split("/", n=1).str[0].str.strip()
        out["WarehouseName"] = warehouse_from_field.fillna(warehouse_from_path)
        return out.dropna(subset=["LocationID"]).drop_duplicates("LocationID", keep="first")

    @staticmethod
    def _product_lookup(product_raw: pd.DataFrame) -> pd.DataFrame:
        raw = DataFrameUtils.ensure_columns(
            product_raw.copy() if product_raw is not None else pd.DataFrame(),
            ["id", "display_name", "name", "default_code", "standard_price", "company_id"],
        )
        if raw.empty:
            return pd.DataFrame(
                columns=[
                    "OdooProductID",
                    "OdooProductNameFromProduct",
                    "SKU",
                    "ProductCost",
                    "ProductCompany",
                ]
            )
        out = pd.DataFrame(index=raw.index)
        out["OdooProductID"] = pd.to_numeric(raw["id"], errors="coerce").astype("Int64")
        out["OdooProductNameFromProduct"] = raw["display_name"].where(
            raw["display_name"].astype("string").str.strip().replace("", pd.NA).notna(),
            raw["name"],
        )
        out["SKU"] = raw["default_code"]
        out["ProductCost"] = pd.to_numeric(raw["standard_price"], errors="coerce")
        out["ProductCompany"] = raw["company_id"].apply(TextUtils.normalize_company)
        return out.dropna(subset=["OdooProductID"]).drop_duplicates("OdooProductID", keep="first")

    @staticmethod
    def _coalesce_odoo_product_names(inventory: pd.DataFrame) -> pd.DataFrame:
        out = inventory.copy()
        out["OdooProductName"] = out["OdooProductName"].where(
            out["OdooProductName"].astype("string").str.strip().replace("", pd.NA).notna(),
            out["OdooProductNameFromProduct"],
        )
        return out

    @staticmethod
    def _attach_products(inventory: pd.DataFrame, dim_product: pd.DataFrame) -> pd.DataFrame:
        """The Odoo product of each quant, by its product id (sales_pipeline.odoo_products): ProductKey = the id,
        name and SKU exactly as Odoo stores them. Never matched on a name."""
        out = inventory.copy()
        pid = pd.to_numeric(out["OdooProductID"], errors="coerce").astype("Int64")
        out["ProductKey"] = pid.astype("string").fillna(odoo_products.UNKNOWN_PRODUCT_KEY)
        if dim_product is not None and not dim_product.empty and "OdooProductID" in dim_product.columns:
            catalog = dim_product.drop_duplicates("OdooProductID").set_index("OdooProductID")
            found = pid.isin(catalog.index).fillna(False).astype(bool)
            out["ProductName"] = pid.map(catalog["ProductName"]).where(found, out["OdooProductName"])
            out["SKU"] = pid.map(catalog["SKU"]).where(found, pd.NA)
        else:
            out["ProductName"] = out["OdooProductName"]
            out["SKU"] = pd.NA
        out["ProductCompanyKey"] = odoo_products.product_company_keys(out["Company"], out["ProductKey"])
        return out

    @staticmethod
    def _add_missing_companies(dim_company: pd.DataFrame, inventory: pd.DataFrame) -> pd.DataFrame:
        dim = DataFrameUtils.ensure_columns(dim_company.copy(), ["CompanyKey", "Company"])
        existing = set(dim["Company"].dropna().astype("string"))
        companies = (
            inventory["Company"]
            .astype("string")
            .str.strip()
            .replace("", pd.NA)
            .dropna()
            .drop_duplicates()
            .sort_values()
        )
        missing = [company for company in companies if company not in existing]
        if not missing:
            return dim.reset_index(drop=True)
        max_key = pd.to_numeric(dim["CompanyKey"], errors="coerce").max()
        next_key = 1 if pd.isna(max_key) else int(max_key) + 1
        rows = pd.DataFrame(
            {
                "CompanyKey": range(next_key, next_key + len(missing)),
                "Company": missing,
            }
        )
        return pd.concat([dim, rows], ignore_index=True).reset_index(drop=True)

    @staticmethod
    def _attach_company_keys(inventory: pd.DataFrame, dim_company: pd.DataFrame) -> pd.DataFrame:
        lookup = dim_company[["Company", "CompanyKey"]].dropna(subset=["Company"]).drop_duplicates("Company")
        out = inventory.merge(lookup, on="Company", how="left", validate="m:1")
        out["CompanyKey"] = pd.to_numeric(out["CompanyKey"], errors="coerce").astype("Int64")
        return out

    @staticmethod
    def _attach_product_cost(inventory: pd.DataFrame, product_lookup: pd.DataFrame) -> pd.DataFrame:
        out = inventory.copy()
        out["ProductCost"] = pd.to_numeric(out["ProductCost"], errors="coerce")
        return out

    @staticmethod
    def _build_fact(
        inventory: pd.DataFrame,
        snapshot: pd.Timestamp,
        product_sales_summary: pd.DataFrame | None = None,
    ) -> pd.DataFrame:
        out = pd.DataFrame(index=inventory.index)
        out["SnapshotDate"] = snapshot
        out["SnapshotDateKey"] = int(snapshot.strftime("%Y%m%d"))
        for column in [
            "Company",
            "CompanyKey",
            "ProductKey",
            "ProductName",
            "OdooProductID",
            "OdooProductName",
            "SKU",
            "LocationID",
            "LocationName",
            "WarehouseName",
            "OnHandQty",
            "ReservedQty",
            "AvailableQty",
            "ProductCost",
            "OdooTotalValue",
            "ProductCompanyKey",
            "StockClass",
            "InDate",
        ]:
            out[column] = inventory[column] if column in inventory.columns else pd.NA
        out["InventoryValue"] = pd.to_numeric(out["OdooTotalValue"], errors="coerce")
        on_hand = pd.to_numeric(out["OnHandQty"], errors="coerce").fillna(0)
        reserved = pd.to_numeric(out["ReservedQty"], errors="coerce").fillna(0)
        out["InventoryStatus"] = np.select(
            [on_hand.gt(0), on_hand.eq(0) & reserved.gt(0)],
            ["In Stock", "Reserved Only"],
            default="Out of Stock",
        )

        out = InventoryModelBuilder._attach_sales_summary(out, product_sales_summary)
        out = InventoryModelBuilder._classify_inventory(out)

        return out[FACT_INVENTORY_COLUMNS].reset_index(drop=True)

    @staticmethod
    def _attach_sales_summary(fact: pd.DataFrame, product_sales_summary: pd.DataFrame | None) -> pd.DataFrame:
        """Join Avg_Daily_Sales (per Company + product) and derive DOH = on-hand / avg daily sales.

        No sales in the look-back window: Avg_Daily_Sales = 0 and DOH is left empty (infinite) --
        it used to be written as 0, which made unsold stock look like a stock-out risk."""
        fact = fact.copy()
        key = "ProductCompanyKey"
        if product_sales_summary is None or product_sales_summary.empty or key not in product_sales_summary.columns:
            fact["Avg_Daily_Sales"] = 0.0
            fact["DOH"] = np.nan
            return fact
        summary = product_sales_summary[[key, "Avg_Daily_Sales"]].dropna(subset=[key]).drop_duplicates(key)
        merged = fact[[key]].merge(summary, on=key, how="left", validate="m:1")
        merged.index = fact.index
        avg_daily_sales = pd.to_numeric(merged["Avg_Daily_Sales"], errors="coerce").fillna(0.0)
        on_hand = pd.to_numeric(fact["OnHandQty"], errors="coerce").fillna(0.0).clip(lower=0.0)
        fact["Avg_Daily_Sales"] = avg_daily_sales
        fact["DOH"] = on_hand.div(avg_daily_sales.where(avg_daily_sales > 0))
        return fact

    @staticmethod
    def build_product_sales_summary(sales: pd.DataFrame, lookback_days: int = 90, as_of: Any = None) -> pd.DataFrame:
        """Average daily invoiced quantity per Company + product over the last `lookback_days` days
        (days elapsed, not days with sales)."""
        columns = ["ProductCompanyKey", "Avg_Daily_Sales"]
        if sales is None or sales.empty or "ProductKey" not in sales.columns:
            return pd.DataFrame(columns=columns)
        today = pd.Timestamp(as_of).normalize() if as_of is not None else pd.Timestamp.today().normalize()
        start = today - pd.Timedelta(days=lookback_days - 1)
        dates = pd.to_datetime(sales.get("order_date_date"), errors="coerce").dt.normalize()
        quantity_col = next((c for c in ["quantity", "Volume", "Quantity"] if c in sales.columns), None)
        if quantity_col is None:
            return pd.DataFrame(columns=columns)
        company_col = next((c for c in ["company_final", "Company", "company"] if c in sales.columns), None)
        company = sales[company_col] if company_col else pd.Series(pd.NA, index=sales.index)
        work = pd.DataFrame({
            "ProductCompanyKey": odoo_products.product_company_keys(company, sales["ProductKey"]),
            "Quantity": pd.to_numeric(sales[quantity_col], errors="coerce").fillna(0.0),
        })[dates.between(start, today)]
        if work.empty:
            return pd.DataFrame(columns=columns)
        summary = work.groupby("ProductCompanyKey", as_index=False)["Quantity"].sum()
        summary["Avg_Daily_Sales"] = summary["Quantity"].clip(lower=0.0) / float(lookback_days)
        return summary[columns]

    # DOH thresholds per company for Velocity_Class.
    # High Stock  : DOH > high_threshold
    # Low Stock   : DOH < low_threshold
    # Normal Stock: low_threshold <= DOH <= high_threshold
    _VELOCITY_THRESHOLDS: dict[str, tuple[float, float]] = {
        "tika":   (60.0,  30.0),   # (high_threshold, low_threshold)
        "majaal": (180.0, 60.0),
    }

    @staticmethod
    def _classify_inventory(fact: pd.DataFrame) -> pd.DataFrame:
        """Populate Velocity_Class from company-specific DOH thresholds."""
        out = fact.copy()
        doh = pd.to_numeric(out.get("DOH"), errors="coerce")
        company = (
            out.get("Company", pd.Series("", index=out.index))
            .astype("string")
            .str.strip()
            .str.lower()
        )
        thresholds = InventoryModelBuilder._VELOCITY_THRESHOLDS
        tika_high, tika_low = thresholds["tika"]
        majaal_high, majaal_low = thresholds["majaal"]

        is_tika = company.eq("tika")
        is_majaal = company.eq("majaal")

        on_hand = pd.to_numeric(out.get("OnHandQty"), errors="coerce").fillna(0.0)
        out["Velocity_Class"] = np.select(
            [
                doh.isna() & on_hand.gt(0),
                doh.isna(),
                is_tika & doh.gt(tika_high),
                is_tika & doh.lt(tika_low),
                is_tika,
                is_majaal & doh.gt(majaal_high),
                is_majaal & doh.lt(majaal_low),
                is_majaal,
            ],
            [
                "No Movement",
                "Unknown",
                "High Stock",
                "Low Stock",
                "Normal Stock",
                "High Stock",
                "Low Stock",
                "Normal Stock",
            ],
            default="Unknown",
        )
        return out

    @staticmethod
    def _build_qa(fact: pd.DataFrame, products_added_count: int, *, include_qa: bool = True) -> pd.DataFrame:
        if not include_qa:
            return pd.DataFrame(columns=QA_INVENTORY_COLUMNS)
        on_hand = pd.to_numeric(fact.get("OnHandQty", pd.Series(dtype="float64")), errors="coerce").fillna(0)
        value = pd.to_numeric(fact.get("InventoryValue", pd.Series(dtype="float64")), errors="coerce").fillna(0)
        missing_product_key = int((on_hand.ne(0) & fact.get("ProductKey", pd.Series(dtype="object")).isna()).sum()) if not fact.empty else 0
        missing_company = int(fact.get("Company", pd.Series(dtype="object")).isna().sum()) if not fact.empty else 0
        missing_cost = int(fact.get("ProductCost", pd.Series(dtype="object")).isna().sum()) if not fact.empty else 0
        negative_rows = int(on_hand.lt(0).sum())
        rows = [
            ("Total inventory rows", len(fact), "PASS", ""),
            ("Products with stock but missing ProductKey", missing_product_key, "PASS" if missing_product_key == 0 else "FAIL", ""),
            ("Negative stock rows", negative_rows, "PASS" if negative_rows == 0 else "WARN", ""),
            ("Rows with missing company", missing_company, "PASS" if missing_company == 0 else "FAIL", ""),
            ("Rows with missing product cost", missing_cost, "PASS" if missing_cost == 0 else "WARN", ""),
            ("Total OnHandQty", float(on_hand.sum()), "INFO", ""),
            ("Total InventoryValue", float(value.sum()), "INFO", ""),
        ]
        return pd.DataFrame(rows, columns=QA_INVENTORY_COLUMNS)
