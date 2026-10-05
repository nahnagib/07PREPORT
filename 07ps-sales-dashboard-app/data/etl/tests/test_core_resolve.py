"""core.resolve.KeyMaps: the conformed-key rules every department uses (docs/adding-a-department.md)."""

from __future__ import annotations

from core.keys import UNKNOWN, UNKNOWN_TEXT
from core.resolve import KeyMaps

MAPS = KeyMaps(
    partner_customer={100: 100, 101: 100},
    user_salesperson={10: 49, 11: 49, 12: 60},
    team_map={9: ("MJ-EST-BB", False), 27: (UNKNOWN_TEXT, True)},
    salesperson_team={49: "TK-BEN-BC-03", 60: UNKNOWN_TEXT, UNKNOWN: UNKNOWN_TEXT},
    salesperson_channel={49: 3, 60: UNKNOWN, UNKNOWN: UNKNOWN},
    team_segment={"MJ-EST-BB": 1, "TK-BEN-BC-03": 2, UNKNOWN_TEXT: UNKNOWN},
    company_keys={1, 3, UNKNOWN},
    product_keys={500},
    product_master={(500, 1): "M-GR"},
    master_keys={"M-GR"},
)


def test_team_is_the_documents_odoo_team_mapped_by_id():
    keys, unlisted = MAPS.teams([9], [49])
    assert keys == ["MJ-EST-BB"] and unlisted == []  # not the salesperson's own team (TK-BEN-BC-03)


def test_no_odoo_team_or_salesperson_rule_falls_back_to_the_salespersons_team():
    keys, _ = MAPS.teams([None, 27, float("nan"), [27, "EXPORT"]], [49, 49, 60, 49])
    assert keys == ["TK-BEN-BC-03", "TK-BEN-BC-03", UNKNOWN_TEXT, "TK-BEN-BC-03"]


def test_facts_without_the_salesperson_fallback_keep_no_team_unknown():
    # documents, deliveries, leads, opportunities: the legacy pipeline left a document without an Odoo team Unknown
    keys, _ = MAPS.teams([None, 27, 9], [49, 49, 49], person_fallback=False)
    assert keys == [UNKNOWN_TEXT, UNKNOWN_TEXT, "MJ-EST-BB"]  # a mapped Odoo team is still used


def test_unlisted_odoo_team_goes_to_unknown_and_is_reported():
    keys, unlisted = MAPS.teams([2, 2], [49, 49])
    assert keys == [UNKNOWN_TEXT, UNKNOWN_TEXT] and unlisted == [2, 2]


def test_segment_follows_the_team_and_channel_follows_the_salesperson():
    teams, _ = MAPS.teams([9], [49])
    assert MAPS.segments(teams) == [1]  # the team's segment (B2B), not the salesperson's team's (B2C)
    assert MAPS.channels([49]) == [3]


def test_customer_salesperson_company_product_fallbacks_are_reported():
    assert MAPS.customers([101, None, 999]) == ([100, UNKNOWN, UNKNOWN], [999])
    assert MAPS.salespeople([10, 11, 77, False]) == ([49, 49, UNKNOWN, UNKNOWN], [77])
    assert MAPS.companies([3, "1", 2]) == ([3, 1, UNKNOWN], [2])
    assert MAPS.products([500, 501.0]) == ([500, UNKNOWN], [501])
    assert MAPS.product_masters([500, 500], [1, 3]) == ["M-GR", UNKNOWN_TEXT]
