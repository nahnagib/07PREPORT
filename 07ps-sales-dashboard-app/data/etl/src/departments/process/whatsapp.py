"""NPS Score -- WhatsApp message reach (step 2, section 4): the ONLY place the reach rules and the error groups live.

Source: the NPS developer's table ``whatsapp_outbound_messages`` in the NPS MySQL database (live since 2026-10-18;
profiled 2026-10-19, docs/nps-etl.md "Message reach"). Odoo's ``whatsapp.message`` is NOT read. Columns::

    id BIGINT UNSIGNED PK, create_date DATETIME, company_name VARCHAR(100), template_name VARCHAR(255), state VARCHAR(30),
    mobile_number VARCHAR(40), failure_type VARCHAR(100), failure_reason TEXT, first_seen_at DATETIME, updated_at DATETIME

Switch: ``NPS_REACH_ENABLED`` (default false). When it is true, the job checks whether the table exists: if it does not,
it logs INFO and skips the dataset, leaving the ratings untouched.

Dates: ``create_date`` is UTC (a rating arrives a median of 11 minutes after its message; the ratings are UTC), converted
to Africa/Tripoli. ``first_seen_at`` / ``updated_at`` are the source server's clock (UTC+2) and are only copied.

Rules (the developer's weekly e-mail; configurable per environment, never hard-coded):
  NPS_REACH_TEMPLATE_MATCH     a feedback message = ``template_name`` contains this text (default "Feedback")
  NPS_REACH_EXCLUDED_NUMBERS   comma list of test numbers to leave out (compared on the last 9 digits); the number is
                               used here only and never stored outside the raw layer
  NPS_REACH_START              messages from this date on (yyyy-mm-dd, Tripoli); empty = all. Agreed value 2026-10-03:
                               before it the source holds only failed messages (successful ones were never kept)
The boxes: Delivered = state ``delivered``, Read = ``read``, Not Delivered = ``sent``, Error = ``error``; Total Reach =
every message in scope. Any other state is kept as it is and reported by a warning (to be placed with the business).
A failure text on a message that is not in state ``error`` is ignored (an older attempt; the message got through).

The error groups follow the developer's "WhatsApp Error Reference", confirmed against every failure value of the
2026-10-19 profile (tests/test_process_nps.py lists them).
"""

from __future__ import annotations

import datetime as _dt
import os
import re
from dataclasses import dataclass

import pandas as pd

BOX_STATES = {"delivered": "delivered", "read": "read", "sent": "not_delivered", "error": "error"}
NOT_AN_ERROR = "-"  # failure_group of a message that did not fail


@dataclass(frozen=True)
class FailureGroup:
    key: str
    label: str
    fixable: bool
    hint: str
    sort_order: int
    patterns: tuple[str, ...] = ()


# order matters: the first group whose pattern matches failure_type + " " + failure_reason wins; "other" catches the rest
FAILURE_GROUPS: tuple[FailureGroup, ...] = (
    FailureGroup("undeliverable_131026", "131026 Undeliverable", False,
                 "The number cannot receive the message (not on WhatsApp, old app version, or terms not accepted).", 1,
                 (r"\b131026\b", r"undeliverable")),
    FailureGroup("ecosystem_131049", "Meta held back (131049/130472)", False,
                 "Meta did not deliver the message (healthy ecosystem engagement, or the number is in a Meta experiment); "
                 "it may succeed later.", 2,
                 (r"\b131049\b", r"ecosystem", r"\b130472\b", r"part of an experiment")),
    FailureGroup("opted_out_131050", "Customer opted out of marketing (131050)", False,
                 "The customer chose to stop receiving marketing messages from the business on WhatsApp.", 3,
                 (r"\b131050\b", r"stop receiving marketing")),
    FailureGroup("template_quality", "Template quality too low", True,
                 "The template's quality rating is too low: improve the template text.", 4,
                 (r"quality",)),
    FailureGroup("phone_format", "Phone number missing or invalid", True,
                 "The customer has no valid mobile number: add or correct the phone number on the Odoo contact.", 5,
                 (r"phone", r"format", r"invalid (?:number|recipient)", r"\b131021\b")),
    FailureGroup("meta_temporary", "Meta temporary error", False,
                 "A temporary error on Meta's side; resending later usually works.", 6,
                 (r"temporar", r"try again", r"\bretry\b", r"whatsapp_recoverable", r"\b131000\b", r"\b130429\b", r"rate limit")),
    FailureGroup("other", "Other", False, "Any other failure value (e.g. 131047 re-engagement message).", 7),
)
_COMPILED = [(g, [re.compile(p, re.I) for p in g.patterns]) for g in FAILURE_GROUPS]


def validate_groups(groups: tuple[FailureGroup, ...] = FAILURE_GROUPS) -> None:
    keys = [g.key for g in groups]
    if len(set(keys)) != len(keys) or keys[-1] != "other" or groups[-1].patterns:
        raise ValueError("WhatsApp failure groups must have unique keys and end with the catch-all 'other'")


