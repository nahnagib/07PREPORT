"""Excel source: schema validation reports every problem with its Excel row number."""

from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest

from etl_platform.sources.excel import Column, ExcelSchemaError, ExcelSource, SheetSchema, validate_frame

ORG = SheetSchema(
    sheet=("salesperson", "People"),
    columns=(
        Column("SalespersonKey", "int", nullable=False, unique=True),
        Column("Name", "str", nullable=False, aliases=("Salesperson",)),
        Column("TeamKey", "str", nullable=False),
        Column("Status", "str", allowed=("Active", "Inactive")),
        Column("StartDate", "date", required=False),
    ),
    key=("Name", "TeamKey"),
)


def test_valid_frame_is_coerced_and_aliases_applied():
    raw = pd.DataFrame({" salesperson ": ["  Moftah   Nohee ", "Randa"], "salespersonkey": [12.0, "7"],
                        "TeamKey": ["TK-BEN-BC-03", "MJ-BEN-BC-01"], "Status": ["Active", None], "Extra": [1, 2]})
    df = validate_frame(raw, ORG)
    assert list(df.columns) == ["SalespersonKey", "Name", "TeamKey", "Status", "StartDate"]
    assert df["SalespersonKey"].tolist() == [12, 7]
    assert df["Name"].tolist() == ["Moftah Nohee", "Randa"]
    assert df.attrs["excel_rows"] == [2, 3]


def test_all_problems_are_reported_with_excel_rows():
    raw = pd.DataFrame({
        "SalespersonKey": [1, "x", 1, None],
        "Name": ["A", "B", "C", "A"],
        "TeamKey": ["T1", "T1", None, "T1"],
        "Status": ["Active", "Retired", "Active", "Active"],
    })
    with pytest.raises(ExcelSchemaError) as exc:
        validate_frame(raw, ORG)
    problems = "\n".join(exc.value.problems)
    assert "row 3: 'SalespersonKey' = 'x' is not a valid int" in problems
    assert "row 5: 'SalespersonKey' is empty" in problems
    assert "row 4: 'TeamKey' is empty" in problems
    assert "row 3: 'Status' = 'Retired' is not one of Active, Inactive" in problems
    assert "'SalespersonKey' value 1 appears more than once (rows 2, 4)" in problems
    assert "key (Name, TeamKey) = ('A', 'T1') appears more than once (rows 2, 5)" in problems


def test_missing_required_column():
    with pytest.raises(ExcelSchemaError, match="missing column 'TeamKey'"):
        validate_frame(pd.DataFrame({"SalespersonKey": [1], "Name": ["A"]}), ORG)


def test_blank_rows_are_ignored():
    raw = pd.DataFrame({"SalespersonKey": [1, None], "Name": ["A", "  "], "TeamKey": ["T1", None], "Status": [None, None]})
    assert len(validate_frame(raw, ORG)) == 1


def test_read_picks_sheet_case_insensitively_and_parses_dates(tmp_path):
    path = tmp_path / "SalesTeam.xlsx"
    with pd.ExcelWriter(path) as writer:
        pd.DataFrame({"x": [1]}).to_excel(writer, sheet_name="salesteam", index=False)
        pd.DataFrame({"SalespersonKey": [3], "Name": ["A"], "TeamKey": ["T"], "Status": ["Active"],
                      "StartDate": [dt.datetime(2026, 1, 5)]}).to_excel(writer, sheet_name="SALESPERSON", index=False)
    df = ExcelSource(tmp_path).read("SalesTeam.xlsx", ORG)
    assert df.loc[0, "StartDate"] == dt.date(2026, 1, 5)
    assert len(ExcelSource.file_hash(path)) == 64


def test_missing_file_and_sheet(tmp_path):
    with pytest.raises(ExcelSchemaError, match="file not found"):
        ExcelSource(tmp_path).read("nope.xlsx", ORG)
    path = tmp_path / "x.xlsx"
    pd.DataFrame({"a": [1]}).to_excel(path, sheet_name="Other", index=False)
    with pytest.raises(ExcelSchemaError, match="no sheet named salesperson / People"):
        ExcelSource(tmp_path).read("x.xlsx", ORG)
