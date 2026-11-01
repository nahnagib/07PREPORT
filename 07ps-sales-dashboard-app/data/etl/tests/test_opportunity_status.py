"""Opportunity status = the outcome (Odoo won_status / Won-Lost buttons), never the stage name."""
from __future__ import annotations

import pandas as pd
import pytest

from sales_pipeline.crm.crm_status_classifier import classify_status, opportunity_status

WON_STAGES = {4}
LOST_COLUMN, NEW_COLUMN, WON_COLUMN = 5, 1, 4


def row(**kw) -> pd.Series:
    base = {"IsActive": True, "Probability": 50.0, "StageID": NEW_COLUMN, "Stage": "New", "WonStatus": pd.NA, "LostReason": pd.NA}
    base.update(kw)
    return pd.Series(base)


@pytest.mark.parametrize("won_status, active, expected", [
    ("won", True, "Won"), ("lost", False, "Lost"), ("pending", True, "Pending"), ("pending", False, "Archived"),
])
def test_odoo_won_status_wins(won_status, active, expected):
    assert opportunity_status(row(WonStatus=won_status, IsActive=active), WON_STAGES) == expected


def test_active_card_in_custom_lost_column_is_open():
    # dragged into the "Lost" column but never marked Lost: Odoo still counts it as open
    r = row(StageID=LOST_COLUMN, Stage="Lost", WonStatus="pending", Probability=10.0)
    assert opportunity_status(r, WON_STAGES) == "Pending"
    assert opportunity_status(r.drop("WonStatus"), WON_STAGES) == "Pending"


def test_lost_button_keeps_stage_but_is_lost():
    r = row(StageID=2, Stage="Qualified", IsActive=False, Probability=0.0, WonStatus="lost", LostReason="Price")
    assert classify_status(r, WON_STAGES) == (False, True, False)


def test_won_stage_with_probability_below_100_follows_odoo():
    assert opportunity_status(row(StageID=WON_COLUMN, Stage="Won", WonStatus="pending", Probability=80.0), WON_STAGES) == "Pending"


@pytest.mark.parametrize("kw, expected", [
    ({"StageID": WON_COLUMN}, "Won"),                                     # active AND stage.is_won
    ({"IsActive": False, "Probability": 0.0}, "Lost"),                    # archived AND probability 0
    ({"IsActive": False, "Probability": 100.0}, "Archived"),              # archived AND probability > 0
    ({"IsActive": False, "Probability": 30.0, "StageID": WON_COLUMN}, "Archived"),
    ({}, "Pending"),                                                          # any other active record
    ({"Probability": 100.0}, "Pending"),                                      # probability alone is not Won
])
def test_fallback_without_won_status(kw, expected):
    assert opportunity_status(row(**kw), WON_STAGES) == expected


def test_stage_names_are_never_read():
    for name in ("Won", "Lost", "won deal", "LOST"):
        assert opportunity_status(row(Stage=name), WON_STAGES) == "Pending"


def test_archived_is_neither_won_lost_nor_open():
    assert classify_status(row(IsActive=False, Probability=40.0), WON_STAGES) == (False, False, False)
