"""Company + product-name matching rules shared by every place the ETL joins Odoo lines to PRODUCTS.xlsx.

One product = one (Company, normalized Odoo product name). Names are never matched across companies:
the same Odoo name can exist in both Majaal and Tika (e.g. Majaal "Cemair" vs Tika "Cem Air"), and a
name-only join is exactly what attached 9M LYD of Tika sales to Majaal products before this module.

Name normalization (agreed rule, nothing more):
  1. NBSP, tabs, CR/LF -> space
  2. strip ONE leading "[code] " prefix -- sale.report / stock.quant give Odoo's display_name
     ("[GRVS-010] GROUT CREMA - C02"), the sheet holds the product name
  3. collapse repeated whitespace, trim
  4. uppercase
"""

from __future__ import annotations

import re
from typing import Any

import pandas as pd

_WHITESPACE_CHARS = re.compile(r"[ \t\r\n]")
_CODE_PREFIX = re.compile(r"^\s*\[[^\]]*\]\s*")
_MULTI_SPACE = re.compile(r"\s+")

MAJAAL = "Majaal"
TIKA = "Tika"
KNOWN_COMPANIES = (MAJAAL, TIKA)


def normalize_match_name(value: Any) -> str:
    if value is None or (not isinstance(value, str) and pd.isna(value)):
        return ""
    text = _WHITESPACE_CHARS.sub(" ", str(value))
    text = _CODE_PREFIX.sub("", text, count=1)
    return _MULTI_SPACE.sub(" ", text).strip().upper()


def normalize_match_company(value: Any) -> str:
    """Odoo company names ('Majaal', 'TIKA') and sheet values ('Majaal', 'Tika') -> 'Majaal' / 'Tika'.

    Anything else is returned trimmed as-is so it can never silently match a known company.
    """
    if value is None or (not isinstance(value, str) and pd.isna(value)):
        return ""
    text = _MULTI_SPACE.sub(" ", str(value)).strip()
    upper = text.upper()
    if upper == "MAJAAL":
        return MAJAAL
    if upper == "TIKA":
        return TIKA
    return text


def match_key(company: Any, name: Any) -> str:
    return f"{normalize_match_company(company).upper()}|{normalize_match_name(name)}"


def group_key(product_name: Any) -> str:
    """Cross-company grouping key for the Product pages' BMH view: the sheet's ProductName, normalized
    like a match name ([code] prefix, spacing, case). Matching itself stays Company + Odoo name."""
    name = normalize_match_name(product_name)
    return f"G|{name}" if name else ""


_NON_ALNUM = re.compile(r"[\W_]+")


def loose_name_key(product_name: Any) -> str:
    """normalize_match_name without spaces or punctuation: 'Cem Air' and 'CemAir' give the same key.
    Only used to WARN about names that probably mean the same product; never to group or match."""
    return _NON_ALNUM.sub("", normalize_match_name(product_name))


def match_key_series(company: pd.Series, name: pd.Series) -> pd.Series:
    """Vectorised match_key; normalizes each distinct value once (names repeat thousands of times)."""
    # NA -> "" first: NaN never equals itself, so it can't be a dict key for .map().
    company_s = company.astype("object").where(company.notna(), "").astype(str)
    name_s = name.astype("object").where(name.notna(), "").astype(str)
    company_map = {v: normalize_match_company(v).upper() for v in pd.unique(company_s)}
    name_map = {v: normalize_match_name(v) for v in pd.unique(name_s)}
    keys = company_s.map(company_map).astype("string") + "|" + name_s.map(name_map).astype("string")
    return keys.astype("string")
