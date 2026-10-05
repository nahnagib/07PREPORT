"""Receivable aging buckets -- the ONE place they are defined (dim_finance_aging_bucket is loaded from here).

days_past_due = snapshot date - due date. An item due today (0) is NOT overdue. Bounds are inclusive; None means
open-ended. AgingBucketKey is the sort order. To change the buckets, edit AGING_BUCKETS: the next run upserts the
dimension, and earlier snapshots keep the keys they were loaded with.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class AgingBucket:
    key: int
    label: str
    min_days: int | None  # inclusive, None = no lower bound
    max_days: int | None  # inclusive, None = no upper bound

    @property
    def is_overdue(self) -> bool:
        return self.min_days is not None and self.min_days > 0


AGING_BUCKETS: tuple[AgingBucket, ...] = (
    AgingBucket(1, "Not due 60+", None, -61),
    AgingBucket(2, "Not due 31-60", -60, -31),
    AgingBucket(3, "Not due 16-30", -30, -16),
    AgingBucket(4, "Not due 0-15", -15, 0),
    AgingBucket(5, "Overdue 1-30", 1, 30),
    AgingBucket(6, "Overdue 31-60", 31, 60),
    AgingBucket(7, "Overdue 61-90", 61, 90),
    AgingBucket(8, "Overdue 90+", 91, None),
)


def validate_buckets(buckets: tuple[AgingBucket, ...] = AGING_BUCKETS) -> None:
    """Buckets must cover every integer exactly once, in key order."""
    ordered = sorted(buckets, key=lambda b: b.key)
    if ordered[0].min_days is not None or ordered[-1].max_days is not None:
        raise ValueError("the first bucket must have no lower bound and the last no upper bound")
    for a, b in zip(ordered, ordered[1:]):
        if a.max_days is None or b.min_days is None or b.min_days != a.max_days + 1:
            raise ValueError(f"aging buckets '{a.label}' and '{b.label}' leave a gap or overlap")


def bucket_key(days_past_due: int, buckets: tuple[AgingBucket, ...] = AGING_BUCKETS) -> int:
    for b in buckets:
        if (b.min_days is None or days_past_due >= b.min_days) and (b.max_days is None or days_past_due <= b.max_days):
            return b.key
    raise ValueError(f"no aging bucket for {days_past_due} day(s)")  # unreachable once validate_buckets passed


def bucket_frame(buckets: tuple[AgingBucket, ...] = AGING_BUCKETS) -> pd.DataFrame:
    return pd.DataFrame([{"AgingBucketKey": b.key, "aging_bucket": b.label, "min_days_past_due": b.min_days,
                          "max_days_past_due": b.max_days, "is_overdue": int(b.is_overdue)} for b in buckets])
