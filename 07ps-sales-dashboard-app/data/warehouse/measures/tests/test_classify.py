import pytest

from classify import TargetStatus, classify_vs_target, variance_pct


class TestClassifyVsTarget:
    def test_actual_equals_target_is_green(self):
        assert classify_vs_target(100, 100) == TargetStatus.GREEN

    def test_actual_exceeds_target_is_green(self):
        assert classify_vs_target(150, 100) == TargetStatus.GREEN

    def test_actual_just_above_yellow_floor_is_yellow(self):
        # 91 is 9% below 100 -> yellow
        assert classify_vs_target(91, 100) == TargetStatus.YELLOW

    def test_exactly_10_percent_below_target_is_yellow_not_red(self):
        # The exact boundary case called out in the task: "within 10% below" / "up to 10%" is
        # read as inclusive of exactly 10%, so this must be YELLOW.
        assert classify_vs_target(90, 100) == TargetStatus.YELLOW

    def test_just_over_10_percent_below_target_is_red(self):
        # 89.99 is more than 10% below 100 -> red
        assert classify_vs_target(89.99, 100) == TargetStatus.RED

    def test_far_below_target_is_red(self):
        assert classify_vs_target(10, 100) == TargetStatus.RED

    def test_zero_actual_is_red_when_target_positive(self):
        assert classify_vs_target(0, 100) == TargetStatus.RED

    def test_boundary_holds_at_different_scale(self):
        # Same 10% boundary, different absolute numbers, to confirm it's not hardcoded to 100.
        assert classify_vs_target(4500, 5000) == TargetStatus.YELLOW  # exactly -10%
        assert classify_vs_target(4499, 5000) == TargetStatus.RED
        assert classify_vs_target(4501, 5000) == TargetStatus.YELLOW

    def test_target_none_is_no_target(self):
        assert classify_vs_target(100, None) == TargetStatus.NO_TARGET

    def test_target_zero_is_no_target(self):
        assert classify_vs_target(100, 0) == TargetStatus.NO_TARGET

    def test_target_negative_is_no_target(self):
        assert classify_vs_target(100, -50) == TargetStatus.NO_TARGET

    def test_actual_none_is_no_target(self):
        assert classify_vs_target(None, 100) == TargetStatus.NO_TARGET

    def test_negative_actual_below_target_is_red(self):
        # A negative actual (e.g. net returns exceeding sales) is still just "far below target".
        assert classify_vs_target(-10, 100) == TargetStatus.RED


class TestVariancePct:
    def test_matches_target_is_zero_variance(self):
        assert variance_pct(100, 100) == 0

    def test_exactly_10_percent_below(self):
        assert variance_pct(90, 100) == pytest.approx(-0.10)

    def test_above_target_is_positive(self):
        assert variance_pct(120, 100) == pytest.approx(0.20)

    def test_missing_target_is_none(self):
        assert variance_pct(100, None) is None
        assert variance_pct(100, 0) is None

    def test_missing_actual_is_none(self):
        assert variance_pct(None, 100) is None
