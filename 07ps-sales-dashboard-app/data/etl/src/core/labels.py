"""Odoo's own display labels for selection fields -> dim_odoo_selection_label (every department).

Rule (docs/adding-a-department.md, "Odoo labels"): display labels of Odoo selection fields are never written in code.
They are read from Odoo with fields_get(attributes=["string", "selection"]) in every active language we keep
(en_US always; Arabic when an ar* language is active in res.lang) and stored with the technical value. Facts keep
the technical value only; views and pages join this dimension for the label.

To label a new selection field, add it to SELECTION_FIELDS; the next core_dims run loads its labels.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

import pandas as pd

SELECTION_FIELDS: dict[str, tuple[str, ...]] = {
    "account.move": ("move_type", "state", "payment_state"),
    "account.payment": ("payment_type", "partner_type", "state"),
    "sale.order": ("state", "delivery_status", "invoice_status"),
    "stock.picking": ("state", "picking_type_code"),
    "crm.lead": ("type",),
}
ENGLISH = "en_US"


def arabic_language(active: Sequence[str]) -> str | None:
    """The active Arabic language code (ar_001, ar_SY, ...), or None when Arabic is not active."""
    codes = sorted(c for c in active if c.lower().startswith("ar"))
    return codes[0] if codes else None


def build_labels(per_lang: Mapping[str, Mapping[str, Mapping[str, Any]]], english: str, arabic: str | None) -> pd.DataFrame:
    """per_lang: {lang: {model: fields_get result}} -> one row per (model, field, value)."""
    rows = []
    en = per_lang.get(english, {})
    ar = per_lang.get(arabic, {}) if arabic else {}
    for model, fields in en.items():
        for field, meta in fields.items():
            ar_meta = ar.get(model, {}).get(field, {})
            ar_sel = {str(v): label for v, label in (ar_meta.get("selection") or [])}
            for seq, (value, label) in enumerate(meta.get("selection") or []):
                rows.append({"model": model, "field": field, "value": str(value), "label_en": label,
                             "label_ar": ar_sel.get(str(value)) if arabic else None,
                             "field_label_en": meta.get("string"), "field_label_ar": ar_meta.get("string") if arabic else None,
                             "sequence": seq, "label_language_ar": arabic})
    return pd.DataFrame(rows, columns=["model", "field", "value", "label_en", "label_ar", "field_label_en", "field_label_ar",
                                       "sequence", "label_language_ar"])


def read_labels(source, fields: Mapping[str, Sequence[str]] = SELECTION_FIELDS) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Reads the labels from Odoo (read-only fields_get) in English and, when active, Arabic."""
    active = source.active_languages()
    arabic = arabic_language(active)
    langs = [ENGLISH] + ([arabic] if arabic else [])
    per_lang: dict[str, dict[str, Any]] = {lang: {} for lang in langs}
    skipped = []
    for model, wanted in fields.items():
        present, missing = source.available_fields(model, list(wanted))
        skipped += [f"{model}.{f}" for f in missing]
        for lang in langs:
            per_lang[lang][model] = source.field_labels(model, present, lang) if present else {}
    frame = build_labels(per_lang, ENGLISH, arabic)
    return frame, {"active_languages": active, "arabic": arabic, "labels": len(frame), "skipped_fields": skipped}
