"""Org structure from SalesTeam.xlsx: channels, segments, sales teams, salespeople, Odoo user -> salesperson map.

Keys are the frozen codes in the file. Nothing here assigns or reorders keys, so adding a salesperson (even one
whose name sorts first) never changes anyone else's key.

Effective status rule: a salesperson with no team (TeamKey blank) is Inactive -- a former salesperson -- whatever
the Status column says. Otherwise the Status column as written (a blank Status is not Active). ``status`` holds the
effective status; the sheet values stay in raw_excel_salesperson.

Effective team/channel rule (kept from the legacy pipeline, SalesOrgRepository.load): a salesperson's team and
channel count only while the effective status is Active; otherwise the effective SalesTeamKey is '-1' (Unknown
team) and ChannelKey -1. The sheet team is kept in ``assigned_team_key``.
"""

from __future__ import annotations

import pandas as pd

from core.keys import UNKNOWN, UNKNOWN_TEXT

FOLLOWS_SALESPERSON = "SALESPERSON"  # OdooTeams value: the document's team is its salesperson's effective team


class OrgFileError(ValueError):
    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("SalesTeam.xlsx is inconsistent:\n  - " + "\n  - ".join(problems))


def _int_objects(series: pd.Series) -> pd.Series:
    """Integer keys as Python ints (None when blank). Values read back from SQL arrive as floats with NaN."""
    return pd.Series([None if v is None or pd.isna(v) else int(v) for v in series], index=series.index, dtype=object)


def normalize_org(salesperson, team, users, channel, segment):
    """Integer key columns -> Python ints, whatever the frames were read from."""
    salesperson = salesperson.assign(SalespersonKey=_int_objects(salesperson["SalespersonKey"]), ChannelKey=_int_objects(salesperson["ChannelKey"]))
    team = team.assign(CompanyKey=_int_objects(team["CompanyKey"]), SegmentKey=_int_objects(team["SegmentKey"]))
    users = users.assign(odoo_user_id=_int_objects(users["odoo_user_id"]), SalespersonKey=_int_objects(users["SalespersonKey"]))
    channel = channel.assign(ChannelKey=_int_objects(channel["ChannelKey"]))
    segment = segment.assign(SegmentKey=_int_objects(segment["SegmentKey"]))
    return salesperson, team, users, channel, segment


def _is_active(status) -> bool:
    return isinstance(status, str) and status.strip().upper() == "ACTIVE"


def validate_org(salesperson: pd.DataFrame, team: pd.DataFrame, users: pd.DataFrame, channel: pd.DataFrame,
                 segment: pd.DataFrame, company_keys: set[int]) -> None:
    """Cross-sheet rules. Raises OrgFileError listing every problem with its Excel row."""
    salesperson, team, users, channel, segment = normalize_org(salesperson, team, users, channel, segment)
    problems: list[str] = []
    channel_by_key = dict(zip(channel["ChannelKey"], channel["DistributionChannel"]))
    segment_by_key = dict(zip(segment["SegmentKey"], segment["Segment"]))
    team_keys = set(team["TeamKey"])
    sp_keys = set(salesperson["SalespersonKey"])
    for key in (UNKNOWN,):
        if key in channel_by_key:
            problems.append("sheet channel: ChannelKey -1 is reserved for Unknown")
        if key in segment_by_key:
            problems.append("sheet segment: SegmentKey -1 is reserved for Unknown")
        if key in sp_keys:
            problems.append("sheet salesperson: SalespersonKey -1 is reserved for Unassigned")
    if UNKNOWN_TEXT in team_keys:
        problems.append("sheet salesteam: TeamKey '-1' is reserved for Unknown")

    def _isna(v) -> bool:
        return v is None or (not isinstance(v, str) and pd.isna(v))

    for r in salesperson.to_dict("records"):
        where = f"salesperson row {r.get('_excel_row', '?')} ({r['Name']})"
        if isinstance(r["TeamKey"], str) and r["TeamKey"] not in team_keys:
            problems.append(f"{where}: TeamKey '{r['TeamKey']}' is not in sheet salesteam")
        ck, dc = r["ChannelKey"], r["DistributionChannel"]
        if not _isna(ck):
            if ck not in channel_by_key:
                problems.append(f"{where}: ChannelKey {ck} is not in sheet channel")
            elif isinstance(dc, str) and channel_by_key[ck] != dc:
                problems.append(f"{where}: ChannelKey {ck} is '{channel_by_key[ck]}' but DistributionChannel says '{dc}'")
        elif isinstance(dc, str):
            problems.append(f"{where}: DistributionChannel '{dc}' has no ChannelKey")

    for r in team.to_dict("records"):
        where = f"salesteam row {r.get('_excel_row', '?')} ({r['TeamKey']})"
        sk, ck = r["SegmentKey"], r["CompanyKey"]
        if sk != UNKNOWN and sk not in segment_by_key:
            problems.append(f"{where}: SegmentKey {sk} is not in sheet segment")
        elif sk in segment_by_key and isinstance(r["Segment"], str) and segment_by_key[sk] != r["Segment"]:
            problems.append(f"{where}: SegmentKey {sk} is '{segment_by_key[sk]}' but Segment says '{r['Segment']}'")
        if ck != UNKNOWN and ck not in company_keys:
            problems.append(f"{where}: CompanyKey {ck} is not an in-scope company ({sorted(company_keys)})")

    for r in users.to_dict("records"):
        if r["SalespersonKey"] not in sp_keys:
            problems.append(f"OdooUsers row {r.get('_excel_row', '?')}: odoo_user_id {r['odoo_user_id']} points to unknown SalespersonKey {r['SalespersonKey']}")
    if problems:
        raise OrgFileError(problems)


