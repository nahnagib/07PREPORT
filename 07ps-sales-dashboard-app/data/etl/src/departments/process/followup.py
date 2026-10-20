"""NPS Detractor Follow-up: the cases process_nps keeps in step with the ratings (migration 0052; docs/nps-followup.md).

nps_followup_case is an APPLICATION table (people edit it on the Detractor Follow-up page). After each load this step
only:
* adds a case for every detractor rating (nps_level 1) that has none -- idempotent through the unique response_id.
  Rated on or after NPS_FOLLOWUP_START (a Tripoli date, ETL setting; the cut-over) -> NEW, before it -> HISTORICAL;
* flags a case whose rating left the source or is no longer a detractor (source_changed, with when and why; one audit
  row) and clears the flag if the rating comes back as a detractor. The case and its manual fields are never touched.

NPS_FOLLOWUP_START not set, or migration 0052 not applied -> no case is created and the step says why.
"""

from __future__ import annotations

import datetime as _dt
import os
from typing import Any

from sqlalchemy import inspect, text

CASES, AUDIT, FACT = "nps_followup_case", "nps_followup_audit", "fact_process_nps_response"
DETRACTOR = 1
GONE, NOT_DETRACTOR = "rating no longer in the NPS source", "rating is no longer a detractor"


def followup_start() -> _dt.date | None:
    """NPS_FOLLOWUP_START (yyyy-mm-dd); unset -> None. A bad value fails the run (never a silent default)."""
    raw = os.getenv("NPS_FOLLOWUP_START", "").strip()
    if not raw:
        return None
    try:
        return _dt.date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"NPS_FOLLOWUP_START must be a date (yyyy-mm-dd), got {raw!r}") from exc


def sync_cases(conn, now: _dt.datetime, start: _dt.date | None) -> dict[str, Any]:
    """Runs in the load transaction, after the facts were replaced. Returns the counts for the task details."""
    if CASES not in set(inspect(conn).get_table_names()):
        return {"status": "skipped: migration 0052 not applied"}
    if start is None:
        return {"status": "skipped: NPS_FOLLOWUP_START is not set"}
    start_key = start.year * 10000 + start.month * 100 + start.day
    created = conn.execute(text(
        f"INSERT INTO {CASES} (response_id, rated_at_local, status, created_at, updated_at) "
        f"SELECT f.response_id, f.rated_at_local, CASE WHEN f.RatingDateKey >= :start THEN 'NEW' ELSE 'HISTORICAL' END, :now, :now "
        f"FROM {FACT} f WHERE f.nps_level = :lvl AND NOT EXISTS (SELECT 1 FROM {CASES} c WHERE c.response_id = f.response_id)"),
        {"start": start_key, "now": now, "lvl": DETRACTOR}).rowcount

    rows = conn.execute(text(
        f"SELECT c.case_id, c.source_changed, c.source_change_reason, f.nps_level FROM {CASES} c "
        f"LEFT JOIN {FACT} f ON f.response_id = c.response_id")).fetchall()
    flagged = restored = 0
    for case_id, changed, old_reason, level in rows:
        reason = GONE if level is None else NOT_DETRACTOR if int(level) != DETRACTOR else None
        if reason is not None and (not changed or old_reason != reason):
            conn.execute(text(f"UPDATE {CASES} SET source_changed = 1, source_changed_at = :now, source_change_reason = :r "
                              "WHERE case_id = :id"), {"now": now, "r": reason, "id": case_id})
            _audit(conn, case_id, now, "source_changed", old_reason if changed else None, reason)
            flagged += 1
        elif reason is None and changed:
            conn.execute(text(f"UPDATE {CASES} SET source_changed = 0, source_changed_at = NULL, source_change_reason = NULL "
                              "WHERE case_id = :id"), {"id": case_id})
            _audit(conn, case_id, now, "source_changed", old_reason, None)
            restored += 1
    by_status = dict(conn.execute(text(f"SELECT status, COUNT(*) FROM {CASES} GROUP BY status")).fetchall())
    return {"status": "synced", "start": str(start), "created": int(created or 0), "flagged_source_changed": flagged,
            "restored": restored, "by_status": {k: int(v) for k, v in by_status.items()}}


def _audit(conn, case_id: int, now: _dt.datetime, field: str, old: str | None, new: str | None) -> None:
    # changed_by NULL = process_nps
    conn.execute(text(f"INSERT INTO {AUDIT} (case_id, changed_by, changed_at, field, old_value, new_value) "
                      "VALUES (:c, NULL, :now, :f, :o, :n)"), {"c": case_id, "now": now, "f": field, "o": old, "n": new})
