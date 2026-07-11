"""Shared Green/Yellow/Red threshold logic.

Manual definition (Tachometer page, "Color Zones" / ASP indicators):
    Green  - target achieved or exceeded
    Yellow - below target by up to 10%
    Red    - below target by more than 10%

This one function backs both the Value/Volume tachometers and the ASP cards on this page, and is
written to be reusable by any future gauge-style KPI on other pages -- it takes only actual/target,
no knowledge of which metric or page it's being used for.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional


class TargetStatus(str, Enum):
    GREEN = "green"
    YELLOW = "yellow"
    RED = "red"
    NO_TARGET = "no_target"


def classify_vs_target(actual: Optional[float], target: Optional[float]) -> TargetStatus:
    """Classify ``actual`` against ``target`` per the manual's color-zone rule.

    - GREEN: actual >= target (target achieved or exceeded)
    - YELLOW: actual is below target, but by 10% or less of target
              i.e. actual >= target * 0.90
    - RED: actual is below target by more than 10%
              i.e. actual < target * 0.90

    The 10% boundary is inclusive on the yellow side: exactly 10% below target ("within 10% below"
    per the manual's own Yellow wording, and "up to 10%" per the tachometer wording) is YELLOW, not
    RED. Both phrasings in the manual describe an inclusive "up to / within 10%" band, so the
    boundary itself belongs to yellow, matching the more common real-world reading of "up to X%" as
    inclusive of X% exactly.

    Edge cases:
    - target is None, 0, or negative: classification is undefined (there is nothing meaningful to
      measure "below target" against) -> NO_TARGET. Callers should decide how to render this (e.g.
      "no target set") rather than this function silently guessing GREEN or RED.
    - actual is None: NO_TARGET as well -- there is no actual figure to compare.
    """
    if target is None or target <= 0:
        return TargetStatus.NO_TARGET
    if actual is None:
        return TargetStatus.NO_TARGET

    if actual >= target:
        return TargetStatus.GREEN

    yellow_floor = target * 0.90
    if actual >= yellow_floor:
        return TargetStatus.YELLOW

    return TargetStatus.RED


def variance_pct(actual: Optional[float], target: Optional[float]) -> Optional[float]:
    """Signed percentage variance of actual vs. target: (actual - target) / target.

    Returns None if target is missing/non-positive or actual is missing, matching
    classify_vs_target's NO_TARGET cases. A return of -0.10 means "10% below target" exactly --
    this is the same figure classify_vs_target's yellow/red boundary is drawn at.
    """
    if target is None or target <= 0 or actual is None:
        return None
    return (actual - target) / target
