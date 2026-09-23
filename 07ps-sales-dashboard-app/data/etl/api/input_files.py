"""Replacing the ETL's manual input workbooks from the admin dashboard (GET/POST /etl/input-files).

Lives on the ETL API side, not in the Node backend, on purpose: this process resolves ETL_INPUT_DIR
exactly the way the pipeline does (config.input_check.env_dir), so an upload lands in the one folder
the next run will actually read -- whether that is /etl/input in Docker or data/etl/input natively.

An upload is only accepted after the file has been read the way the pipeline reads it:
  1. structural .xlsx check (config.input_check._check_xlsx),
  2. header check -- each loader fills a missing column with blanks instead of failing
     (DataFrameUtils.ensure_columns), so a renamed "Target_Revenue" would otherwise load as empty
     targets without any error. Headers are normalized the same way each loader does it (strip /
     rename / alias) before comparing,
  3. a dry parse through the real loader class, which must yield rows.
The previous file is then copied to the backup folder and the new one swapped in with os.replace.
Nothing here starts, schedules or touches a pipeline run.
"""
from __future__ import annotations

import gc
import hashlib
import os
import shutil
import tempfile
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from config.input_check import (
    DEFAULT_INPUT_DIR,
    ETL_ROOT,
    OPTIONAL_INPUT_FILES,
    REQUIRED_INPUT_FILES,
    _check_xlsx,
    env_dir,
    resolve_dir,
)

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
DEFAULT_BACKUP_DIR = ETL_ROOT / "input_backups"
BACKUP_LISTING_LIMIT = 5

_replace_lock = threading.Lock()