def failure_group(failure_type: object, failure_reason: object, state: object) -> str | None:
    """The error group of a message: None unless its state is ``error``."""
    if str(state or "").strip().lower() != "error":
        return None
    text = " ".join(str(v) for v in (failure_type, failure_reason) if v is not None and not (isinstance(v, float) and pd.isna(v)))
    for group, patterns in _COMPILED:
        if any(p.search(text) for p in patterns):
            return group.key
    return "other"


def group_frame() -> pd.DataFrame:
    """Rows of dim_process_nps_failure_group."""
    validate_groups()
    rows = [{"failure_group": g.key, "label_en": g.label, "is_fixable": int(g.fixable), "hint": g.hint, "sort_order": g.sort_order}
            for g in FAILURE_GROUPS]
    rows.append({"failure_group": NOT_AN_ERROR, "label_en": "Not an error", "is_fixable": 0, "hint": "The message did not fail.", "sort_order": 99})
    return pd.DataFrame(rows)


# -- configuration -------------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class ReachConfig:
    enabled: bool
    template_match: str
    excluded_numbers: tuple[str, ...]  # digits only
    start: _dt.date | None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "ReachConfig":
        env = dict(os.environ) if env is None else env
        enabled = (env.get("NPS_REACH_ENABLED") or "").strip().lower() in ("1", "true", "yes", "on")
        numbers = tuple(d for d in (digits(n) for n in (env.get("NPS_REACH_EXCLUDED_NUMBERS") or "").split(",")) if d)
        raw_start = (env.get("NPS_REACH_START") or "").strip()
        try:
            start = _dt.date.fromisoformat(raw_start) if raw_start else None
        except ValueError:
            raise ValueError("NPS_REACH_START must be a date (yyyy-mm-dd)") from None
        return cls(enabled, (env.get("NPS_REACH_TEMPLATE_MATCH") or "Feedback").strip(), numbers, start)


def digits(number: object) -> str:
    return re.sub(r"\D", "", str(number or ""))


def is_feedback_template(template_name: object, match: str) -> bool:
    return bool(match) and match.lower() in str(template_name or "").lower()


def is_excluded_number(mobile_number: object, excluded: tuple[str, ...]) -> bool:
    """Same number with or without the country code / leading 0: the last 9 digits are compared (Libyan mobiles)."""
    d = digits(mobile_number)
    return len(d) >= 9 and any(len(x) >= 9 and d[-9:] == x[-9:] for x in excluded)


validate_groups()


def _naive(value: object) -> _dt.datetime | None:
    return None if value is None or pd.isna(value) else pd.Timestamp(value).to_pydatetime()


# -- source and transform ------------------------------------------------------------------------------------------------
SOURCE_TABLE = "whatsapp_outbound_messages"
SOURCE_COLUMNS = ["id", "create_date", "company_name", "template_name", "state", "mobile_number", "failure_type",
                  "failure_reason", "first_seen_at", "updated_at"]
FACT_COLUMNS = ["message_id", "sent_at_utc", "sent_at_local", "MessageDateKey", "CompanyKey", "state", "box", "failure_group",
                "template_name", "is_feedback_template", "is_test_number", "in_reach_scope", "deleted_in_source_at"]


def build_messages(raw: pd.DataFrame, config: ReachConfig, timezone: str, company_of: "callable") -> pd.DataFrame:
    """raw_nps_whatsapp_message rows -> fact_process_nps_message rows, INCLUDING rows that left the source: a message that
    disappears is never hidden, it keeps being counted with ``deleted_in_source_at`` = the raw ``_deleted_at``.
    ``company_of(company_name)`` is the ratings' company mapping (transform.source_company). The mobile number is only
    compared, never copied."""
    from zoneinfo import ZoneInfo

    tz = ZoneInfo(timezone)
    out = []
    for r in raw.to_dict("records"):
        at = r.get("create_date")
        at_utc = None if at is None or pd.isna(at) else pd.Timestamp(at).to_pydatetime()
        at_local = None if at_utc is None else at_utc.replace(tzinfo=_dt.timezone.utc).astimezone(tz).replace(tzinfo=None)
        state = str(r.get("state") or "").strip().lower()
        feedback = is_feedback_template(r.get("template_name"), config.template_match)
        test = is_excluded_number(r.get("mobile_number"), config.excluded_numbers)
        on_or_after_start = config.start is None or (at_local is not None and at_local.date() >= config.start)
        out.append({
            "message_id": int(r["id"]), "sent_at_utc": at_utc, "sent_at_local": at_local,
            "MessageDateKey": -1 if at_local is None else at_local.year * 10000 + at_local.month * 100 + at_local.day,
            "CompanyKey": int(company_of(r.get("company_name"))), "state": state, "box": BOX_STATES.get(state, "other"),
            "failure_group": failure_group(r.get("failure_type"), r.get("failure_reason"), state) or NOT_AN_ERROR,
            "template_name": r.get("template_name"), "is_feedback_template": int(feedback), "is_test_number": int(test),
            "in_reach_scope": int(feedback and not test and on_or_after_start),
            "deleted_in_source_at": _naive(r.get("_deleted_at")),
        })
    return pd.DataFrame(out, columns=FACT_COLUMNS)
