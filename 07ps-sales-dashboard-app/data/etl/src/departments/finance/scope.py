"""Receivable scope -- the ONE place the rules are defined (dim_finance_receivable_scope is loaded from here).

Every open receivable line gets exactly one ``receivable_scope``, decided from Odoo's TECHNICAL values only:

  customer_debt      customer invoices, customer credit notes and receipts (account.move.move_type
                     out_invoice / out_refund / out_receipt), and inbound customer payments
                     (account.payment payment_type = inbound, partner_type = customer: "Receive / Customer");
  other_receivable   everything else on the receivable account: outbound customer payments ("Send / Customer":
                     personal withdrawals, salaries, custody...), journal entries with no invoice, vendor payments.

Inter-company is NOT a scope: it stays the separate ``is_intercompany`` flag (own companies' partners plus the
configured FINANCE_INTERCOMPANY_PARTNER_IDS), so a line can be inter-company in either scope.

The Debt page and the default views (v_finance_receivable_latest / _customer_exposure / _trend) show
customer_debt without inter-company. With every scope and inter-company included the totals are Odoo's Aged
Receivable. To change the rules, edit the sets below: the next run re-flags that day's snapshot; earlier snapshots
keep the scope they were loaded with. The labels are ours (not Odoo fields), in English and Arabic.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pandas as pd

CUSTOMER_DEBT = "customer_debt"
OTHER_RECEIVABLE = "other_receivable"


@dataclass(frozen=True)
class ReceivableScope:
    key: str
    label_en: str
    label_ar: str
    description: str
    is_default: bool  # shown by the Debt page and the default views


RECEIVABLE_SCOPES: tuple[ReceivableScope, ...] = (
    ReceivableScope(CUSTOMER_DEBT, "Customer debt", "ديون العملاء",
                    "Customer invoices, credit notes, receipts and inbound customer payments", True),
    ReceivableScope(OTHER_RECEIVABLE, "Other receivable entries", "قيود مدينة أخرى",
                    "Outbound customer payments, journal entries without an invoice, vendor payments", False),
)

# Odoo account.move.move_type values whose receivable lines are customer debt.
CUSTOMER_DEBT_MOVE_TYPES: frozenset[str] = frozenset({"out_invoice", "out_refund", "out_receipt"})
# Odoo account.payment (payment_type, partner_type) pairs whose receivable lines are customer debt.
CUSTOMER_DEBT_PAYMENTS: frozenset[tuple[str, str]] = frozenset({("inbound", "customer")})
# Anything matching no rule above.
DEFAULT_SCOPE = OTHER_RECEIVABLE


def _text(v: Any) -> str | None:
    if v is None or v is False or (not isinstance(v, str) and pd.isna(v)):
        return None
    return str(v)


def receivable_scope(move_type: Any, payment_type: Any = None, partner_type: Any = None) -> str:
    """Scope of one receivable line. A payment line is decided by its payment (its move is an 'entry');
    any other line by its move's move_type."""
    pt, prt = _text(payment_type), _text(partner_type)
    if pt is not None or prt is not None:
        return CUSTOMER_DEBT if (pt, prt) in CUSTOMER_DEBT_PAYMENTS else DEFAULT_SCOPE
    return CUSTOMER_DEBT if _text(move_type) in CUSTOMER_DEBT_MOVE_TYPES else DEFAULT_SCOPE


def validate_scopes(scopes: tuple[ReceivableScope, ...] = RECEIVABLE_SCOPES) -> None:
    keys = [s.key for s in scopes]
    if len(set(keys)) != len(keys) or {CUSTOMER_DEBT, OTHER_RECEIVABLE} - set(keys) or DEFAULT_SCOPE not in keys:
        raise ValueError("receivable scopes must be unique and include customer_debt, other_receivable and the default")


def scope_frame(scopes: tuple[ReceivableScope, ...] = RECEIVABLE_SCOPES) -> pd.DataFrame:
    return pd.DataFrame([{"receivable_scope": s.key, "label_en": s.label_en, "label_ar": s.label_ar, "description": s.description,
                          "is_default": int(s.is_default), "sort_order": i + 1} for i, s in enumerate(scopes)])