def build_channels(channel: pd.DataFrame) -> pd.DataFrame:
    return channel[["ChannelKey", "DistributionChannel"]].astype({"ChannelKey": "int64"}).reset_index(drop=True)


def build_segments(segment: pd.DataFrame) -> pd.DataFrame:
    return segment[["SegmentKey", "Segment"]].astype({"SegmentKey": "int64"}).reset_index(drop=True)


def build_sales_teams(team: pd.DataFrame, company_names: dict[int, str]) -> pd.DataFrame:
    out = pd.DataFrame({
        "SalesTeamKey": team["TeamKey"],
        "SalesTeam": team["TeamName"].where(team["TeamName"].notna(), "Unknown_Team"),
        "CompanyKey": team["CompanyKey"].astype("int64"),
        "SalesTeamCompany": [company_names.get(k, c if isinstance(c, str) else "Unknown") for k, c in zip(team["CompanyKey"], team["Company"])],
        "SegmentKey": team["SegmentKey"].astype("int64"),
        "SalesSegment": team["Segment"].where(team["Segment"].notna(), "Unknown"),
        "SalesCity": team["City"].where(team["City"].notna(), "Unknown"),
        "Territory": team.get("Territory"),
        "SalesTeamStatus": team["Status"].where(team["Status"].notna(), "ACTIVE"),
    })
    return out.reset_index(drop=True)


def _has_team(team) -> bool:
    return isinstance(team, str) and team.strip() != ""


def effective_status(status, team):
    """No team -> 'Inactive' (a former salesperson); otherwise the sheet Status as written (None when blank)."""
    if not _has_team(team):
        return "Inactive"
    return status.strip() if isinstance(status, str) and status.strip() else None


def active_without_team(salesperson: pd.DataFrame) -> pd.DataFrame:
    """Rows whose sheet Status says Active but that have no team (made Inactive by the rule; the sheet needs cleaning)."""
    mask = [_is_active(s) and not _has_team(t) for s, t in zip(salesperson["Status"], salesperson["TeamKey"])]
    return salesperson.loc[mask, ["SalespersonKey", "Name"]].reset_index(drop=True)


def build_salespeople(salesperson: pd.DataFrame) -> pd.DataFrame:
    status = [effective_status(s, t) for s, t in zip(salesperson["Status"], salesperson["TeamKey"])]
    active = [_is_active(s) for s in status]
    team = salesperson["TeamKey"].map(lambda t: t.strip() if _has_team(t) else None)
    channel_key = salesperson["ChannelKey"].map(lambda v: UNKNOWN if v is None or pd.isna(v) else int(v))
    out = pd.DataFrame({
        "SalespersonKey": salesperson["SalespersonKey"].astype("int64"),
        "salesperson": salesperson["Name"],
        "SalesTeamKey": [t if (a and isinstance(t, str)) else UNKNOWN_TEXT for a, t in zip(active, team)],
        "ChannelKey": [c if a else UNKNOWN for a, c in zip(active, channel_key)],
        "DistributionChannel": [
            (d if isinstance(d, str) else "Unknown") if a else "Unknown"
            for a, d in zip(active, salesperson["DistributionChannel"])
        ],
        "assigned_team_key": team,
        "status": status,
    })
    return out.reset_index(drop=True)


def build_user_map(users: pd.DataFrame, odoo_users: pd.DataFrame | None = None) -> pd.DataFrame:
    """odoo_user_id -> SalespersonKey exactly as listed in sheet OdooUsers. Names come from Odoo when known."""
    out = pd.DataFrame({
        "odoo_user_id": users["odoo_user_id"].astype("int64"),
        "SalespersonKey": users["SalespersonKey"].astype("int64"),
        "odoo_user_name": users.get("odoo_user_name"),
    })
    if odoo_users is not None and not odoo_users.empty:
        names = dict(zip(odoo_users["id"], odoo_users["name"]))
        out["odoo_user_name"] = [names.get(u, n) for u, n in zip(out["odoo_user_id"], out["odoo_user_name"])]
    return out.reset_index(drop=True)


def validate_team_map(teams_sheet: pd.DataFrame, team: pd.DataFrame) -> None:
    """OdooTeams rows must point at a team of sheet salesteam, or say SALESPERSON."""
    known = set(team["TeamKey"]) | {FOLLOWS_SALESPERSON}
    problems = [
        f"OdooTeams row {r.get('_excel_row', '?')}: odoo_team_id {int(r['odoo_team_id'])} points to unknown team '{r['SalesTeamKey']}'"
        for r in teams_sheet.to_dict("records") if r["SalesTeamKey"] not in known
    ]
    if problems:
        raise OrgFileError(problems)


def build_team_map(teams_sheet: pd.DataFrame, odoo_teams: pd.DataFrame | None = None) -> pd.DataFrame:
    """odoo_team_id -> SalesTeamKey exactly as listed in sheet OdooTeams (SALESPERSON -> follows_salesperson)."""
    follows = teams_sheet["SalesTeamKey"] == FOLLOWS_SALESPERSON
    out = pd.DataFrame({
        "odoo_team_id": [int(v) for v in teams_sheet["odoo_team_id"]],
        "SalesTeamKey": teams_sheet["SalesTeamKey"].where(~follows, UNKNOWN_TEXT).to_numpy(),
        "follows_salesperson": follows.astype(int).to_numpy(),
        "odoo_team_name": teams_sheet.get("odoo_team_name"),
    })
    if odoo_teams is not None and not odoo_teams.empty:
        names = dict(zip(odoo_teams["id"], odoo_teams["name"]))
        out["odoo_team_name"] = [names.get(t, n) for t, n in zip(out["odoo_team_id"], out["odoo_team_name"])]
    return out.reset_index(drop=True)
