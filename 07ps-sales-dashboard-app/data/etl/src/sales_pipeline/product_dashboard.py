"""Pre-aggregated tables behind the four Product pages (BCG Matrix, Stock Velocity, PIM Contribution,
Product Lifecycle), rebuilt on every ETL run from the same Fact_SalesLines rows the Sales pages read.

Products are Odoo's (sales_pipeline.odoo_products, 2026-11-03): one product = one Odoo product.product id in one
company (ProductCompanyKey 'Majaal|2163'); name, SKU, category, brand, family, size and active come from Odoo as stored,
'Unassigned' where Odoo has no value. Nothing is matched or grouped on a product name.

Tables (all full-replaced each run):
  Fact_ProductSalesDaily   one row per Company + product (ProductCompanyKey) + order date + the filter/RBAC
                           keys + IsIntercompany + UoM. Value = untaxed line total, Qty = invoiced qty
                           (same quantity as the Sales pages). Grand total == Fact_SalesLines total minus the
                           excluded companies and the not-real-sales lines (see below).
  Dim_ProductDashboard     one row per Company + product: every product sold or in stock in that company, plus the
                           active Odoo products of that company never sold, with today's stock, days of inventory,
                           stock band, lifecycle segment and BCG class. Always ONE company per row (2026-11-04: the
                           cross-company "BMH" grouping is removed); ThresholdCompany = that company.
                           2026-11-14: also every OTHER product of those companies (archived, excluded, catalog-only)
                           with OnProductPages = 0, and on every row its ProductStatus (Unclassified / Dormant / Active /
                           NonActive, with_status) -- the Total SKUs and Product Status cards. The pages' visuals read
                           only the OnProductPages = 1 rows. Every window is the last 12 months (periods.py).
Companies listed in config `product_pages.excluded_companies` (Athena) are left out of every table here, so the Product
pages' totals exclude them. Lines that are not real sales -- Customer Group in `product_pages_excluded_segment_keys`
(3 Backoffice, 4 Inter Company) or flagged IsIntercompany when `product_pages_exclude_intercompany` -- are dropped before
any product calculation (BCG, movement, lifecycle, first sale, frequency, velocity, PIM), so the Product pages' totals are
the Sales pages' totals minus those lines. On top of that, input file ProductExclusions.xlsx (product_exclusions.py):
  Customers   Exclude drops the customer's lines; Keep counts them even when Backoffice / Inter Company / intercompany.
  Categories  Exclude drops every product of the category AND of its sub-categories (lines, stock, catalog rows).
  Products    Exclude drops one product; Keep keeps it even when its category is excluded.
Every rule is per company (All, or the row's company), matched on Odoo ids only. Sub-categories are found by Odoo's full
category tree (product.category.parent_path; complete_name "Parent / Child" when the categories are not given). Without
the file, the category ids in config `product_pages_excluded_category_ids` (or the old `bcg.excluded_category_ids`) are the
only category rule.
Automatic product exclusions (no file row needed, 2026-11-11): archived products (product.product.active = False or
product.template.active = False -> catalog IsActive = 0) and every category whose own name is in config
`product_pages_raw_material_category_names` (a dedicated Raw Materials category, with its sub-categories). A Products row
with Action = Keep and Active = Yes keeps the product against every other rule (archived, file category, raw material,
2026-11-11); a row with Active = No is ignored and keeps nothing. What was excluded, and why, is written to
the conform_sales task log (details.product_exclusions, exclusion_report) for the ETL Control Center, with the archived products that still
have Quantity On Hand > 0 in Odoo (a stock clean-up list).
Units of measure of the "unit" type (UNIT, Unit, Units, وحدة) are one label, "Unit"
(product_pages.unit_uom_names); every other UoM keeps its own name.
  QA_ProductOdooGaps       every product sold that has no Brand, Family, Size or SKU in Odoo, biggest sales first --
                           the list to fill in Odoo (also written to OUTPUT/product_odoo_gaps.csv on a full refresh).
  QA_ProductDataQuality    negative stock, products without cost, products sold in several UoMs.
  ProductDashboard_Meta    as-of date, the rules/thresholds used, and the reconciliation totals.

Every threshold comes from config/product_dashboard.json (see docs/product_data_runbook.md).
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from sales_pipeline import odoo_products
from sales_pipeline.periods import get_last_12m_range, get_prior_12m_range
from sales_pipeline.product_exclusions import ProductExclusions
from sales_pipeline.product_matching import normalize_match_company

UNCLASSIFIED_NO_COST = "Unclassified (no cost)"

# One definition of "our products" (2026-11-15). Every SKU is in exactly one bucket, first match wins:
#   Unclassified (an active ProductExclusions.xlsx rule, or the automatic Raw Materials category) > Dormant (archived in
#   Odoo) > Active (sold in the period) > Non Active (not sold, never sold included).
# The portfolio of every Product page calculation is Active + Non Active; Dormant and Unclassified are counted only by
# Total SKUs, their own cards and the status table (backend measures/productPortfolio.ts mirrors this).
PRODUCT_STATUSES = ("Unclassified", "Dormant", "Active", "NonActive")
PORTFOLIO_STATUSES = ("Active", "NonActive")


def product_status(excluded: pd.Series, archived: pd.Series, sold: pd.Series) -> pd.Series:
    """The bucket of each row by the precedence above (the three masks share one index)."""
    return pd.Series(np.select([excluded.astype(bool), archived.astype(bool), sold.astype(bool)], list(PRODUCT_STATUSES[:3]),
                               default=PRODUCT_STATUSES[3]), index=excluded.index)


def rule_text(rule: dict[str, Any]) -> str:
    """"Products · Tika · row 12 · Samples (100% non-sales)" -- the ProductExclusions.xlsx row behind an Unclassified product."""
    parts = [f"{rule['sheet']} sheet", str(rule.get("company") or "")]
    if rule.get("name"):
        parts.append(str(rule["name"]))
    if rule.get("row") is not None and not pd.isna(rule.get("row")):
        parts.append(f"row {int(rule['row'])}")
    if isinstance(rule.get("reason"), str) and rule["reason"].strip():
        parts.append(rule["reason"].strip())
    return " · ".join(p for p in parts if p)
BCG_BY_CODE = {"HV/HP": "Stars", "HV/LP": "Cash Cows", "LV/HP": "Strategic", "LV/LP": "Dogs"}
MOVEMENTS = ("New", "Stable", "Improved", "Drop", "Discontinued")
GAP_ATTRIBUTES = ("Brand", "Family", "Size", "SKU")
UNIT_LABEL = "Unit"
GAP_COLUMNS = ["Company", "OdooProductID", "ProductName", "Category", "Missing", "SalesValue", "SalesValueLast12M",
               "Lines", "LastSaleDate", "AsOfDate"]
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProductDashboardConfig:
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, path: str | Path) -> "ProductDashboardConfig":
        with open(path, encoding="utf-8") as handle:
            return cls(json.load(handle))

    def section(self, name: str) -> dict[str, Any]:
        return dict(self.raw.get(name, {}))

    @property
    def lookback_days(self) -> int:
        return int(self.section("days_of_inventory").get("lookback_days", 90))

    def per_company(self, section: str, key: str) -> dict[str, float]:
        return {normalize_match_company(k): float(v) for k, v in self.section(section).get(key, {}).items()}

    @property
    def fingerprint(self) -> str:
        return hashlib.sha1(json.dumps(self.raw, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:12]


class IntercompanyFlagger:
    """Sets IsIntercompany on sales lines. Only the Product pages drop flagged lines
    (product_pages_exclude_intercompany); every other page keeps them."""

    def __init__(self, partner_ids: set[int], names: set[str]) -> None:
        self.partner_ids = partner_ids
        self.names = names

    @staticmethod
    def _norm(value: Any) -> str:
        return " ".join(str(value).split()).casefold() if value is not None and not pd.isna(value) else ""

    @classmethod
    def from_config(cls, path: str | Path) -> "IntercompanyFlagger":
        section = ProductDashboardConfig.load(path).section("intercompany_customers")
        return cls({int(v) for v in section.get("partner_ids", [])}, {cls._norm(v) for v in section.get("names", [])})

    def flag(self, sales: pd.DataFrame) -> pd.DataFrame:
        out = sales.copy()
        partner = pd.to_numeric(out.get("OdooPartnerID", pd.Series(pd.NA, index=out.index)), errors="coerce")
        by_id = partner.isin(list(self.partner_ids))
        customer = out.get("customer", pd.Series(pd.NA, index=out.index))
        by_name = customer.map(self._norm).isin(self.names)
        out["IsIntercompany"] = (by_id | by_name).astype(bool)
        return out


class ProductDashboardBuilder:
    DAILY_GRAIN = [
        "Company", "CompanyKey", "ProductCompanyKey", "ProductKey", "OrderDate", "DateKey",
        "SalespersonKey", "SegmentKey", "ChannelKey", "SalesTeamKey", "IsIntercompany", "UoM",
    ]
    PRODUCT_ATTRS = [
        "ProductKey", "ProductTemplateID", "ProductName", "OdooProductName", "Category", "CategoryID", "Brand",
        "SubBrand", "Family", "Size", "SKU", "IsActive",
    ]

    def __init__(self, config: ProductDashboardConfig, as_of: Any, exclusions: ProductExclusions | None = None) -> None:
        self.config = config
        self.as_of = pd.Timestamp(as_of).normalize()
        pages = config.section("product_pages")
        self.excluded_companies = {normalize_match_company(c) for c in pages.get("excluded_companies", [])}
        self.unit_names = {str(u).strip().casefold() for u in pages.get("unit_uom_names", [])}
        self.unit_label = str(pages.get("unit_label", UNIT_LABEL))
        self.excluded_segment_keys = {int(k) for k in config.raw.get("product_pages_excluded_segment_keys", [])}
        self.exclude_intercompany = bool(config.raw.get("product_pages_exclude_intercompany", False))
        self.excluded_sales: pd.DataFrame = pd.DataFrame()
        self.exclusions = exclusions if exclusions is not None else ProductExclusions.empty()
        if self.exclusions.source is None:
            # No ProductExclusions.xlsx (and no last valid copy): the category ids of the JSON config are the category rule.
            fallback = config.raw.get("product_pages_excluded_category_ids", config.section("bcg").get("excluded_category_ids", []))
            ids = [int(c) for c in fallback]
            self.exclusions.categories = pd.DataFrame({"Company": ["All"] * len(ids), "OdooID": pd.Series(ids, dtype="int64"),
                                                       "Action": ["Exclude"] * len(ids)})
        self.excluded_product_keys: set[str] = set()
        self.unclassified_report: dict[str, Any] = {}
        self.workbook_excluded_keys: set[str] = set()
        self.raw_material_category_names = {str(n).strip().casefold() for n in config.raw.get(
            "product_pages_raw_material_category_names", ["Raw Materials", "Raw Material", "المواد الخام", "مواد خام"])}
        self.excluded_product_reasons: dict[str, str] = {}
        self.sales_rule_counts: dict[str, dict[str, float]] = {}
        self.archived_on_hand: list[dict[str, Any]] = []
        self.on_hand_all: pd.DataFrame = pd.DataFrame()
        self.status_keys: pd.DataFrame = pd.DataFrame()
        self.sold_last_12m: set[str] = set()

    def uom_label(self, uom: Any) -> str:
        """One label for every unit-type UoM ('UNIT', 'Unit', 'وحدة' -> 'Unit'); any other UoM is kept as named."""
        text = "" if uom is None or (not isinstance(uom, str) and pd.isna(uom)) else str(uom)
        return self.unit_label if text.strip().casefold() in self.unit_names else text

    # ------------------------------------------------------------------ entry point
    def build(
        self,
        sales_lines: pd.DataFrame,
        dim_product: pd.DataFrame,
        fact_inventory: pd.DataFrame,
        line_costs: pd.Series | None = None,
        valuation_layers: pd.DataFrame | None = None,
        categories: pd.DataFrame | None = None,
        catalog_scope: pd.DataFrame | None = None,
    ) -> dict[str, pd.DataFrame]:
        """valuation_layers: the open Odoo receipt layers (stock.valuation.layer, remaining_qty > 0,
        InventoryModelBuilder.normalize_valuation_layers) for Stock Aging; None = age from stock.quant in_date only.
        categories: Odoo product.category with parent_path to resolve descendants.
        catalog_scope: variant IDs and their Odoo company contexts, including shared variants."""
        lines = self._prepare_lines(sales_lines, line_costs)
        stock = self._stock(fact_inventory, valuation_layers)
        catalog_keys = self._catalog_keys(dim_product, catalog_scope, lines, stock)
        self._resolve_products(catalog_keys, dim_product, categories)
        lines = lines[~lines["Company"].isin(self.excluded_companies)]
        lines = self._drop_non_sales(lines)
        if not stock.empty:
            stock = stock[~stock["Company"].isin(self.excluded_companies)]
        # Active = a real sale (posted quantity > 0) in the last 12 months, read before any product is dropped
        start_12m, end_12m = get_last_12m_range(self.as_of)
        recent = lines[lines["OrderDate"].between(start_12m, end_12m) & lines["Qty"].gt(0)]
        self.sold_last_12m = set(recent["ProductCompanyKey"].astype(str))
        lines = self._drop_products(lines)
        if not stock.empty:
            stock = stock[~stock["ProductCompanyKey"].isin(self.excluded_product_keys)]
        daily = self._daily(lines)
        self.assert_totals_preserved(lines, daily)
        products = self._products(lines, dim_product, stock)
        gaps = self.odoo_gaps(lines, products)
        inventory = fact_inventory
        if inventory is not None and not inventory.empty and "Company" in inventory.columns:
            inventory = inventory[~inventory["Company"].map(normalize_match_company).isin(self.excluded_companies)]
            inventory = inventory[~inventory["ProductCompanyKey"].isin(self.excluded_product_keys)]
        quality = self._data_quality(products, inventory, lines)
        meta = self._meta(lines, daily, products)
        return {
            "Fact_ProductSalesDaily": daily,
            "Dim_ProductDashboard": self.with_status(products, dim_product),
            "QA_ProductOdooGaps": gaps,
            "QA_ProductDataQuality": quality,
            "ProductDashboard_Meta": meta,
        }

    # ------------------------------------------------------------------ sales
    @staticmethod
    def _col(df: pd.DataFrame, name: str, default: Any = pd.NA) -> pd.Series:
        return df[name] if name in df.columns else pd.Series(default, index=df.index)

    def _prepare_lines(self, sales_lines: pd.DataFrame, line_costs: pd.Series | None) -> pd.DataFrame:
        s = sales_lines
        out = pd.DataFrame(index=s.index)
        out["Company"] = self._col(s, "company_final", self._col(s, "Company")).map(normalize_match_company)
        out["CompanyKey"] = pd.to_numeric(self._col(s, "CompanyKey"), errors="coerce").astype("Int64")
        out["ProductKey"] = self._col(s, "ProductKey").astype("string").fillna(odoo_products.UNKNOWN_PRODUCT_KEY)
        out["ProductCompanyKey"] = odoo_products.product_company_keys(out["Company"], out["ProductKey"])
        out["ProductName"] = self._col(s, "ProductName").astype(object)
        out["OdooProductName"] = self._col(s, "OdooProductName").astype(object)
        out["OdooProductID"] = pd.to_numeric(self._col(s, "OdooProductID"), errors="coerce").astype("Int64")
        out["OrderDate"] = pd.to_datetime(self._col(s, "order_date_date"), errors="coerce").dt.normalize()
        out["DateKey"] = pd.to_numeric(self._col(s, "DateKey"), errors="coerce").astype("Int64")
        for key in ["SalespersonKey", "SegmentKey", "ChannelKey"]:
            out[key] = pd.to_numeric(self._col(s, key), errors="coerce").astype("Int64")
        out["SalesTeamKey"] = self._col(s, "SalesTeamKey").astype("string")
        out["IsIntercompany"] = self._col(s, "IsIntercompany", False).fillna(False).astype(bool)
        # Customer ids for ProductExclusions.xlsx: the order's partner and its commercial partner (CustomerKey).
        out["OdooPartnerID"] = pd.to_numeric(self._col(s, "OdooPartnerID"), errors="coerce").astype("Int64")
        out["CustomerKey"] = pd.to_numeric(self._col(s, "CustomerKey"), errors="coerce").astype("Int64")
        out["UoM"] = self._col(s, "uom").map(self.uom_label).astype("string").fillna("")
        out["Value"] = pd.to_numeric(self._col(s, "untaxed_total"), errors="coerce").fillna(0.0)
        out["Qty"] = pd.to_numeric(self._col(s, "quantity"), errors="coerce").fillna(0.0)
        out["QtyOrdered"] = pd.to_numeric(self._col(s, "qty_ordered"), errors="coerce").fillna(0.0)
        out["QtyDelivered"] = pd.to_numeric(self._col(s, "qty_delivered"), errors="coerce").fillna(0.0)
        cost = pd.to_numeric(line_costs, errors="coerce") if line_costs is not None else pd.Series(np.nan, index=s.index)
        has_cost = cost.gt(0)
        out["CostValue"] = (out["Qty"] * cost).where(has_cost, 0.0)
        out["CostedQty"] = out["Qty"].where(has_cost, 0.0)
        out["UncostedQty"] = out["Qty"].where(~has_cost, 0.0)
        out["Lines"] = 1
        return out

    def _customer_rule(self, lines: pd.DataFrame, action: str) -> pd.Series:
        """Lines whose customer (order partner or commercial partner) has an active `action` row for the line's company."""
        hit = pd.Series(False, index=lines.index)
        for company in lines["Company"].dropna().unique():
            ids = list(self.exclusions.ids("Customers", action, str(company)))
            if ids:
                own = lines["Company"].eq(company)
                hit |= own & (lines["OdooPartnerID"].isin(ids).fillna(False) | lines["CustomerKey"].isin(ids).fillna(False))
        return hit

    def non_sales_mask(self, lines: pd.DataFrame) -> pd.Series:
        """Lines that are not real sales: an excluded Customer Group (stored SegmentKey) or, when configured, IsIntercompany
        -- unless the customer is a Customers Keep row -- plus every Customers Exclude row."""
        mask = lines["SegmentKey"].isin(list(self.excluded_segment_keys)).fillna(False).astype(bool)
        if self.exclude_intercompany:
            mask |= lines["IsIntercompany"].fillna(False).astype(bool)
        return (mask & ~self._customer_rule(lines, "Keep")) | self._customer_rule(lines, "Exclude")

    def _sales_rule_counts(self, lines: pd.DataFrame) -> dict[str, dict[str, float]]:
        """Sales lines per customer rule, for the ETL Control Center. A line is counted under the first rule that removed
        it: Customers Exclude, then Customer Group Backoffice (3) / Inter Company (4) / other excluded groups, then the
        IsIntercompany flag; `customers_keep` = lines the automatic rules would have removed, kept by a Customers Keep row."""
        keep = self._customer_rule(lines, "Keep")
        exclude = self._customer_rule(lines, "Exclude")
        segment = pd.to_numeric(lines["SegmentKey"], errors="coerce")
        flagged = lines["IsIntercompany"].fillna(False).astype(bool) if self.exclude_intercompany else pd.Series(False, index=lines.index)
        in_group = segment.isin(list(self.excluded_segment_keys)).fillna(False).astype(bool)
        rules = {"customers_exclude": exclude}
        for key in sorted(self.excluded_segment_keys):
            name = {3: "backoffice", 4: "inter_company"}.get(int(key), f"customer_group_{int(key)}")
            rules[name] = ~exclude & ~keep & segment.eq(key).fillna(False).astype(bool)
        rules["intercompany_flag"] = ~exclude & ~keep & ~in_group & flagged
        rules["customers_keep"] = ~exclude & keep & (in_group | flagged)
        out = {}
        for name, m in rules.items():
            sub = lines.loc[m]
            out[name] = {"lines": int(len(sub)), "qty": round(float(sub["Qty"].sum()), 2), "value": round(float(sub["Value"].sum()), 2),
                         "by_company": {str(c): int(n) for c, n in sub.groupby("Company").size().items()}}
        return out

    def _drop_non_sales(self, lines: pd.DataFrame) -> pd.DataFrame:
        mask = self.non_sales_mask(lines)
        self.sales_rule_counts = self._sales_rule_counts(lines)
        self.excluded_sales = lines.loc[mask]
        if mask.any():
            by_company = self.excluded_sales.groupby("Company")[["Lines", "Qty", "Value"]].sum()
            for company, r in by_company.iterrows():
                log.info("Product pages: %s not-real-sales line(s) dropped for %s (qty %s, LYD %s; segments %s, intercompany=%s)",
                         f"{int(r['Lines']):,}", company, f"{r['Qty']:,.2f}", f"{r['Value']:,.2f}",
                         sorted(self.excluded_segment_keys), self.exclude_intercompany)
        known = set(lines["OdooPartnerID"].dropna().astype(int)) | set(lines["CustomerKey"].dropna().astype(int))
        unknown = sorted(set(self.exclusions.customers["OdooID"].astype(int)) - known)
        if unknown:
            log.warning("Product pages: ProductExclusions.xlsx Customers id(s) with no sales line in the data: %s", unknown)
        return lines.loc[~mask]

    # ------------------------------------------------------------------ product exclusions
    @staticmethod
    def _category_tree(categories: pd.DataFrame | None) -> dict[int, list[int]]:
        """category id -> its chain of ids from the root (product.category.parent_path '1/30/57/')."""
        if categories is None or categories.empty or "parent_path" not in categories.columns:
            return {}
        out: dict[int, list[int]] = {}
        for cid, path in zip(pd.to_numeric(categories["id"], errors="coerce"), categories["parent_path"]):
            if pd.isna(cid) or not isinstance(path, str):
                continue
            out[int(cid)] = [int(x) for x in path.strip("/").split("/") if x.strip().isdigit()]
        return out

    def raw_material_category_ids(self, categories: pd.DataFrame | None) -> set[int]:
        """Odoo categories whose own name says Raw Materials (config product_pages_raw_material_category_names). Never a
        product-name guess: only a dedicated category, matched on the category's name."""
        if categories is None or categories.empty or "name" not in categories.columns:
            return set()
        names = categories["name"].map(lambda v: str(v).strip().casefold() if isinstance(v, str) else "")
        return {int(c) for c in pd.to_numeric(categories.loc[names.isin(self.raw_material_category_names), "id"], errors="coerce").dropna()}

    def _catalog_keys(
        self, catalog: pd.DataFrame, scope: pd.DataFrame | None, lines: pd.DataFrame, stock: pd.DataFrame,
    ) -> pd.DataFrame:
        """One row per visible Odoo variant and company, independent of transactions."""
        columns = ["Company", "ProductKey"]
        if scope is not None:
            keys = scope[columns].copy()
        else:
            # Callers without an Odoo company-context extract can use ownership and known company names.
            companies = set(lines["Company"].dropna())
            if not stock.empty:
                companies.update(stock["Company"].dropna())
            owners = self._col(catalog, "ProductCompany").map(normalize_match_company)
            companies.update(owners)
            own = catalog.loc[owners.ne(""), ["ProductKey"]].assign(Company=owners)
            shared = catalog.loc[owners.eq(""), ["ProductKey"]].merge(
                pd.DataFrame({"Company": sorted(companies - {""})}), how="cross",
            )
            keys = pd.concat([own[columns], shared[columns]], ignore_index=True)
        keys["Company"] = keys["Company"].map(normalize_match_company)
        keys["ProductKey"] = keys["ProductKey"].astype("string")
        keys["ProductCompanyKey"] = odoo_products.product_company_keys(keys["Company"], keys["ProductKey"])
        return keys.drop_duplicates("ProductCompanyKey").reset_index(drop=True)

    def _resolve_products(self, keys: pd.DataFrame, catalog: pd.DataFrame, categories: pd.DataFrame | None) -> None:
        """Resolve active Products and Categories once at variant + company grain."""
        keys = keys.copy()
        keys["pid"] = pd.to_numeric(keys["ProductKey"], errors="coerce").astype("Int64")
        by_id = catalog.drop_duplicates("OdooProductID").set_index("OdooProductID")
        category_id = keys["pid"].map(by_id["CategoryID"])
        keys["Archived"] = keys["pid"].map(by_id["IsActive"]).eq(False)
        tree = self._category_tree(categories)
        known_categories = set(tree) | set(by_id["CategoryID"].dropna())
        if categories is not None and "id" in categories.columns:
            known_categories.update(categories["id"].dropna())
        self._check_product_rows(keys, catalog)
        # A Categories row names its category by Odoo Category ID OR by the "Category Name (reference)" text = the
        # category's own name or full path ("All / Packaging"), case and surrounding spaces ignored.
        by_name: dict[str, set[int]] = {}
        named = [(categories, ("name", "complete_name"))] if categories is not None else []
        for frame, columns in named:
            for column in columns:
                if column in frame.columns and "id" in frame.columns:
                    for text, cid in zip(frame[column], pd.to_numeric(frame["id"], errors="coerce")):
                        if isinstance(text, str) and pd.notna(cid):
                            by_name.setdefault(" ".join(text.split()).casefold(), set()).add(int(cid))
        for cid, path in by_id[["CategoryID", "Category"]].dropna().drop_duplicates().itertuples(index=False):
            by_name.setdefault(" ".join(str(path).split()).casefold(), set()).add(int(cid))
        rules = self.exclusions.categories
        names = rules["Name"] if "Name" in rules.columns else pd.Series("", index=rules.index)
        rows = rules["Row"] if "Row" in rules.columns else pd.Series(pd.NA, index=rules.index)
        rule_roots: dict[int, set[int]] = {}
        for i, odoo_id, name, row in zip(rules.index, rules["OdooID"].astype(int), names, rows):
            roots = ({odoo_id} if odoo_id in known_categories else set()) | by_name.get(" ".join(str(name or "").split()).casefold(), set())
            rule_roots[i] = roots
            if not roots:
                reason = f"Odoo Category ID {odoo_id} ({name or 'no name'}) matches no Odoo category"
                self.exclusions.warnings.append({"sheet": "Categories", "row": None if pd.isna(row) else int(row), "reason": reason, "check": "odoo"})
                log.warning("Product pages: ProductExclusions.xlsx Categories row %s: %s", row, reason)

        def category_roots(company: str) -> set[int]:
            applies = self.exclusions.ids("Categories", "Exclude", company)
            out: set[int] = set()
            for i, odoo_id, rule_company in zip(rules.index, rules["OdooID"].astype(int), rules["Company"]):
                if odoo_id in applies and rule_company in ("All", company):
                    out |= rule_roots[i]
            return out

        def in_categories(roots: set[int]) -> pd.Series:
            members = roots | {cid for cid, chain in tree.items() if roots.intersection(chain)}
            if categories is None:
                # Compatibility for callers without product.category rows. Base the path on the rule's ID.
                paths = by_id.loc[by_id["CategoryID"].isin(roots), "Category"].dropna().unique()
                for path in paths:
                    children = by_id["Category"].astype("string").str.startswith(str(path) + " / ", na=False)
                    members.update(by_id.loc[children, "CategoryID"].dropna())
            return category_id.isin(members)

        raw_hit = in_categories(self.raw_material_category_ids(categories))
        keys["ExcludedByProduct"] = False
        keys["ExcludedByCategory"] = False
        keys["ExclusionRule"] = None
        reason = pd.Series(pd.NA, index=keys.index, dtype=object)
        for company, group in keys.groupby("Company"):
            idx = group.index
            keep = group["pid"].isin(self.exclusions.ids("Products", "Keep", company))
            individual = group["pid"].isin(self.exclusions.ids("Products", "Exclude", company)) & ~keep
            category = in_categories(category_roots(company)).loc[idx] & ~keep
            # the automatic Raw Materials category (2026-11-15): Unclassified like a Categories row, never a page product
            raw = raw_hit.loc[idx] & ~keep & ~individual & ~category
            keys.loc[idx, "ExcludedByProduct"] = individual
            keys.loc[idx, "ExcludedByCategory"] = category | raw
            # which rule matched (status table, Unclassified tab): sheet · Company · Excel row · Reason
            applies = self.exclusions.ids("Categories", "Exclude", company)
            rule_members = [(i, in_categories(rule_roots[i]).loc[idx]) for i, odoo_id, rule_company in
                            zip(rules.index, rules["OdooID"].astype(int), rules["Company"]) if odoo_id in applies and rule_company in ("All", company)]
            for k in idx[individual.to_numpy()]:
                hit = self.exclusions.rule_for("Products", company, int(keys.at[k, "pid"]), "Exclude")
                keys.at[k, "ExclusionRule"] = rule_text(hit) if hit else "Products sheet"
            for k in idx[category.to_numpy() & ~individual.to_numpy()]:
                i = next((i for i, members in rule_members if bool(members.at[k])), None)
                keys.at[k, "ExclusionRule"] = (rule_text({"sheet": "Categories", "company": rules.at[i, "Company"], "row": rows.at[i],
                                                          "reason": rules.at[i, "Reason"] if "Reason" in rules.columns else None,
                                                          "name": names.at[i]}) if i is not None else "Categories sheet")
            keys.loc[idx[raw.to_numpy()], "ExclusionRule"] = "Automatic · Raw Materials category"
            reason.loc[idx] = np.select(
                [group["Archived"] & ~keep, individual, category, raw_hit.loc[idx] & ~keep],
                ["archived", "file_product", "file_category", "raw_material"], default=None,
            )
        self.workbook_excluded_keys = set(keys.loc[
            keys["ExcludedByProduct"] | keys["ExcludedByCategory"], "ProductCompanyKey",
        ])
        in_scope = ~keys["Company"].isin(self.excluded_companies)
        self.status_keys = keys.loc[in_scope].reset_index(drop=True)
        self._log_unclassified(self.status_keys, rules, rows, names, rule_roots, in_categories)
        excluded = in_scope & reason.notna()
        self.excluded_product_reasons = dict(zip(keys.loc[excluded, "ProductCompanyKey"], reason[excluded]))
        self.excluded_product_keys = set(self.excluded_product_reasons)
        if excluded.any():
            log.info("Product pages: %s product/company exclusions: %s", int(excluded.sum()),
                     keys.loc[excluded].assign(Reason=reason[excluded]).groupby(["Company", "Reason"]).size().to_dict())
        # the archived products Odoo still holds stock for (a clean-up list; they stay off every visual)
        self.archived_on_hand = []
        if not self.on_hand_all.empty:
            archived_keys = set(keys.loc[keys["Archived"].astype(bool), "ProductCompanyKey"].astype(str))
            held = self.on_hand_all[self.on_hand_all["ProductCompanyKey"].astype(str).isin(archived_keys) & self.on_hand_all["OnHandQty"].gt(0)]
            held = held.sort_values(["Company", "OnHandValue"], ascending=[True, False])
            self.archived_on_hand = [
                {"company": str(r.Company), "product_id": str(r.ProductKey), "product_name": None if pd.isna(r.ProductName) else str(r.ProductName),
                 "quantity_on_hand": round(float(r.OnHandQty), 4), "total_value": round(float(r.OnHandValue), 2)}
                for r in held.itertuples(index=False)
            ]
            if self.archived_on_hand:
                log.warning("Product pages: %s archived product(s) still have Quantity On Hand > 0 in Odoo (excluded; listed for clean-up)",
                            len(self.archived_on_hand))
    def _log_unclassified(self, keys: pd.DataFrame, rules: pd.DataFrame, rows: pd.Series, names: pd.Series,
                          rule_roots: dict[int, set[int]], in_categories) -> None:
        """Every refresh: what the workbook matched -- per Categories row its products (with sub-categories, distinct Odoo
        variants, the row's company), the Products sheet, the overlap and the final Unclassified count (distinct variants).
        Also kept in exclusion_report() for the ETL Control Center."""
        scoped = keys.reset_index(drop=True)
        cats: list[dict[str, Any]] = []
        for i, odoo_id, rule_company in zip(rules.index, rules["OdooID"].astype(int), rules["Company"]):
            hit = in_categories(rule_roots[i]).reset_index(drop=True) if len(scoped) else pd.Series(dtype=bool)
            own = scoped["Company"].eq(rule_company) if rule_company != "All" else pd.Series(True, index=scoped.index)
            in_rule = hit.reindex(scoped.index, fill_value=False) & own
            matched = scoped.loc[in_rule & scoped["ExcludedByCategory"]]   # a Products Keep row takes its product out
            cats.append({"row": None if pd.isna(rows.loc[i]) else int(rows.loc[i]), "company": str(rule_company), "category_id": int(odoo_id),
                         "name": str(names.loc[i] or ""), "matched_categories": len(rule_roots[i]),
                         "products": int(matched["ProductKey"].nunique()), "archived": int(matched.loc[matched["Archived"], "ProductKey"].nunique()),
                         "kept": int(scoped.loc[in_rule & ~scoped["ExcludedByCategory"], "ProductKey"].nunique())})
        by_product = set(scoped.loc[scoped["ExcludedByProduct"], "ProductKey"])
        by_category = set(scoped.loc[scoped["ExcludedByCategory"], "ProductKey"])
        product_rules = self.exclusions.products
        known_products = set(pd.to_numeric(scoped["ProductKey"], errors="coerce").dropna().astype(int))
        exclude_ids = set(product_rules.loc[product_rules["Action"].eq("Exclude"), "OdooID"].astype(int)) if not product_rules.empty else set()
        keep_ids = set(product_rules.loc[product_rules["Action"].eq("Keep"), "OdooID"].astype(int)) if not product_rules.empty else set()
        self.unclassified_report = {
            "file": self.exclusions.source,
            "rows_read": {"active": self.exclusions.counts(), "inactive_ignored": dict(self.exclusions.ignored), "skipped": len(self.exclusions.skipped)},
            "categories": cats,
            "products_sheet": {"exclude_rows": len(exclude_ids), "keep_rows": len(keep_ids), "excluded_products": len(by_product),
                               "ids_not_in_odoo": sorted(exclude_ids - known_products)},
            "overlap_products_and_categories": len(by_product & by_category),
            "unclassified": {"total": len(by_product | by_category),
                             **{str(c): int(g.loc[g["ExcludedByProduct"] | g["ExcludedByCategory"], "ProductKey"].nunique())
                                for c, g in scoped.groupby("Company")}},
            "unmatched": [w for w in self.exclusions.warnings if w.get("check") == "odoo"],
        }
        log.info("Product pages: ProductExclusions.xlsx rows read (active per sheet) %s, Active = No ignored %s, skipped %s",
                 self.exclusions.counts(), dict(self.exclusions.ignored), len(self.exclusions.skipped))
        for c in cats:
            log.info("Product pages: Categories row %s (%s, id %s %s): %s product(s) incl. %s sub-categor(ies), %s archived, %s kept by a Products Keep row",
                     c["row"], c["company"], c["category_id"], c["name"], c["products"], max(0, c["matched_categories"] - 1), c["archived"], c["kept"])
        log.info("Product pages: Products sheet: %s Exclude / %s Keep id(s); %s product(s) excluded; %s id(s) not in Odoo: %s",
                 len(exclude_ids), len(keep_ids), len(by_product), len(exclude_ids - known_products), sorted(exclude_ids - known_products))
        log.info("Product pages: Unclassified = %s distinct product(s) (%s by category, %s by Products sheet, %s in both) %s",
                 len(by_product | by_category), len(by_category), len(by_product), len(by_product & by_category),
                 {k: v for k, v in self.unclassified_report["unclassified"].items() if k != "total"})

    def workbook_exclusion_mask(self, frame: pd.DataFrame, company_column: str, product_column: str) -> pd.Series:
        keys = odoo_products.product_company_keys(frame[company_column], pd.to_numeric(frame[product_column], errors="coerce").astype("Int64").astype("string"))
        return keys.isin(self.workbook_excluded_keys)

    def _check_product_rows(self, keys: pd.DataFrame, catalog: pd.DataFrame) -> None:
        """Products sheet rows whose id is not an Odoo product, or a product of another company than the row says: a
        warning with the sheet row (the row still applies, it simply matches nothing / only that company)."""
        self.exclusions.warnings = [w for w in self.exclusions.warnings if w.get("check") != "odoo"]
        rules = self.exclusions.products
        if rules.empty:
            return
        known = set(keys["pid"].dropna().astype(int))
        company_of: dict[int, str] = {}
        if not catalog.empty and {"ProductKey", "ProductCompany"} <= set(catalog.columns):
            own = catalog[catalog["ProductCompany"].notna()]
            pids = pd.to_numeric(own["ProductKey"], errors="coerce")
            known |= set(pd.to_numeric(catalog["ProductKey"], errors="coerce").dropna().astype(int))
            company_of = {int(p): str(normalize_match_company(c)) for p, c in zip(pids, own["ProductCompany"]) if pd.notna(p)}
        rows = rules.get("Row", pd.Series(pd.NA, index=rules.index))
        for odoo_id, company, row in zip(rules["OdooID"].astype(int), rules["Company"], rows):
            reason = None
            if odoo_id not in known:
                reason = f"Odoo Product ID {odoo_id} is not a product in Odoo: the row matches nothing"
            elif company != "All" and company_of.get(odoo_id) not in (None, company):
                reason = f"Odoo Product ID {odoo_id} belongs to {company_of[odoo_id]} in Odoo, but the row says {company}: it applies to {company} only"
            if reason:
                self.exclusions.warnings.append({"sheet": "Products", "row": None if pd.isna(row) else int(row), "reason": reason, "check": "odoo"})
                log.warning("Product pages: ProductExclusions.xlsx Products row %s: %s", row, reason)

    def exclusion_report(self) -> dict[str, Any]:
        """ETL Control Center: the file, the rules applied, products excluded per reason, sales lines per customer rule,
        archived products with stock."""
        by_reason: dict[str, dict[str, int]] = {}
        for key, why in self.excluded_product_reasons.items():
            company = key.split("|", 1)[0]
            by_reason.setdefault(why, {}).setdefault(company, 0)
            by_reason[why][company] += 1
        return {
            "as_of": str(pd.Timestamp(self.as_of).date()),
            "file": self.exclusions.summary(),
            "sku_counts": self._sku_counts(),
            "unclassified": self.unclassified_report,
            "products_excluded": {k: {"total": sum(v.values()), "by_company": v} for k, v in sorted(by_reason.items())},
            "sales_lines_excluded": self.sales_rule_counts,
            "archived_with_stock": self.archived_on_hand,
        }

    def _sku_counts(self) -> dict[str, dict[str, int]]:
        def totals(keys: pd.DataFrame) -> dict[str, int]:
            products = set(keys.loc[keys["ExcludedByProduct"], "ProductKey"])
            categories = set(keys.loc[keys["ExcludedByCategory"], "ProductKey"])
            return {
                "total": keys["ProductKey"].nunique(),
                "individual": len(products),
                "category": len(categories),
                "overlap": len(products & categories),
                "unclassified": len(products | categories),
            }

        return {
            "BMH": totals(self.status_keys),
            **{company: totals(keys) for company, keys in self.status_keys.groupby("Company")},
        }

    def _drop_products(self, lines: pd.DataFrame) -> pd.DataFrame:
        mask = lines["ProductCompanyKey"].isin(self.excluded_product_keys)
        if mask.any():
            r = lines.loc[mask].groupby("Company")[["Lines", "Qty", "Value"]].sum()
            for company, v in r.iterrows():
                log.info("Product pages: %s sales line(s) of excluded products dropped for %s (qty %s, LYD %s)",
                         f"{int(v['Lines']):,}", company, f"{v['Qty']:,.2f}", f"{v['Value']:,.2f}")
        return lines.loc[~mask]

    # ------------------------------------------------------------------ SKU status (2026-11-14)
    STATUS_ORDER = ("Unclassified", "Dormant", "Active", "NonActive")

    def with_status(self, products: pd.DataFrame, dim_product: pd.DataFrame | None) -> pd.DataFrame:
        """Keep every in-scope Odoo SKU alongside the existing analytical product rows."""
        pages = products.assign(OnProductPages=1)
        keys = self.status_keys
        extra = keys[~keys["ProductCompanyKey"].isin(pages["ProductCompanyKey"])].copy()
        if not extra.empty:
            extra["ProductKey"] = extra["ProductKey"].astype("string")
            catalog = dim_product if dim_product is not None else pd.DataFrame()
            attrs = [c for c in self.PRODUCT_ATTRS if c != "ProductKey"]
            if not catalog.empty:
                by_key = catalog.drop_duplicates("ProductKey")
                by_key = by_key.set_index(by_key["ProductKey"].astype("string").to_numpy())
                for c in attrs:
                    if c in by_key.columns:
                        extra[c] = extra["ProductKey"].map(by_key[c])
            for c in attrs:
                if c not in extra.columns:
                    extra[c] = pd.NA
            if not self.on_hand_all.empty:
                held = self.on_hand_all.groupby("ProductCompanyKey")[["OnHandQty", "OnHandValue"]].sum()
                names = self.on_hand_all.drop_duplicates("ProductCompanyKey").set_index("ProductCompanyKey")["ProductName"]
                extra["ProductName"] = extra["ProductName"].where(extra["ProductName"].notna(), extra["ProductCompanyKey"].map(names))
                extra["OnHandQty"] = extra["ProductCompanyKey"].map(held["OnHandQty"])
                extra["OnHandValue"] = extra["ProductCompanyKey"].map(held["OnHandValue"])
            for c in ("OnHandQty", "OnHandValue"):
                extra[c] = pd.to_numeric(extra[c], errors="coerce").fillna(0.0) if c in extra.columns else 0.0
            for c in odoo_products.ATTRIBUTE_FIELDS:
                if c in extra.columns:
                    extra[c] = extra[c].where(extra[c].notna(), odoo_products.UNASSIGNED)
            extra["IsActive"] = extra["IsActive"].map(lambda v: pd.NA if v is None or (not isinstance(v, bool) and pd.isna(v)) else int(bool(v)))
            extra["ThresholdCompany"] = extra["Company"]
            extra["AsOfDate"] = self.as_of
            extra["OnProductPages"] = 0
            extra = extra.drop(columns=[c for c in ("pid", "Archived", "ExcludedByProduct", "ExcludedByCategory", "ExclusionRule") if c in extra.columns])
            out = pd.concat([pages, extra], ignore_index=True)
        else:
            out = pages
        info = keys.drop_duplicates("ProductCompanyKey").set_index("ProductCompanyKey")
        key = out["ProductCompanyKey"]
        out["OdooProductID"] = key.map(info["pid"]).astype("Int64")
        if "ExclusionRule" in info.columns:
            out["ExclusionRule"] = key.map(info["ExclusionRule"])
        for column in ("ExcludedByProduct", "ExcludedByCategory"):
            out[column] = key.map(info[column]).eq(True).astype("int64")
        excluded = out["ExcludedByProduct"].eq(1) | out["ExcludedByCategory"].eq(1)
        archived = key.map(info["Archived"]).eq(True)
        active = key.astype(str).isin(self.sold_last_12m) & out["OnProductPages"].eq(1)
        out["ProductStatus"] = product_status(excluded, archived, active)
        log.info("Product pages: Odoo SKU counts as of %s: %s", self.as_of.date(), self._sku_counts())
        return out

    def _daily(self, lines: pd.DataFrame) -> pd.DataFrame:
        sums = ["Value", "Qty", "QtyOrdered", "QtyDelivered", "CostValue", "CostedQty", "UncostedQty", "Lines"]
        daily = lines.groupby(self.DAILY_GRAIN, dropna=False, as_index=False)[sums].sum()
        return daily.reset_index(drop=True)

    @staticmethod
    def assert_totals_preserved(before: pd.DataFrame, after: pd.DataFrame) -> None:
        """The product aggregation must not create or lose value, quantity or lines."""
        for column in ["Value", "Qty", "Lines"]:
            a = float(before[column].sum())
            b = float(after[column].sum())
            if abs(a - b) > 0.005:
                raise AssertionError(f"Fact_ProductSalesDaily {column} total {b} != Fact_SalesLines total {a}")

    # ------------------------------------------------------------------ stock
    STOCK_COLUMNS = ["StockQty", "StockValue", "InTransitQty", "InTransitValue", "NegativeStockRows", "NegativeStockQty",
                     "OnHandQty", "OnHandValue", "StockAgeDays", "StockAgeOldestDays", "StockAgeSource"]

    def aging_bucket_keys(self) -> list[str]:
        return [str(b["key"]) for b in self.config.section("stock").get("aging_buckets", [])]

    def aging_bucket_columns(self) -> list[str]:
        keys = self.aging_bucket_keys()
        return [f"AgeQty_{k}" for k in keys] + [f"AgeValue_{k}" for k in keys]

    def _stock(self, fact_inventory: pd.DataFrame, valuation_layers: pd.DataFrame | None = None) -> pd.DataFrame:
        """Per Company + product, from the internal-location quants of the inventory snapshot:
          StockQty / StockValue      finished goods on hand (negative quants count as 0): DOH, stock band, ISR (unchanged)
          InTransitQty / Value       the in-transit warehouses (unchanged)
          OnHandQty / OnHandValue    Odoo's On Hand (2026-11-10): SUM(quantity) / SUM(value) of EVERY quant of the company in
                                     an internal location (stock.quant, location usage = internal; transit, customer,
                                     supplier, inventory-loss and virtual locations are not internal), negatives included --
                                     the number on Odoo's On Hand button for that company. The one On Hand of every page.
          StockAge*, AgeQty_* / AgeValue_*  Stock Aging of the On Hand units (_aging).
        Products listed = those with finished-goods or in-transit quants (as before); a raw-materials-only product is not
        a Product-page row."""
        cols = ["ProductCompanyKey"] + self.STOCK_COLUMNS + self.aging_bucket_columns()
        self.on_hand_all = pd.DataFrame()
        if fact_inventory is None or fact_inventory.empty or "ProductCompanyKey" not in fact_inventory.columns:
            return pd.DataFrame(columns=cols + ["Company", "ProductKey", "ProductName", "OdooProductName"])
        inv = fact_inventory.copy()
        qty = pd.to_numeric(inv["OnHandQty"], errors="coerce").fillna(0.0)
        value = pd.to_numeric(inv["InventoryValue"], errors="coerce").fillna(0.0)
        positive = qty.gt(0)
        stock_class = inv["StockClass"].astype("string")
        fg = stock_class.eq("FinishedGoods")
        transit = stock_class.eq("InTransit")
        listed = fg | transit
        work = pd.DataFrame({
            "ProductCompanyKey": inv["ProductCompanyKey"].astype("string"),
            "Company": inv["Company"].map(normalize_match_company),
            "ProductKey": inv["ProductKey"].astype("string"),
            "ProductName": inv["ProductName"].astype(object),
            "OdooProductName": inv["OdooProductName"].astype(object),
            # Negative quants count as 0 on hand (and are listed in QA_ProductDataQuality).
            "StockQty": qty.where(fg & positive, 0.0),
            "StockValue": value.where(fg & positive, 0.0),
            "InTransitQty": qty.where(transit & positive, 0.0),
            "InTransitValue": value.where(transit & positive, 0.0),
            "NegativeStockRows": (listed & ~positive & qty.lt(0)).astype(int),
            "NegativeStockQty": qty.where(listed & qty.lt(0), 0.0),
            "OnHandQty": qty,
            "OnHandValue": value,
            "Listed": listed,
        })
        in_date = pd.to_datetime(inv["InDate"], errors="coerce") if "InDate" in inv.columns else pd.Series(pd.NaT, index=inv.index)
        work["InDate"] = in_date.where(positive)
        stock = work.groupby("ProductCompanyKey", as_index=False).agg(
            Company=("Company", "first"),
            ProductKey=("ProductKey", "first"),
            ProductName=("ProductName", "first"),
            OdooProductName=("OdooProductName", "first"),
            StockQty=("StockQty", "sum"),
            StockValue=("StockValue", "sum"),
            InTransitQty=("InTransitQty", "sum"),
            InTransitValue=("InTransitValue", "sum"),
            NegativeStockRows=("NegativeStockRows", "sum"),
            NegativeStockQty=("NegativeStockQty", "sum"),
            OnHandQty=("OnHandQty", "sum"),
            OnHandValue=("OnHandValue", "sum"),
            Listed=("Listed", "any"),
        )
        self.on_hand_all = stock[["ProductCompanyKey", "Company", "ProductKey", "ProductName", "OnHandQty", "OnHandValue"]].copy()
        stock = stock[stock["Listed"]].drop(columns=["Listed"])
        return self._aging(stock, work, valuation_layers)

    def aging_layers(self, stock: pd.DataFrame, quants: pd.DataFrame, valuation_layers: pd.DataFrame | None) -> pd.DataFrame:
        """The receipt layers of each product's On Hand units: one row per layer (ProductCompanyKey, LayerDate, Qty, Value,
        Source).

        Source (2026-11-10): Odoo stock.valuation.layer with remaining_qty > 0 -- the receipts whose units are still in
        stock (Odoo consumes them first in, first out for AVCO and FIFO products, the costing of almost every category),
        received on the layer's create_date. Their units match the On Hand units for ~99% of products; they are scaled to
        the On Hand units and the On Hand value is split by the same shares, so the buckets always add up to On Hand.
        A product with stock but no open layer (standard-cost categories) falls back to its quants' in_date. in_date alone
        overstates the age: Odoo keeps the OLDEST incoming date when new stock is added to an existing quant."""
        on_hand = stock.set_index("ProductCompanyKey")
        with_stock = set(on_hand.index[on_hand["OnHandQty"].gt(0)])
        columns = ["ProductCompanyKey", "LayerDate", "Qty", "Value", "Source"]
        frames = []
        if valuation_layers is not None and not valuation_layers.empty:
            lay = valuation_layers[valuation_layers["ProductCompanyKey"].isin(with_stock)].copy()
            lay["Qty"] = pd.to_numeric(lay["RemainingQty"], errors="coerce")
            lay["Value"] = pd.to_numeric(lay["RemainingValue"], errors="coerce").fillna(0.0)
            lay["LayerDate"] = pd.to_datetime(lay["LayerDate"], errors="coerce").dt.normalize()
            lay["Source"] = "layers"
            lay = lay[lay["Qty"].gt(0) & lay["LayerDate"].notna()]
            if not lay.empty:
                frames.append(lay[columns])
        covered = set(frames[0]["ProductCompanyKey"]) if frames else set()
        q = quants[quants["ProductCompanyKey"].isin(with_stock - covered) & quants["OnHandQty"].gt(0) & quants["InDate"].notna()]
        if not q.empty:
            frames.append(pd.DataFrame({"ProductCompanyKey": q["ProductCompanyKey"], "LayerDate": pd.to_datetime(q["InDate"]).dt.normalize(),
                                        "Qty": q["OnHandQty"], "Value": q["OnHandValue"], "Source": "quant_in_date"}))
        if not frames:
            return pd.DataFrame(columns=columns)
        out = pd.concat(frames, ignore_index=True)
        total_qty = out.groupby("ProductCompanyKey")["Qty"].transform("sum")
        share = out["Qty"].div(total_qty.where(total_qty > 0))
        out["Qty"] = share * out["ProductCompanyKey"].map(on_hand["OnHandQty"])
        out["Value"] = share * out["ProductCompanyKey"].map(on_hand["OnHandValue"])
        return out

    def _aging(self, stock: pd.DataFrame, quants: pd.DataFrame, valuation_layers: pd.DataFrame | None) -> pd.DataFrame:
        """Stock Aging of the On Hand units at the as-of date (the ETL run's business date = today):
          StockAgeDays        units-weighted average age of the remaining layers: SUM(qty x (as-of - receipt)) / SUM(qty)
          StockAgeOldestDays  age of the oldest remaining layer
          StockAgeSource      'layers' (stock.valuation.layer) or 'quant_in_date' (fallback, see aging_layers)
          AgeQty_<b> / AgeValue_<b>  On Hand units / value per aging bucket (config stock.aging_buckets), split by layer
        On Hand <= 0 -> no aging (null) and 0 in every bucket."""
        keys = self.aging_bucket_keys()
        layers = self.aging_layers(stock, quants, valuation_layers)
        layers["Age"] = (self.as_of - pd.to_datetime(layers["LayerDate"])).dt.days.clip(lower=0).astype(float)
        layers["Bucket"] = self.aging_bucket(layers["Age"], key=True)
        layers["W"] = layers["Qty"] * layers["Age"]
        g = layers.groupby("ProductCompanyKey")
        qty_sum = g["Qty"].sum()
        aging = pd.DataFrame({
            "StockAgeDays": g["W"].sum().div(qty_sum.where(qty_sum > 0)),
            "StockAgeOldestDays": g["Age"].max(),
            "StockAgeSource": g["Source"].first(),
        })
        for metric in ("Qty", "Value"):
            by_bucket = layers.groupby(["ProductCompanyKey", "Bucket"])[metric].sum().unstack(fill_value=0.0) if not layers.empty else pd.DataFrame()
            for k in keys:
                aging[f"Age{metric}_{k}"] = by_bucket[k] if k in by_bucket.columns else 0.0
        out = stock.merge(aging, left_on="ProductCompanyKey", right_index=True, how="left")
        has_stock = out["OnHandQty"].gt(0)
        for c in ["StockAgeDays", "StockAgeOldestDays", "StockAgeSource"]:
            out[c] = out[c].where(has_stock)
        for c in self.aging_bucket_columns():
            out[c] = pd.to_numeric(out[c], errors="coerce").fillna(0.0).where(has_stock, 0.0)
        return out

    # ------------------------------------------------------------------ product snapshot
    def _window_sum(self, lines: pd.DataFrame, start: pd.Timestamp, end: pd.Timestamp, column: str) -> pd.Series:
        mask = lines["OrderDate"].between(start, end)
        return lines.loc[mask].groupby("ProductCompanyKey")[column].sum()

    def _products(self, lines: pd.DataFrame, dim_product: pd.DataFrame, stock: pd.DataFrame) -> pd.DataFrame:
        cols = ["ProductCompanyKey", "Company", "ProductKey", "ProductName", "OdooProductName"]
        seen = pd.concat([lines[cols], stock[cols] if not stock.empty else pd.DataFrame(columns=cols)], ignore_index=True)
        catalog = dim_product.copy() if dim_product is not None else pd.DataFrame()
        if not catalog.empty and "ProductCompany" in catalog.columns:
            own = catalog[catalog["IsActive"].fillna(False).astype(bool) & catalog["ProductCompany"].notna()].copy()
            own["Company"] = own["ProductCompany"].map(normalize_match_company)
            own = own[own["Company"].isin(set(lines["Company"].dropna()))]
            own["ProductKey"] = own["ProductKey"].astype("string")
            own["ProductCompanyKey"] = odoo_products.product_company_keys(own["Company"], own["ProductKey"])
            seen = pd.concat([seen, own[cols]], ignore_index=True)
        base = seen.dropna(subset=["ProductCompanyKey"]).drop_duplicates("ProductCompanyKey").copy()
        base = base[~base["ProductCompanyKey"].isin(self.excluded_product_keys)]
        # Odoo's attributes by product id; a product missing from the catalog keeps the name its lines carry
        attrs = [c for c in self.PRODUCT_ATTRS if c not in ("ProductKey",)]
        if not catalog.empty:
            by_key = catalog.drop_duplicates("ProductKey").set_index(catalog.drop_duplicates("ProductKey")["ProductKey"].astype("string").to_numpy())
            found = base["ProductKey"].astype("string").isin(by_key.index)
            for c in attrs:
                if c in by_key.columns:
                    mapped = base["ProductKey"].astype("string").map(by_key[c])
                    base[c] = mapped.where(found, base[c] if c in base.columns else pd.NA)
        for c in attrs:
            if c not in base.columns:
                base[c] = pd.NA
        for c in odoo_products.ATTRIBUTE_FIELDS:
            base[c] = base[c].where(base[c].notna(), odoo_products.UNASSIGNED)
        base["IsActive"] = base["IsActive"].map(lambda v: pd.NA if v is None or (not isinstance(v, bool) and pd.isna(v)) else int(bool(v)))
        base = base.set_index("ProductCompanyKey")
        base["ThresholdCompany"] = base["Company"]
        return self._snapshot(base, lines, stock)

    def _snapshot(self, base: pd.DataFrame, lines: pd.DataFrame, stock: pd.DataFrame) -> pd.DataFrame:
        """Sales history, stock, days of inventory, stock band, lifecycle and BCG for `base` (indexed by
        the key that `lines` and `stock` carry in their ProductCompanyKey column)."""
        today = self.as_of
        base.index.name = "ProductCompanyKey"
        # Sales history
        g = lines.groupby("ProductCompanyKey")
        base["FirstSaleDate"] = g["OrderDate"].min()
        base["LastSaleDate"] = g["OrderDate"].max()
        uoms = lines[lines["UoM"].ne("")].groupby("ProductCompanyKey")["UoM"].agg(lambda v: sorted(set(v)))
        base["UoM"] = uoms.map(lambda v: v[0] if len(v) == 1 else None)
        base["UoMCount"] = uoms.map(len)
        base["UoMList"] = uoms.map(lambda v: " | ".join(v))

        lookback = self.config.lookback_days
        start_lb = today - pd.Timedelta(days=lookback - 1)
        base["QtyLookback"] = self._window_sum(lines, start_lb, today, "Qty")
        base["AvgDailySales"] = base["QtyLookback"].fillna(0.0) / float(lookback)

        # Stock + days of inventory
        bucket_cols = self.aging_bucket_columns()
        base = base.join(stock.set_index("ProductCompanyKey").reindex(columns=self.STOCK_COLUMNS + bucket_cols), how="left")
        for c in ["StockQty", "StockValue", "InTransitQty", "InTransitValue", "NegativeStockQty", "QtyLookback", "OnHandQty", "OnHandValue", *bucket_cols]:
            base[c] = pd.to_numeric(base[c], errors="coerce").fillna(0.0)
        base["NegativeStockRows"] = pd.to_numeric(base["NegativeStockRows"], errors="coerce").fillna(0).astype(int)
        base["DaysOfInventory"] = base["StockQty"].div(base["AvgDailySales"].where(base["AvgDailySales"] > 0))
        base["StockBand"] = self._stock_band(base)
        base["StockAgeDays"] = pd.to_numeric(base["StockAgeDays"], errors="coerce").where(base["OnHandQty"] > 0)
        base["StockAgeOldestDays"] = pd.to_numeric(base["StockAgeOldestDays"], errors="coerce").where(base["OnHandQty"] > 0)
        base["StockAgeSource"] = base["StockAgeSource"].where(base["OnHandQty"] > 0)
        base["StockAgeBucket"] = self.aging_bucket(base["StockAgeDays"])

        # Lifecycle
        base["LifecycleSegment"] = self._lifecycle(base, lines)

        # BCG (last 12 months and the 12 months before)
        base = base.join(self._bcg(lines, base), how="left")
        base = base.reset_index()
        base["AsOfDate"] = today
        for c in ["FirstSaleDate", "LastSaleDate"]:
            base[c] = pd.to_datetime(base[c], errors="coerce")
        return base

    def aging_bucket(self, age_days: pd.Series, key: bool = False) -> pd.Series:
        """Stock Aging bucket label (key=True: its key) of each age (config stock.aging_buckets: ages up to max_days;
        null = no upper limit)."""
        buckets = self.config.section("stock").get("aging_buckets", [])
        out = pd.Series(pd.NA, index=age_days.index, dtype="object")
        free = age_days.notna()
        for b in buckets:
            limit = b.get("max_days")
            hit = free & (age_days.le(float(limit)) if limit is not None else True)
            out[hit] = b["key"] if key else b["label"]
            free &= ~hit
        return out

    def _stock_band(self, p: pd.DataFrame) -> pd.Series:
        over = self.config.per_company("days_of_inventory", "overstock_days")
        risk = self.config.per_company("days_of_inventory", "stockout_risk_days")
        company = p["ThresholdCompany"].astype("string")
        over_t = company.map(over)
        risk_t = company.map(risk)
        doh = p["DaysOfInventory"]
        stock = p["StockQty"]
        return pd.Series(np.select(
            [
                stock.gt(0) & p["AvgDailySales"].le(0),          # stock, no sales in look-back
                stock.le(0) & p["AvgDailySales"].le(0),
                doh.gt(over_t),
                doh.lt(risk_t),
            ],
            ["NoMovement", "NoStockNoSales", "Overstock", "StockOutRisk"],
            default="Normal",
        ), index=p.index)

    def _lifecycle(self, p: pd.DataFrame, lines: pd.DataFrame) -> pd.Series:
        cfg = self.config.section("lifecycle")
        today = self.as_of
        window = int(cfg.get("trend_window_days", 90))
        growth = float(cfg.get("growth_threshold_pct", 20)) / 100.0
        new_days = int(cfg.get("new_first_sale_within_days", 180))
        dead_days = int(cfg.get("discontinued_no_sales_days", 365))
        last_start = today - pd.Timedelta(days=window - 1)
        prev_end = last_start - pd.Timedelta(days=1)
        prev_start = prev_end - pd.Timedelta(days=window - 1)
        last_qty = self._window_sum(lines, last_start, today, "Qty").reindex(p.index).fillna(0.0)
        prev_qty = self._window_sum(lines, prev_start, prev_end, "Qty").reindex(p.index).fillna(0.0)
        first = pd.to_datetime(p["FirstSaleDate"], errors="coerce")
        last = pd.to_datetime(p["LastSaleDate"], errors="coerce")
        # A product with no sale in the whole history is its own segment, never Discontinued.
        never_sold = first.isna() & last.isna()
        no_recent = last.lt(today - pd.Timedelta(days=dead_days - 1))
        is_new = first.notna() & first.ge(today - pd.Timedelta(days=new_days - 1))
        change = (last_qty - prev_qty).div(prev_qty.where(prev_qty > 0))
        return pd.Series(np.select(
            [
                never_sold,
                no_recent,
                is_new,
                prev_qty.le(0) & last_qty.gt(0),
                change.gt(growth),
                change.lt(-growth),
            ],
            ["Never sold", "Discontinued", "New", "Growing", "Growing", "Declining"],
            default="Mature",
        ), index=p.index)

    def _bcg(self, lines: pd.DataFrame, products: pd.DataFrame) -> pd.DataFrame:
        cfg = self.config.section("bcg")
        vol_t = self.config.per_company("bcg", "volume_threshold")
        profit_t = float(cfg.get("profit_threshold_pct", 35)) / 100.0
        # The *YTD columns hold the LAST 12 MONTHS and the *LYTD columns the 12 months before (2026-11-14; the column
        # names are kept so the table schema does not change).
        out = pd.DataFrame(index=products.index)
        for label, (start, end) in (("YTD", get_last_12m_range(self.as_of)), ("LYTD", get_prior_12m_range(self.as_of))):
            window = lines[lines["OrderDate"].between(start, end)]
            g = window.groupby("ProductCompanyKey")[["Value", "Qty", "CostValue", "UncostedQty", "Lines"]].sum().reindex(products.index).fillna(0.0)
            out[f"Value{label}"] = g["Value"]
            out[f"Qty{label}"] = g["Qty"]
            has_sales = g["Lines"].gt(0)
            no_cost = has_sales & g["UncostedQty"].gt(0)
            gp = (g["Value"] - g["CostValue"]).div(g["Value"].where(g["Value"] != 0))
            out[f"GrossProfitPct{label}"] = (gp * 100).where(has_sales & ~no_cost)
            vclass = np.where(g["Qty"] >= products["ThresholdCompany"].map(vol_t).fillna(np.inf), "HV", "LV")
            pclass = np.where(gp >= profit_t, "HP", "LP")
            code = pd.Series(vclass, index=products.index) + "/" + pd.Series(pclass, index=products.index)
            cls = code.map(BCG_BY_CODE)
            cls = cls.where(~no_cost, UNCLASSIFIED_NO_COST).where(has_sales, None)
            out[f"BcgClass{label}"] = cls
            out[f"NoCost{label}"] = no_cost
        # Excluded categories are dropped from every Product table before this (ProductExclusions.xlsx); the column stays
        # for the table schema and the API, always False.
        out["BcgExcludedCategory"] = False
        out["BcgMovement"] = self._movement(out, products)
        return out

    def _movement(self, b: pd.DataFrame, products: pd.DataFrame) -> pd.Series:
        """Product Movement, on VOLUME: invoiced quantity of the last 12 months vs the 12 months before (QtyYTD vs QtyLYTD,
        which hold those two windows since 2026-11-14),
        for every product sold in either period. In this order:
          Discontinued  no sale in the last lifecycle.discontinued_no_sales_days (365) days -- the Product Lifecycle rule
                        (2026-11-15; archived products are Dormant and never on the Product pages)
          New           first sale within lifecycle.new_first_sale_within_days, or nothing sold in the prior 12 months
          Improved      volume growth > +bcg.movement_stable_band_pct
          Drop          volume growth < -band (sold in the prior 12 months and nothing in the last 12, still active, is -100%)
          Stable        within +-band, or no positive volume in either period (returns only)
        Never sold, or not sold in either period but sold within the no-sales window -> no movement (None)."""
        band = float(self.config.section("bcg").get("movement_stable_band_pct", 10))
        new_days = int(self.config.section("lifecycle").get("new_first_sale_within_days", 180))
        qty_y = pd.to_numeric(b["QtyYTD"], errors="coerce").fillna(0.0)
        qty_l = pd.to_numeric(b["QtyLYTD"], errors="coerce").fillna(0.0)
        sold = b["BcgClassYTD"].notna() | b["BcgClassLYTD"].notna()
        first = pd.to_datetime(products["FirstSaleDate"], errors="coerce")
        is_new_product = first.notna() & first.ge(self.as_of - pd.Timedelta(days=new_days - 1))
        dead_days = int(self.config.section("lifecycle").get("discontinued_no_sales_days", 365))
        last = pd.to_datetime(products["LastSaleDate"], errors="coerce") if "LastSaleDate" in products.columns else pd.Series(pd.NaT, index=b.index)
        discontinued = last.notna() & last.lt(self.as_of - pd.Timedelta(days=dead_days - 1))
        growth = (qty_y - qty_l).div(qty_l.where(qty_l > 0)) * 100
        return pd.Series(np.select(
            [
                discontinued,
                is_new_product | (qty_l.le(0) & qty_y.gt(0)),
                growth.gt(band),
                growth.lt(-band),
            ],
            ["Discontinued", "New", "Improved", "Drop"],
            default="Stable",
        ), index=b.index).where(sold | discontinued, None)

    # ------------------------------------------------------------------ logs
    def odoo_gaps(self, lines: pd.DataFrame, products: pd.DataFrame) -> pd.DataFrame:
        """Every product sold (any date) that has no Brand, Family, Size or SKU in Odoo, per company, largest sales
        first: the list to fill in Odoo. One row per Company + Odoo product."""
        sold = lines[lines["ProductKey"].astype(str).ne(odoo_products.UNKNOWN_PRODUCT_KEY)]
        if sold.empty or products.empty:
            return pd.DataFrame(columns=GAP_COLUMNS)
        start_12m, _ = get_last_12m_range(self.as_of)
        g = sold.groupby("ProductCompanyKey")
        totals = pd.DataFrame({
            "SalesValue": g["Value"].sum(),
            "Lines": g["Lines"].sum(),
        })
        totals["SalesValueLast12M"] = sold[sold["OrderDate"].between(start_12m, self.as_of)].groupby("ProductCompanyKey")["Value"].sum()
        p = products.set_index("ProductCompanyKey").join(totals, how="inner")
        missing = pd.DataFrame({
            a: (p[a].isna() | p[a].astype(str).eq(odoo_products.UNASSIGNED)) if a in p.columns else True for a in GAP_ATTRIBUTES
        }, index=p.index)
        p = p[missing.any(axis=1)].copy()
        if p.empty:
            return pd.DataFrame(columns=GAP_COLUMNS)
        p["Missing"] = missing.loc[p.index].apply(lambda r: ", ".join(a for a in GAP_ATTRIBUTES if r[a]), axis=1)
        p["OdooProductID"] = pd.to_numeric(p["ProductKey"], errors="coerce").astype("Int64")
        p["SalesValueLast12M"] = p["SalesValueLast12M"].fillna(0.0)
        p["AsOfDate"] = self.as_of
        out = p.reset_index()[GAP_COLUMNS]
        return out.sort_values(["SalesValue", "SalesValueLast12M", "OdooProductID"], ascending=[False, False, True]).reset_index(drop=True)

    def _data_quality(self, products: pd.DataFrame, fact_inventory: pd.DataFrame, lines: pd.DataFrame) -> pd.DataFrame:
        rows: list[dict[str, Any]] = []
        if fact_inventory is not None and not fact_inventory.empty:
            inv = fact_inventory[pd.to_numeric(fact_inventory["OnHandQty"], errors="coerce").lt(0)]
            for _, r in inv.iterrows():
                rows.append({"Check": "NegativeStock", "Company": normalize_match_company(r.get("Company")), "ProductCompanyKey": r.get("ProductCompanyKey"),
                             "ProductName": r.get("ProductName"), "Detail": f"{r.get('LocationName')}: on hand {float(r['OnHandQty']):,.2f} (counted as 0)",
                             "Qty": float(r["OnHandQty"]), "Value": float(pd.to_numeric(r.get("InventoryValue"), errors="coerce") or 0.0)})
        for _, r in products[products["NoCostYTD"].fillna(False)].iterrows():
            rows.append({"Check": "NoCost", "Company": r["Company"], "ProductCompanyKey": r["ProductCompanyKey"], "ProductName": r["ProductName"],
                         "Detail": "Sold in the last 12 months without a standard cost in Odoo -> BCG 'Unclassified (no cost)'",
                         "Qty": float(r["QtyYTD"]), "Value": float(r["ValueYTD"])})
        for _, r in products[pd.to_numeric(products["UoMCount"], errors="coerce").fillna(0).gt(1)].iterrows():
            rows.append({"Check": "MixedUoM", "Company": r["Company"], "ProductCompanyKey": r["ProductCompanyKey"], "ProductName": r["ProductName"],
                         "Detail": f"Sold in several units of measure: {r['UoMList']} -- quantities are never summed across them",
                         "Qty": None, "Value": None})
        out = pd.DataFrame(rows, columns=["Check", "Company", "ProductCompanyKey", "ProductName", "Detail", "Qty", "Value"])
        out["AsOfDate"] = self.as_of
        return out

    def _meta(self, lines: pd.DataFrame, daily: pd.DataFrame, products: pd.DataFrame) -> pd.DataFrame:
        return pd.DataFrame([{
            "AsOfDate": self.as_of,
            # Whole seconds: MySQL DATETIME rounds fractional seconds, so .5s+ read back one second later and
            # failed the SQL/DataFrame mirror validation about every other run.
            "BuiltAtUtc": pd.Timestamp.now(tz="UTC").tz_localize(None).floor("s"),
            "ConfigFingerprint": self.config.fingerprint,
            "ConfigJson": json.dumps(self.config.raw, ensure_ascii=False),
            "LookbackDays": self.config.lookback_days,
            "SalesLinesValue": float(lines["Value"].sum()),
            "SalesLinesQty": float(lines["Qty"].sum()),
            "SalesLinesCount": int(len(lines)),
            "DailyValue": float(daily["Value"].sum()),
            "Products": int(len(products)),
            "UnassignedBrandProducts": int(products["Brand"].astype(str).eq(odoo_products.UNASSIGNED).sum()),
            "UnassignedCategoryProducts": int(products["Category"].astype(str).eq(odoo_products.UNASSIGNED).sum()),
        }])
