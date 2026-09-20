from __future__ import annotations

import logging
from pathlib import Path
from typing import Union

import pandas as pd

PathLike = Union[str, Path]

logger = logging.getLogger(__name__)


class ProductMappingError(RuntimeError):
    """PRODUCTS.xlsx is missing, unreadable or lacks the mapping columns."""


class ProductNameMapper:
    """Applies Odoo product name aliases from PRODUCTS.xlsx to a Series.

    Reads the OdooProductName → ProductName mapping from the manual product
    master. Names that have no mapping pass through unchanged so every Odoo
    product row stays in the ETL regardless of master coverage.
    """

    def __init__(self, products_path: PathLike) -> None:
        self._mapping: dict[str, str] = {}
        path = Path(products_path)
        # A missing/unreadable master must fail loudly: silently mapping nothing would let every
        # product through under its raw Odoo name and corrupt the product dimension downstream.
        if not path.is_file():
            raise ProductMappingError(f"Product master not found: {path}")
        try:
            df = pd.read_excel(path)
        except Exception as exc:  # noqa: BLE001
            raise ProductMappingError(f"Product master {path} could not be read as an Excel workbook: {exc}") from exc
        df.columns = [str(c).strip() for c in df.columns]
        df = df.rename(columns={
            "Odoo Name": "OdooProductName",
            "Odoo Nmae": "OdooProductName",
            "OdooProduct Name": "OdooProductName",
        })
        missing = [c for c in ("OdooProductName", "ProductName") if c not in df.columns]
        if missing:
            raise ProductMappingError(
                f"Product master {path} has no {', '.join(missing)} column(s); found columns: {', '.join(df.columns)}"
            )
        pairs = df[["OdooProductName", "ProductName"]].dropna(subset=["OdooProductName", "ProductName"])
        for odoo_name, product_name in zip(pairs["OdooProductName"].astype(str), pairs["ProductName"].astype(str)):
            odoo_name = odoo_name.strip()
            product_name = product_name.strip()
            if odoo_name and product_name:
                self._mapping[odoo_name] = product_name
        if not self._mapping:
            # The file loaded fine but yields nothing -- legitimate only for a brand-new master, so warn.
            logger.warning("Product master %s loaded but contains 0 Odoo->clean name mappings", path)

    def mapping_count(self) -> int:
        return len(self._mapping)

    def apply_to_series(self, series: pd.Series) -> pd.Series:
        """Map Odoo product names to canonical names; unmapped values pass through."""
        return series.map(lambda v: self._mapping.get(str(v).strip(), v) if pd.notna(v) else v)
