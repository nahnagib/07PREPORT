"""Odoo date/datetime strings -> business-time timestamps (sales_report_repository.safe_datetime_to_local).

Parsed with an explicit format="ISO8601": no "Could not infer format" UserWarning, and the result no longer depends on
the first value of the column (pandas' format inference turned date-only or "T" values into NaT when the first value
was a "YYYY-MM-DD HH:MM:SS" datetime)."""

from __future__ import annotations

import warnings

import pandas as pd

from sales_pipeline.odoo.sales_report_repository import odoo_utc_datetime_to_local, safe_datetime_to_local

TZ = "Africa/Tripoli"  # UTC+2, no DST

RAW = pd.Series(["2026-10-19 22:30:00", "2026-01-31", "2026-03-01T08:00:00", False, None, ""], dtype=object)


def _parse(series, assume_utc=False):
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # any UserWarning (format inference / dateutil fallback) fails the test
        return safe_datetime_to_local(series, TZ, assume_utc)


def test_naive_values_parse_unchanged_and_missing_become_nat():
    out = _parse(RAW)
    assert list(out[:3]) == [pd.Timestamp("2026-10-19 22:30:00"), pd.Timestamp("2026-01-31"), pd.Timestamp("2026-03-01 08:00:00")]
    assert out[3:].isna().all()  # False, None, ""


def test_naive_values_are_read_as_utc_when_asked():
    out = _parse(RAW, assume_utc=True)
    assert list(out[:3]) == [pd.Timestamp("2026-10-20 00:30:00"), pd.Timestamp("2026-01-31 02:00:00"), pd.Timestamp("2026-03-01 10:00:00")]
    assert out[3:].isna().all()
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        pd.testing.assert_series_equal(odoo_utc_datetime_to_local(RAW, TZ), out)


def test_datetime_only_column_matches_the_previous_parse():
    values = pd.Series(["2026-10-19 22:30:00", "2025-12-31 23:59:59", None], dtype=object)
    expected = pd.to_datetime(values.astype("string").str.strip(), errors="coerce")  # the call used before the explicit format
    pd.testing.assert_series_equal(_parse(values), expected, check_names=False)


def test_offset_values_are_converted_to_business_time():
    out = _parse(pd.Series(["2026-10-19T22:30:00Z", "2026-10-19 22:30:00+00:00"], dtype=object))
    assert list(out) == [pd.Timestamp("2026-10-20 00:30:00")] * 2