class UploadRejected(Exception):
    """The upload is refused; ``str(exc)`` is shown to the admin as-is."""

    def __init__(self, message: str, status: int = 422, problems: list[str] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.problems = problems or []


@dataclass(frozen=True)
class SheetSpec:
    label: str
    required: tuple[str, ...]
    optional: tuple[str, ...] = ()
    # None = the first sheet (pandas' default, which is what every single-sheet loader reads).
    sheet_candidates: tuple[str, ...] | None = None
    strip_headers: bool = False
    rename: dict[str, str] = field(default_factory=dict)
    # SalesOrgRepository-style alias map (whitespace/case-insensitive), applied via rename_by_alias.
    aliases: dict[str, list[str]] | None = None


@dataclass(frozen=True)
class SlotSpec:
    name: str
    feeds: str
    sheets: tuple[SheetSpec, ...]
    # Runs the real loader on the file; returns {label: row_count}. Raises on unparseable data.
    dry_parse: Callable[[Path], dict[str, int]]
    # Row counts that must be > 0 for the upload to be accepted.
    must_have_rows: tuple[str, ...] = ()


def _loaders():
    # Imported lazily: pandas + the pipeline package are heavy, and /health must not depend on them.
    from sales_pipeline import legacy_transform as lt

    return lt


def _quiet_logger():
    return _loaders().Logger(enabled=False)


def _parse_blocked(path: Path) -> dict[str, int]:
    return {"rows": len(_loaders().BlockedCustomersLoader(_quiet_logger()).load(path))}


def _parse_offdays(path: Path) -> dict[str, int]:
    lt = _loaders()
    return {"rows": len(lt.OffDaysFactBuilder().build(path, lt.PipelineSettings().offdays_country))}


def _parse_products(path: Path) -> dict[str, int]:
    from sales_pipeline.product_name_mapper import ProductNameMapper

    lt = _loaders()
    rows = len(lt.ProductMasterLoader(_quiet_logger(), export_conflicts=False, base_dir=path.parent).load(path))
    mappings = ProductNameMapper(path).mapping_count()
    allow_empty = os.getenv("ETL_ALLOW_EMPTY_PRODUCT_MAPPING", "").strip().lower() in {"1", "true", "yes", "on"}
    if mappings == 0 and not allow_empty:
        # Same guard the pipeline applies at run time (pipeline.py's mapper property): 0 mappings fails the run.
        raise UploadRejected(
            "PRODUCTS.xlsx yields 0 OdooProductName -> ProductName mappings; the next ETL run would fail on it."
        )
    return {"rows": rows, "product_name_mappings": mappings}


def _parse_targets(path: Path) -> dict[str, int]:
    return {"rows": len(_loaders().TargetsLoader(_quiet_logger()).load(path))}


def _parse_sales_team(path: Path) -> dict[str, int]:
    org = _loaders().SalesOrgRepository(_quiet_logger()).load(path)
    return {"active_salespersons": len(org.people_active), "teams": len(org.teams)}


def _slots() -> dict[str, SlotSpec]:
    lt = _loaders()
    targets_optional = ("ChannelKey", "SalespersonKey")  # recomputed by the pipeline, absent from the live file
    specs = [
        SlotSpec(
            name="sales_targets.xlsx",
            feeds="Fact_Targets (and the channel/segment dimensions)",
            sheets=(
                SheetSpec(
                    label="first sheet",
                    required=tuple(c for c in lt.TargetsLoader.EXPECTED if c not in targets_optional),
                    optional=targets_optional,
                    strip_headers=True,
                ),
            ),
            dry_parse=_parse_targets,
            must_have_rows=("rows",),
        ),
        SlotSpec(
            name="SalesTeam.xlsx",
            feeds="Dim_Salesperson, Dim_SalesTeam and the team/channel fields of every sales fact",
            sheets=(
                SheetSpec(
                    label="salesperson sheet",
                    sheet_candidates=tuple(lt.PEOPLE_SHEET_CANDIDATES),
                    required=("Salesperson", "TeamKey", "Status", "DistributionChannel"),
                    aliases=lt.SalesOrgRepository.PEOPLE_ALIAS,
                ),
                SheetSpec(
                    label="sales team sheet",
                    sheet_candidates=tuple(lt.TEAMS_SHEET_CANDIDATES),
                    required=("TeamKey", "TeamName", "Segment", "City", "Company", "Status"),
                    aliases=lt.SalesOrgRepository.TEAM_ALIAS,
                ),
            ),
            dry_parse=_parse_sales_team,
            must_have_rows=("active_salespersons", "teams"),
        ),
        SlotSpec(
            name="OffDays.xlsx",
            feeds="Fact_OffDays",
            sheets=(
                SheetSpec(
                    label="first sheet",
                    # Country is effectively required: the builder keeps only Country == "Libya" rows,
                    # so without it every off day would be dropped.
                    required=("Date", "OffDayType", "Country", "Company", "Branch"),
                    optional=("IsActive", "HolidayName", "Reason"),
                ),
            ),
            dry_parse=_parse_offdays,
            must_have_rows=("rows",),
        ),
        SlotSpec(
            name="PRODUCTS.xlsx",
            feeds="Dim_Product and the Odoo product-name mapping used by every sales fact",
            sheets=(
                SheetSpec(
                    label="first sheet",
                    required=tuple(lt.ProductMasterLoader.EXPECTED),
                    # ProductMasterLoader.load's own rename map (it does not strip headers).
                    rename={
                        "Odoo Nmae": "OdooProductName",
                        "Odoo Name": "OdooProductName",
                        "OdooProduct Name": "OdooProductName",
                        "Subbrand": "SubBrand",
                        "Sub Brand": "SubBrand",
                        "ProductLevet": "ProductLevel",
                        "Product Level": "ProductLevel",
                    },
                ),
            ),
            dry_parse=_parse_products,
            must_have_rows=("rows",),
        ),
        SlotSpec(
            name="BlockedCustomers.xlsx",
            feeds="Dim_Customer (blocked flags)",
            sheets=(
                SheetSpec(
                    label="first sheet",
                    required=tuple(lt.BlockedCustomersLoader.EXPECTED),
                    strip_headers=True,
                    # BlockedCustomersLoader.load's own rename map.
                    rename={
                        "Customer Name": "CustomerName",
                        "Customer": "CustomerName",
                        "Customer ID": "CustomerID",
                        "Customer Code": "CustomerID",
                        "Blocked Reason": "BlockedReason",
                    },
                ),
            ),
            dry_parse=_parse_blocked,
            # An empty blocked-customers list is legitimate (the pipeline itself creates an empty template).
        ),
    ]
    return {s.name: s for s in specs}


SLOT_NAMES: tuple[str, ...] = REQUIRED_INPUT_FILES + OPTIONAL_INPUT_FILES


# ---------------------------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------------------------


def input_dir() -> Path:
    path, _, _ = env_dir(("ETL_INPUT_DIR", "INPUT_DIR"), DEFAULT_INPUT_DIR)
    return path


def backup_dir() -> Path:
    raw = os.getenv("ETL_INPUT_BACKUP_DIR", "").strip()
    return resolve_dir(raw, "ETL_INPUT_BACKUP_DIR") if raw else DEFAULT_BACKUP_DIR.resolve()


def _assert_backup_dir_separate(inputs: Path, backups: Path) -> None:
    if backups == inputs or inputs in backups.parents:
        raise UploadRejected(
            f"ETL_INPUT_BACKUP_DIR ({backups}) must not be the ETL input folder or inside it.", status=500
        )


# ---------------------------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------------------------


def _sheet_headers(path: Path, spec: SheetSpec) -> tuple[str, list[str]]:
    """(sheet name used, headers as the loader would see them after its own renames)."""
    import pandas as pd

    lt = _loaders()
    workbook = pd.ExcelFile(path)
    try:
        if spec.sheet_candidates is None:
            sheet = workbook.sheet_names[0]
        else:
            lower = {name.lower(): name for name in workbook.sheet_names}
            sheet = next((lower[c.lower()] for c in spec.sheet_candidates if c.lower() in lower), None)
            if sheet is None:
                raise UploadRejected(
                    f"No {spec.label} found. Expected a sheet named one of: {', '.join(spec.sheet_candidates)}. "
                    f"The file has: {', '.join(workbook.sheet_names)}."
                )
        frame = pd.read_excel(workbook, sheet_name=sheet, nrows=0)
    finally:
        workbook.close()
    if spec.strip_headers:
        frame.columns = [str(c).strip() for c in frame.columns]
    if spec.rename:
        frame = frame.rename(columns=spec.rename)
    if spec.aliases:
        frame = lt.DataFrameUtils.rename_by_alias(frame, spec.aliases)
    return sheet, [str(c) for c in frame.columns]


def validate_file(name: str, path: Path) -> dict[str, Any]:
    """Raises UploadRejected with every problem found; returns the dry-parse summary otherwise."""
    spec = _slots()[name]
    status, detail = _check_xlsx(path)
    if status != "ok":
        raise UploadRejected(f"{name}: {detail}")

    problems: list[str] = []
    sheets_used: dict[str, str] = {}
    for sheet_spec in spec.sheets:
        try:
            sheet, headers = _sheet_headers(path, sheet_spec)
        except UploadRejected as exc:
            problems.append(str(exc))
            continue
        sheets_used[sheet_spec.label] = sheet
        missing = [c for c in sheet_spec.required if c not in headers]
        if missing:
            problems.append(
                f"{sheet_spec.label} '{sheet}' is missing required column(s): {', '.join(missing)}. "
                f"Found: {', '.join(headers) or '(no header row)'}."
            )
    if problems:
        raise UploadRejected(f"{name} does not have the structure the ETL expects.", problems=problems)

    try:
        counts = spec.dry_parse(path)
    except UploadRejected:
        raise
    except Exception as exc:  # noqa: BLE001 - any loader failure means the next run would fail too
        raise UploadRejected(f"{name} could not be read by the ETL's own loader: {exc}") from exc
    empty = [label for label in spec.must_have_rows if counts.get(label, 0) <= 0]
    if empty:
        raise UploadRejected(
            f"{name} parsed to 0 {', '.join(empty)} -- replacing the current file with it would empty "
            f"{spec.feeds} on the next run."
        )
    return {"sheets": sheets_used, "counts": counts}


# ---------------------------------------------------------------------------------------------
# Listing / replacing
# ---------------------------------------------------------------------------------------------


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_meta(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    stat = path.stat()
    return {"path": str(path), "size_bytes": stat.st_size, "modified": _iso(stat.st_mtime), "sha256": _sha256(path)}


def _recent_backups(backups: Path, name: str) -> list[dict[str, Any]]:
    if not backups.is_dir():
        return []
    stem, suffix = os.path.splitext(name)
    found = [p for p in backups.glob(f"{stem}.*{suffix}") if p.is_file()]
    found.sort(key=lambda p: p.name, reverse=True)
    return [
        {"name": p.name, "size_bytes": p.stat().st_size, "modified": _iso(p.stat().st_mtime)}
        for p in found[:BACKUP_LISTING_LIMIT]
    ]


def describe_slots() -> dict[str, Any]:
    inputs = input_dir()
    backups = backup_dir()
    slots = _slots()
    files = []
    for name in SLOT_NAMES:
        spec = slots[name]
        meta = _file_meta(inputs / name)
        files.append({
            "name": name,
            "required": name in REQUIRED_INPUT_FILES,
            "feeds": spec.feeds,
            "exists": meta is not None,
            "size_bytes": meta["size_bytes"] if meta else None,
            "modified": meta["modified"] if meta else None,
            "sheets": [
                {
                    "label": s.label,
                    "sheet_names": list(s.sheet_candidates) if s.sheet_candidates else None,
                    "required": list(s.required),
                    "optional": list(s.optional),
                }
                for s in spec.sheets
            ],
            "recent_backups": _recent_backups(backups, name),
        })
    return {"input_dir": str(inputs), "backup_dir": str(backups), "max_bytes": MAX_UPLOAD_BYTES, "files": files}


def replace_file(name: str, content: bytes, is_run_active: Callable[[], bool]) -> dict[str, Any]:
    """Validates ``content`` as ``name``, backs up the current file, and swaps the new one in."""
    if name not in SLOT_NAMES:
        raise UploadRejected(f"Unknown input file {name!r}. Expected one of: {', '.join(SLOT_NAMES)}.", status=404)
    if not content:
        raise UploadRejected("The uploaded file is empty.", status=400)
    if len(content) > MAX_UPLOAD_BYTES:
        raise UploadRejected(f"The file is larger than the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.", status=413)

    inputs = input_dir()
    backups = backup_dir()
    _assert_backup_dir_separate(inputs, backups)
    if not inputs.is_dir():
        raise UploadRejected(f"The ETL input folder {inputs} does not exist or is not mounted.", status=500)

    new_sha = hashlib.sha256(content).hexdigest()
    # ignore_cleanup_errors + gc: SalesOrgRepository.load opens a pandas ExcelFile it never closes, and
    # on Windows that open handle keeps the scratch copy locked until the object is collected.
    with tempfile.TemporaryDirectory(prefix="etl_upload_", ignore_cleanup_errors=True) as scratch:
        # Validated under the real filename in a scratch folder, never in the input folder itself.
        candidate = Path(scratch) / name
        candidate.write_bytes(content)
        try:
            summary = validate_file(name, candidate)
        finally:
            gc.collect()

    target = inputs / name
    with _replace_lock:
        # Re-checked under the lock, right before touching the folder: a run reads these files in
        # its first step and PRODUCTS.xlsx is written back at the end, so never swap mid-run.
        if is_run_active():
            raise UploadRejected("An ETL run is in progress. Upload again once it has finished.", status=409)
        previous = _file_meta(target)
        if previous and previous["sha256"] == new_sha:
            raise UploadRejected(f"This file is identical to the current {name}; nothing was replaced.", status=409)

        backup = None
        if previous:
            backups.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            stem, suffix = os.path.splitext(name)
            backup_path = backups / f"{stem}.{stamp}{suffix}"
            counter = 1
            while backup_path.exists():
                backup_path = backups / f"{stem}.{stamp}-{counter}{suffix}"
                counter += 1
            shutil.copy2(target, backup_path)
            backup = {"path": str(backup_path), "size_bytes": backup_path.stat().st_size}

        # Written next to the target (same filesystem, so os.replace is an atomic rename) under a
        # name the pipeline never reads, then swapped in.
        staging = inputs / f".{name}.uploading"
        try:
            with staging.open("wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(staging, target)
        except PermissionError as exc:
            raise UploadRejected(
                f"Could not replace {name}: the file is locked or the folder is read-only ({exc}). "
                "Close it if it is open in Excel and check the input folder is mounted read-write.",
                status=409,
            ) from exc
        finally:
            staging.unlink(missing_ok=True)

    current = _file_meta(target)
    return {
        "name": name,
        "input_dir": str(inputs),
        "previous": previous,
        "current": current,
        "backup": backup,
        "validation": summary,
    }
