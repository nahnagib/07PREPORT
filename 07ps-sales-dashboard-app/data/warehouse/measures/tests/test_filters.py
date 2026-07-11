from datetime import date

import pytest

from filters import (
    Filters,
    UserContext,
    SalespersonLockError,
    apply_salesperson_lock,
    build_where_clause,
    flm_window,
    fly_window,
    lmtd_window,
    lytd_window,
    mtd_window,
    month_elapsed_fraction,
    prorate_mtd_target,
    prorate_ytd_target,
    ytd_window,
)


class TestDateWindows:
    def test_mtd_window(self):
        w = mtd_window(date(2026, 7, 5))
        assert w.start == date(2026, 7, 1)
        assert w.end == date(2026, 7, 5)

    def test_ytd_window(self):
        w = ytd_window(date(2026, 7, 5))
        assert w.start == date(2026, 1, 1)
        assert w.end == date(2026, 7, 5)

    def test_lmtd_window_shifts_one_year_back(self):
        w = lmtd_window(date(2026, 7, 5))
        assert w.start == date(2025, 7, 1)
        assert w.end == date(2025, 7, 5)

    def test_lytd_window_shifts_one_year_back(self):
        w = lytd_window(date(2026, 7, 5))
        assert w.start == date(2025, 1, 1)
        assert w.end == date(2025, 7, 5)

    def test_leap_day_anchor_shifts_to_feb_28(self):
        w = lmtd_window(date(2024, 2, 29))
        assert w.end == date(2023, 2, 28)

    def test_fly_window_is_full_prior_calendar_year(self):
        w = fly_window(date(2026, 3, 15))
        assert w.start == date(2025, 1, 1)
        assert w.end == date(2025, 12, 31)

    def test_flm_window_is_full_prior_calendar_month(self):
        w = flm_window(date(2026, 7, 5))
        assert w.start == date(2026, 6, 1)
        assert w.end == date(2026, 6, 30)

    def test_flm_window_handles_january_year_wraparound(self):
        w = flm_window(date(2026, 1, 15))
        assert w.start == date(2025, 12, 1)
        assert w.end == date(2025, 12, 31)


class TestProration:
    def test_month_elapsed_fraction_mid_month(self):
        # July has 31 days; day 5 of it.
        assert month_elapsed_fraction(date(2026, 7, 5)) == pytest.approx(5 / 31)

    def test_month_elapsed_fraction_last_day_is_one(self):
        assert month_elapsed_fraction(date(2026, 6, 30)) == pytest.approx(1.0)

    def test_prorate_mtd_target(self):
        assert prorate_mtd_target(310000, date(2026, 7, 5)) == pytest.approx(310000 * 5 / 31)

    def test_prorate_mtd_target_none_target(self):
        assert prorate_mtd_target(None, date(2026, 7, 5)) is None

    def test_prorate_ytd_target_sums_completed_months_plus_partial(self):
        # 6 completed months totalling 3,000,000 + current month (July) prorated
        result = prorate_ytd_target(
            completed_months_target_sum=3_000_000,
            fm_target_current_month=310_000,
            anchor=date(2026, 7, 5),
        )
        assert result == pytest.approx(3_000_000 + 310_000 * 5 / 31)

    def test_prorate_ytd_target_both_none_is_none(self):
        assert prorate_ytd_target(None, None, date(2026, 7, 5)) is None


class TestBuildWhereClause:
    def test_no_filters_is_always_true(self):
        clause, params = build_where_clause(Filters())
        assert clause == "1=1"
        assert params == []

    def test_single_filter(self):
        clause, params = build_where_clause(Filters(company_key=1), table_alias="fo")
        assert clause == "fo.company_key = %s"
        assert params == [1]

    def test_multiple_filters_and_joined(self):
        clause, params = build_where_clause(
            Filters(company_key=1, segment_key=2, salesperson_key=40)
        )
        assert "company_key = %s" in clause
        assert "segment_key = %s" in clause
        assert "salesperson_key = %s" in clause
        assert params == [1, 2, 40]


class TestSalespersonLock:
    def test_non_salesperson_role_passes_through_unchanged(self):
        filters = Filters(company_key=1, segment_key=2)
        user = UserContext(role_code="BI00_EXECUTIVE")
        assert apply_salesperson_lock(filters, user) == filters

    def test_salesperson_role_locks_all_other_filters_and_forces_own_key(self):
        filters = Filters(company_key=1, segment_key=2, channel_key=3, sales_team_key="TK-X")
        user = UserContext(role_code="SALESPERSON", salesperson_key=40)
        locked = apply_salesperson_lock(filters, user)
        assert locked == Filters(salesperson_key=40)

    def test_salesperson_role_with_matching_explicit_key_is_fine(self):
        filters = Filters(salesperson_key=40)
        user = UserContext(role_code="SALESPERSON", salesperson_key=40)
        locked = apply_salesperson_lock(filters, user)
        assert locked.salesperson_key == 40

    def test_salesperson_role_requesting_different_salesperson_raises(self):
        filters = Filters(salesperson_key=99)
        user = UserContext(role_code="SALESPERSON", salesperson_key=40)
        with pytest.raises(SalespersonLockError):
            apply_salesperson_lock(filters, user)

    def test_salesperson_role_without_own_key_raises(self):
        filters = Filters()
        user = UserContext(role_code="SALESPERSON", salesperson_key=None)
        with pytest.raises(SalespersonLockError):
            apply_salesperson_lock(filters, user)
