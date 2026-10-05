"""Schema-validated Excel reads (org file, targets, blocked customers, ...).

A ``SheetSchema`` declares the columns a sheet must have, their types, which may be empty, which must be
unique, allowed values and the composite key. ``ExcelSource.read`` returns a clean DataFrame or raises
``ExcelSchemaError`` listing *every* problem with its Excel row number, so whoever maintains the file can fix
it in one pass. Header matching ignores case and surrounding/double spaces; aliases cover renamed headers.
The source only reads: it never writes back to an input file.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import pandas as pd

DTYPES = ("str", "int", "float", "date", "bool")
MAX_PROBLEMS_SHOWN = 50
_TRUE = {"1", "true", "yes", "y", "active"}
_FALSE = {"0", "false", "no", "n", "inactive"}


def _norm_header(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value).strip()).lower()


@dataclass(frozen=True)
class Column:
    name: str
    dtype: str = "str"
    required: bool = True  # the column must be present in the sheet
    nullable: bool = True  # cells may be empty
    unique: bool = False
    aliases: tuple[str, ...] = ()
    allowed: tuple[Any, ...] | None = None
    # dtype "date": how text cells are parsed (real Excel dates are taken as they are). Explicit on purpose:
    # "18/1/2026" must never be guessed as month-first.
    date_format: str = "%Y-%m-%d"

    def __post_init__(self) -> None:
        if self.dtype not in DTYPES:
            raise ValueError(f"Column '{self.name}': dtype must be one of {DTYPES}")


@dataclass(frozen=True)
class SheetSchema:
    sheet: str | tuple[str, ...]  # one name or candidates, matched case-insensitively
    columns: tuple[Column, ...]
    key: tuple[str, ...] = ()
    keep_extra_columns: bool = False
    header_row: int = 0
    drop_blank_rows: bool = True

    @property
    def candidates(self) -> tuple[str, ...]:
        return (self.sheet,) if isinstance(self.sheet, str) else tuple(self.sheet)


class ExcelSchemaError(ValueError):
    def __init__(self, path: Path, sheet: str | None, problems: Sequence[str]) -> None:
        self.path = Path(path)
        self.sheet = sheet
        self.problems = list(problems)
        shown = self.problems[:MAX_PROBLEMS_SHOWN]
        more = f"\n  ... and {len(self.problems) - len(shown)} more" if len(self.problems) > len(shown) else ""
        where = f"{self.path.name}" + (f" [{sheet}]" if sheet else "")
        super().__init__(f"{where}: {len(self.problems)} problem(s):\n  - " + "\n  - ".join(shown) + more)


def _coerce(value: Any, dtype: str, date_format: str = "%Y-%m-%d") -> tuple[Any, bool]:
    """(converted value, ok). Empty cells become None and are 'ok' (nullability is checked separately)."""
    if value is None or (isinstance(value, float) and pd.isna(value)) or (isinstance(value, str) and not value.strip()):
        return None, True
    try:
        if pd.isna(value):
            return None, True
    except (TypeError, ValueError):
        pass
    if dtype == "str":
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        return re.sub(r"\s+", " ", str(value).strip()), True
    if dtype == "int":
        if isinstance(value, bool):
            return None, False
        if isinstance(value, (int,)) or (hasattr(value, "item") and float(value).is_integer()):
            return int(value), True
        if isinstance(value, float):
            return (int(value), True) if value.is_integer() else (None, False)
        text = str(value).strip()
        return (int(text), True) if re.fullmatch(r"-?\d+", text) else (None, False)
    if dtype == "float":
        try:
            return float(str(value).replace(",", "")) if isinstance(value, str) else float(value), True
        except ValueError:
            return None, False
    if dtype == "date":
        if isinstance(value, _dt.datetime):
            return value.date(), True
        if isinstance(value, _dt.date):
            return value, True
        text = str(value).strip()
        for fmt in (date_format, "%Y-%m-%d", "%Y-%m-%d %H:%M:%S"):
            try:
                return _dt.datetime.strptime(text, fmt).date(), True
            except ValueError:
                continue
        return None, False
    if dtype == "bool":
        if isinstance(value, bool):
            return value, True
        text = str(value).strip().lower()
        if text in _TRUE:
            return True, True
        if text in _FALSE:
            return False, True
        return None, False
    return value, True


class ExcelSource:
    def __init__(self, input_dir: Path) -> None:
        self.input_dir = Path(input_dir)

    def path(self, file_name: str) -> Path:
        return self.input_dir / file_name

    @staticmethod
    def file_hash(path: Path) -> str:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()

    def read(self, file_name: str, schema: SheetSchema) -> pd.DataFrame:
        path = self.path(file_name)
        if not path.exists():
            raise ExcelSchemaError(path, None, [f"file not found in {self.input_dir}"])
        workbook = pd.ExcelFile(path)
        by_norm = {_norm_header(s): s for s in workbook.sheet_names}
        sheet = next((by_norm[_norm_header(c)] for c in schema.candidates if _norm_header(c) in by_norm), None)
        if sheet is None:
            raise ExcelSchemaError(path, None, [f"no sheet named {' / '.join(schema.candidates)} (sheets: {', '.join(workbook.sheet_names)})"])
        raw = pd.read_excel(workbook, sheet_name=sheet, header=schema.header_row, dtype=object)
        return validate_frame(raw, schema, path=path, sheet=sheet)


def validate_frame(raw: pd.DataFrame, schema: SheetSchema, *, path: Path = Path("<frame>"), sheet: str | None = None) -> pd.DataFrame:
    """Validates and coerces an already-read sheet. Separate from ``ExcelSource.read`` for unit tests."""
    problems: list[str] = []
    header_map: dict[str, str] = {}
    present = {_norm_header(c): c for c in raw.columns}
    for col in schema.columns:
        for candidate in (col.name, *col.aliases):
            if _norm_header(candidate) in present:
                header_map[present[_norm_header(candidate)]] = col.name
                break
        else:
            if col.required:
                problems.append(f"missing column '{col.name}'" + (f" (or {', '.join(col.aliases)})" if col.aliases else ""))
    if problems:
        raise ExcelSchemaError(path, sheet, problems)

    df = raw.rename(columns=header_map)
    declared = [c.name for c in schema.columns if c.name in df.columns]
    if schema.drop_blank_rows and len(df):
        blank = df[declared].apply(lambda s: s.map(lambda v: v is None or (isinstance(v, float) and pd.isna(v)) or (isinstance(v, str) and not v.strip()))).all(axis=1)
        df = df[~blank]
    first_excel_row = schema.header_row + 2  # 1-based, plus the header line

    out = pd.DataFrame(index=df.index)
    for col in schema.columns:
        if col.name not in df.columns:
            out[col.name] = None
            continue
        converted = []
        for idx, value in df[col.name].items():
            v, ok = _coerce(value, col.dtype, col.date_format)
            excel_row = int(idx) + first_excel_row
            if not ok:
                problems.append(f"row {excel_row}: '{col.name}' = {value!r} is not a valid {col.dtype}")
            elif v is None and not col.nullable:
                problems.append(f"row {excel_row}: '{col.name}' is empty")
            elif v is not None and col.allowed is not None and v not in col.allowed:
                problems.append(f"row {excel_row}: '{col.name}' = {v!r} is not one of {', '.join(map(str, col.allowed))}")
            converted.append(v)
        out[col.name] = pd.Series(converted, index=df.index, dtype=object)
        if col.unique:
            series = out[col.name].dropna()
            dups = series[series.duplicated(keep=False)]
            for value in sorted(set(dups.tolist()), key=str):
                rows = [str(int(i) + first_excel_row) for i in dups[dups == value].index]
                problems.append(f"'{col.name}' value {value!r} appears more than once (rows {', '.join(rows)})")
    if schema.key:
        key_df = out[list(schema.key)]
        dup = key_df.duplicated(keep=False) & key_df.notna().all(axis=1)
        for _, group in key_df[dup].groupby(list(schema.key), dropna=True):
            rows = [str(int(i) + first_excel_row) for i in group.index]
            problems.append(f"key ({', '.join(schema.key)}) = {tuple(group.iloc[0])} appears more than once (rows {', '.join(rows)})")
    if problems:
        raise ExcelSchemaError(path, sheet, problems)
    if schema.keep_extra_columns:
        extras = [c for c in df.columns if c not in out.columns]
        for c in extras:
            out[c] = df[c]
    out = out.reset_index(drop=True)
    out.attrs["excel_rows"] = [int(i) + first_excel_row for i in df.index]
    return out
