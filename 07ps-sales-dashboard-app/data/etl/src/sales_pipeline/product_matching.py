"""Company-name normalization shared by the product layer.

Products are identified by their Odoo id only (sales_pipeline.odoo_products); this module no longer holds any
product-name rule. normalize_match_company maps Odoo company names ('Majaal', 'TIKA') to the names the pages use.
"""

from __future__ import annotations

import re
from typing import Any

import pandas as pd

_MULTI_SPACE = re.compile(r"\s+")

MAJAAL = "Majaal"
TIKA = "Tika"
ATHENA = "Athena"
KNOWN_COMPANIES = (MAJAAL, TIKA, ATHENA)


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
    if upper == "ATHENA":
        return ATHENA
    return text
