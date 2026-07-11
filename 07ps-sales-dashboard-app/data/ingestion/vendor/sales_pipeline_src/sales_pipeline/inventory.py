from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from sales_pipeline.legacy_transform import DataFrameUtils, ProductMapper, TextUtils
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

FACT_INVENTORY_COLUMNS = [
    "SnapshotDate",
    "SnapshotDateKey",
    "Company",
    "CompanyKey",
    "ProductKey",
    "ProductName",
    "ProductNameClean",
    "OdooProductID",
    "OdooProductName",
    "OdooProductNameClean",
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
]

QA_INVENTORY_COLUMNS = ["CheckName", "MetricValue", "Status", "Notes"]

QA_INVENTORY_UNMAPPED_COLUMNS = [
    "Company",
    "OdooProductID",
    "OdooProductName",
    "OdooProductNameClean",
    "ProductKey",
    "Source",
    "FirstSeenDate",
    "RefreshDate",
    "OnHandQty",
    "ReservedQty",
    "AvailableQty",
    "Reason",
]


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
    qa_unmapped_products: pd.DataFrame
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
                qa_unmapped_products=pd.DataFrame(columns=QA_INVENTORY_UNMAPPED_COLUMNS),
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

        product_lookup = self._product_lookup(product_raw)
        inventory = inventory.merge(
            product_lookup,
            on="OdooProductID",
            how="left",
            validate="m:1",
        )
        inventory = self._coalesce_odoo_product_names(inventory)
        inventory = self._attach_product_mapping(inventory, dim_product)
        dim_product_augmented, products_added_count = self._add_missing_products(dim_product, inventory)
        dim_company_augmented = self._add_missing_companies(dim_company, inventory)
        inventory = self._attach_company_keys(inventory, dim_company_augmented)
        inventory = self._attach_product_cost(inventory, product_lookup)

        fact = self._build_fact(inventory, snapshot, product_sales_summary=product_sales_summary)
        qa_data_quality = self._build_qa(fact, products_added_count, include_qa=include_qa)
        qa_unmapped = self._build_unmapped_qa(inventory, snapshot) if include_qa else pd.DataFrame(columns=QA_INVENTORY_UNMAPPED_COLUMNS)
        return InventoryBuildResult(
            fact_inventory=fact,
            dim_product=dim_product_augmented,
            dim_company=dim_company_augmented,
            qa_data_quality=qa_data_quality,
            qa_unmapped_products=qa_unmapped,
            products_added_count=products_added_count,
            internal_rows_count=internal_rows_count,
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
        return out

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
        names = TextUtils.product_name_frame(out["OdooProductName"])
        out["OdooProductName"] = names["ProductNameRaw"]
        out["OdooProductNameClean"] = names["ProductNameClean"]
        out["SKU"] = (
            out["SKU"]
            .astype("string")
            .str.strip()
            .replace({"": pd.NA, "False": pd.NA, "false": pd.NA, "None": pd.NA, "none": pd.NA, "nan": pd.NA, "<NA>": pd.NA})
        )
        return out

    @staticmethod
    def _attach_product_mapping(inventory: pd.DataFrame, dim_product: pd.DataFrame) -> pd.DataFrame:
        out = inventory.copy()
        dim = DataFrameUtils.ensure_columns(
            dim_product.copy(),
            [
                "ProductKey",
                "ProductName",
                "ProductNameClean",
                "OdooProductName",
                "OdooProductNameClean",
                "SKU",
                "ProductJoinKey",
            ],
        )
        dim["_odoo_key"] = TextUtils.clean_product_key_part(dim["OdooProductNameClean"])
        out["_odoo_key"] = TextUtils.clean_product_key_part(out["OdooProductNameClean"])

        mapped = pd.Series(False, index=out.index)
        bridge_columns = ["ProductKey", "ProductName", "ProductNameClean", "OdooProductName", "OdooProductNameClean", "SKU"]
        out["ProductMappingStatus"] = pd.NA
        out["ProductMappingReason"] = pd.NA
        for key, status, reason in [
            ("_odoo_key", "MatchedByOdooProductName", "Matched inventory Odoo product to Dim_Product[OdooProductNameClean]"),
        ]:
            lookup = (
                dim.loc[dim[key].astype("string").str.strip().ne(""), bridge_columns + [key]]
                .drop_duplicates(key, keep="first")
                .rename(columns={column: f"_mapped_{column}" for column in bridge_columns})
            )
            candidate = out.loc[~mapped, [key]].merge(lookup, on=key, how="left", validate="m:1")
            candidate.index = out.index[~mapped]
            hit = candidate["_mapped_ProductKey"].notna()
            if not hit.any():
                continue
            hit_index = candidate.index[hit]
            for column in bridge_columns:
                out.loc[hit_index, column] = candidate.loc[hit, f"_mapped_{column}"].to_numpy()
            out.loc[hit_index, "ProductMappingStatus"] = status
            out.loc[hit_index, "ProductMappingReason"] = reason
            mapped.loc[hit_index] = True

        missing = ~mapped
        raw_names = TextUtils.product_name_frame(out.loc[missing, "OdooProductName"]) if missing.any() else pd.DataFrame()
        if missing.any():
            out.loc[missing, "ProductKey"] = [
                ProductMapper._raw_product_key(company, clean_name)
                for company, clean_name in zip(out.loc[missing, "Company"], raw_names["ProductNameClean"])
            ]
            out.loc[missing, "ProductName"] = raw_names["ProductName"].to_numpy()
            out.loc[missing, "ProductNameClean"] = raw_names["ProductNameClean"].to_numpy()
            out.loc[missing, "ProductMappingStatus"] = "Unmapped"
            out.loc[missing, "ProductMappingReason"] = "No official PRODUCTS.xlsx match for inventory Odoo product name"
        return out.drop(columns=["_odoo_key"], errors="ignore")

    @staticmethod
    def _add_missing_products(dim_product: pd.DataFrame, inventory: pd.DataFrame) -> tuple[pd.DataFrame, int]:
        dim = DataFrameUtils.ensure_columns(
            dim_product.copy(),
            [
                "ProductKey",
                "Company",
                "Category",
                "Brand",
                "SubBrand",
                "Family",
                "ProductNameRaw",
                "ProductName",
                "ProductNameClean",
                "OdooProductName",
                "OdooProductNameClean",
                "ProductLevel",
                "SKU",
                "Size",
                "IsActive",
                "ProductMappingStatus",
                "ProductMappingReason",
                "ProductSource",
                "IsMappedProduct",
            ],
        )
        existing_keys = set(dim["ProductKey"].dropna().astype("string"))
        missing = inventory[
            inventory["ProductMappingStatus"].astype("string").eq("Unmapped")
            & ~inventory["ProductKey"].astype("string").isin(existing_keys)
        ].copy()
        if missing.empty:
            return dim.reset_index(drop=True), 0
        additions = (
            missing.sort_values(["Company", "OdooProductNameClean"], na_position="last")
            .drop_duplicates("ProductKey", keep="first")
        )
        rows = pd.DataFrame(
            {
                "ProductKey": additions["ProductKey"],
                "Company": additions["Company"],
                "Category": pd.NA,
                "Brand": pd.NA,
                "SubBrand": pd.NA,
                "Family": pd.NA,
                "ProductNameRaw": additions["OdooProductName"],
                "ProductName": additions["ProductName"],
                "ProductNameClean": additions["ProductNameClean"],
                "OdooProductName": additions["OdooProductName"],
                "OdooProductNameClean": additions["OdooProductNameClean"],
                "ProductLevel": pd.NA,
                "SKU": pd.NA,
                "Size": pd.NA,
                "IsActive": 0,
                "ProductMappingStatus": "Unmapped",
                "ProductMappingReason": "No official PRODUCTS.xlsx match for inventory Odoo product name",
                "ProductSource": "Unmapped Odoo",
                "IsMappedProduct": False,
            }
        )
        return pd.concat([dim, rows], ignore_index=True).drop_duplicates("ProductKey", keep="first").reset_index(drop=True), len(rows)

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
            "ProductNameClean",
            "OdooProductID",
            "OdooProductName",
            "OdooProductNameClean",
            "SKU",
            "LocationID",
            "LocationName",
            "WarehouseName",
            "OnHandQty",
            "ReservedQty",
            "AvailableQty",
            "ProductCost",
            "OdooTotalValue",
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
        """Join Avg_Daily_Sales, then calculate DOH from the inventory quantity."""
        fact = fact.copy()
        if product_sales_summary is None or product_sales_summary.empty:
            fact["Avg_Daily_Sales"] = 0.0
            fact["DOH"] = 0.0
            return fact

        summary = product_sales_summary.copy()
        cols_needed = {"ProductKey", "Avg_Daily_Sales"}
        for col in cols_needed - set(summary.columns):
            summary[col] = pd.NA
        summary = (
            summary[list(cols_needed)]
            .dropna(subset=["ProductKey"])
            .drop_duplicates("ProductKey", keep="first")
        )
        summary["Avg_Daily_Sales"] = pd.to_numeric(summary["Avg_Daily_Sales"], errors="coerce")

        merged = fact.merge(summary, on="ProductKey", how="left", validate="m:1")
        merged.index = fact.index
        avg_daily_sales = pd.to_numeric(merged["Avg_Daily_Sales"], errors="coerce").fillna(0.0)
        on_hand = pd.to_numeric(fact["OnHandQty"], errors="coerce").fillna(0.0)
        fact["Avg_Daily_Sales"] = avg_daily_sales
        fact["DOH"] = on_hand.div(avg_daily_sales).replace([np.inf, -np.inf], np.nan).fillna(0.0)
        return fact

    @staticmethod
    def build_product_sales_summary(sales: pd.DataFrame) -> pd.DataFrame:
        """Calculate average daily product sales from the already-filtered sales history."""
        if sales is None or sales.empty:
            return pd.DataFrame(columns=["ProductKey", "Avg_Daily_Sales"])
        source_columns = set(sales.columns)
        raw = DataFrameUtils.ensure_columns(
            sales.copy(),
            ["ProductKey", "order_date_date", "order_date", "Quantity", "Volume", "quantity"],
        )
        quantity_col = next((column for column in ["Quantity", "Volume", "quantity"] if column in source_columns), "quantity")
        dates = pd.to_datetime(raw["order_date_date"], errors="coerce")
        dates = dates.fillna(pd.to_datetime(raw["order_date"], errors="coerce")).dt.normalize()
        work = pd.DataFrame(
            {
                "ProductKey": raw["ProductKey"].astype("string").str.strip().replace("", pd.NA),
                "OrderDate": dates,
                "Quantity": pd.to_numeric(raw[quantity_col], errors="coerce").fillna(0.0),
            }
        ).dropna(subset=["ProductKey", "OrderDate"])
        if work.empty:
            return pd.DataFrame(columns=["ProductKey", "Avg_Daily_Sales"])
        days = int((work["OrderDate"].max() - work["OrderDate"].min()).days) + 1
        if days <= 0:
            days = 1
        summary = (
            work.groupby("ProductKey", dropna=False, as_index=False)["Quantity"]
            .sum()
            .rename(columns={"Quantity": "_TotalSalesQty"})
        )
        summary["Avg_Daily_Sales"] = pd.to_numeric(summary["_TotalSalesQty"], errors="coerce").fillna(0.0).clip(lower=0.0) / float(days)
        return summary[["ProductKey", "Avg_Daily_Sales"]]

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

        out["Velocity_Class"] = np.select(
            [
                doh.isna(),
                is_tika & doh.gt(tika_high),
                is_tika & doh.lt(tika_low),
                is_tika,
                is_majaal & doh.gt(majaal_high),
                is_majaal & doh.lt(majaal_low),
                is_majaal,
            ],
            [
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
            ("Placeholder unmapped rows added to Dim_Product from inventory", products_added_count, "INFO", ""),
            ("Negative stock rows", negative_rows, "PASS" if negative_rows == 0 else "WARN", ""),
            ("Rows with missing company", missing_company, "PASS" if missing_company == 0 else "FAIL", ""),
            ("Rows with missing product cost", missing_cost, "PASS" if missing_cost == 0 else "WARN", ""),
            ("Total OnHandQty", float(on_hand.sum()), "INFO", ""),
            ("Total InventoryValue", float(value.sum()), "INFO", ""),
        ]
        return pd.DataFrame(rows, columns=QA_INVENTORY_COLUMNS)

    @staticmethod
    def _build_unmapped_qa(inventory: pd.DataFrame, snapshot: pd.Timestamp) -> pd.DataFrame:
        unmapped = inventory[inventory["ProductMappingStatus"].astype("string").eq("Unmapped")].copy()
        if unmapped.empty:
            return pd.DataFrame(columns=QA_INVENTORY_UNMAPPED_COLUMNS)
        out = pd.DataFrame(index=unmapped.index)
        for column in QA_INVENTORY_UNMAPPED_COLUMNS:
            if column == "Reason":
                out[column] = unmapped["ProductMappingReason"]
            elif column == "Source":
                out[column] = "Odoo Inventory"
            elif column in {"FirstSeenDate", "RefreshDate"}:
                out[column] = snapshot
            else:
                out[column] = unmapped[column] if column in unmapped.columns else pd.NA
        return (
            out[QA_INVENTORY_UNMAPPED_COLUMNS]
            .sort_values(["Company", "OdooProductNameClean"], na_position="last")
            .reset_index(drop=True)
        )
