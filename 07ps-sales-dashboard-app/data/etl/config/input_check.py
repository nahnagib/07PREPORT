"""Locating and validating the manual input workbooks (sales targets, sales team, off days, ...).

Kept free of pandas/pipeline imports so it can run cheaply and early: the pipeline's first step, the
Flask ``/etl/preflight`` endpoint and the tests all use the same checks, so what the admin sees in the
dashboard before clicking Run is exactly what the run itself would verify.
"""

from __future__ import annotations

import os
import platform
import re
import tempfile
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# data/etl/ -- relative directory settings resolve against this, never against the process cwd
# (which differs between the Flask API, the pipeline subprocess and ad-hoc CLI runs).
ETL_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_DIR = ETL_ROOT / "input"
DEFAULT_OUTPUT_DIR = ETL_ROOT / "Exports"

REQUIRED_INPUT_FILES: tuple[str, ...] = (
    "sales_targets.xlsx",
    "SalesTeam.xlsx",
    "OffDays.xlsx",
    "PRODUCTS.xlsx",
)
# Loaded on every run, but the pipeline can create an empty template if it is absent (which needs a
# writable input folder) -- so a problem here is reported as a warning, not a blocker, in preflight.
OPTIONAL_INPUT_FILES: tuple[str, ...] = ("BlockedCustomers.xlsx",)

LISTING_LIMIT = 20
_WINDOWS_PATH = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\)")


class InputConfigError(ValueError):
    """The configured directory value itself is unusable on this platform."""


class InputValidationError(Exception):
    """One or more input files are missing/unreadable. ``str(exc)`` is the full explanation."""

    def __init__(self, report: "InputReport") -> None:
        self.report = report
        super().__init__(format_report(report))


def looks_like_windows_path(value: str) -> bool:
    return bool(_WINDOWS_PATH.match(value.strip()))


def windows_path_message(var_name: str, value: str) -> str:
    return (
        f"{var_name}={value!r} is a Windows path, but this process is running on {platform.system()}, "
        "where paths like C:/... do not exist. Fix: mount the folder into the container and set "
        f"{var_name} to the container-side path (docker-compose: ETL_INPUT_HOST_DIR -> /etl/input, "
        "ETL_INPUT_DIR=/etl/input), or under WSL use the /mnt/c/... form of the path."
    )


def resolve_dir(raw: str, var_name: str) -> Path:
    """Turns a configured directory string into an absolute, normalized ``Path``.

    Does not guess: a Windows drive path on a POSIX system raises instead of being translated.
    Relative values resolve against ``ETL_ROOT``.
    """
    value = raw.strip().strip('"').strip("'")
    if os.name != "nt":
        if looks_like_windows_path(value):
            raise InputConfigError(windows_path_message(var_name, raw))
        value = value.replace("\\", "/")
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = ETL_ROOT / path
    return path.resolve()


def env_dir(names: tuple[str, ...], default: Path) -> tuple[Path, str, str]:
    """First set variable in ``names`` (preferred name first) -> (resolved path, var name, raw value)."""
    for name in names:
        raw = os.getenv(name)
        if raw and raw.strip():
            return resolve_dir(raw, name), name, raw
    return default.resolve(), names[0], str(default)


@dataclass
class FileCheck:
    name: str
    path: str
    required: bool
    status: str  # ok | missing | unreadable | invalid_xlsx
    size_bytes: int | None = None
    modified: str | None = None  # ISO-8601 UTC
    near_matches: list[str] = field(default_factory=list)
    detail: str = ""


@dataclass
class InputReport:
    ok: bool
    input_dir: str
    source_var: str
    configured_value: str
    dir_exists: bool
    dir_is_dir: bool
    platform: str
    files: list[FileCheck]
    listing: list[str]
    listing_truncated: bool
    hint: str
    config_error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _check_xlsx(path: Path) -> tuple[str, str]:
    """('ok'|'unreadable'|'invalid_xlsx', detail) -- cheap structural check, no pandas."""
    try:
        with path.open("rb") as fh:
            head = fh.read(2)
    except OSError as exc:
        return "unreadable", f"cannot read file: {exc}"
    if head != b"PK" or not zipfile.is_zipfile(path):
        return "invalid_xlsx", "not a valid .xlsx file (an .xlsx is a zip archive; this one is corrupt, truncated or another format)"
    try:
        with zipfile.ZipFile(path) as zf:
            if "xl/workbook.xml" not in zf.namelist():
                return "invalid_xlsx", "zip archive without xl/workbook.xml -- not an Excel workbook"
            broken = zf.testzip()
            if broken:
                return "invalid_xlsx", f"corrupt archive member {broken!r}"
    except (zipfile.BadZipFile, OSError) as exc:
        return "invalid_xlsx", f"cannot open as a workbook: {exc}"
    return "ok", ""


def _near_matches(name: str, entries: list[str]) -> list[str]:
    lowered, stem = name.lower(), Path(name).stem.lower()
    found = []
    for entry in entries:
        low = entry.lower()
        if entry == name or low.startswith("~$"):
            continue
        if low == lowered or Path(low).stem == stem or low.startswith(stem):
            found.append(entry)
    return found


def inspect_input_dir(
    input_dir: Path,
    *,
    source_var: str = "ETL_INPUT_DIR",
    configured_value: str | None = None,
    required: tuple[str, ...] = REQUIRED_INPUT_FILES,
    optional: tuple[str, ...] = OPTIONAL_INPUT_FILES,
    config_error: str | None = None,
) -> InputReport:
    """Inspects ``input_dir`` and never raises for a bad environment -- the caller decides what to do."""
    exists = input_dir.exists()
    is_dir = input_dir.is_dir()
    entries: list[str] = []
    if is_dir:
        try:
            entries = sorted(p.name for p in input_dir.iterdir())
        except OSError:
            entries = []

    checks: list[FileCheck] = []
    for names, is_required in ((required, True), (optional, False)):
        for name in names:
            path = input_dir / name
            check = FileCheck(name=name, path=str(path), required=is_required, status="missing")
            if is_dir and path.is_file():
                status, detail = _check_xlsx(path)
                check.status, check.detail = status, detail
                try:
                    stat = path.stat()
                    check.size_bytes = stat.st_size
                    check.modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(timespec="seconds")
                except OSError:
                    pass
            else:
                check.near_matches = _near_matches(name, entries)
                if check.near_matches:
                    check.detail = f"expected the exact file name {name!r} (names are case-sensitive on Linux); found {', '.join(check.near_matches)}"
            checks.append(check)

    ok = config_error is None and is_dir and all(c.status == "ok" for c in checks if c.required)
    report = InputReport(
        ok=ok,
        input_dir=str(input_dir),
        source_var=source_var,
        configured_value=configured_value if configured_value is not None else str(input_dir),
        dir_exists=exists,
        dir_is_dir=is_dir,
        platform=platform.system(),
        files=checks,
        listing=entries[:LISTING_LIMIT],
        listing_truncated=len(entries) > LISTING_LIMIT,
        hint="",
        config_error=config_error,
    )
    report.hint = _hint(report)
    return report


def _hint(r: InputReport) -> str:
    if r.config_error:
        return r.config_error
    if not r.dir_exists:
        if r.platform != "Windows" and looks_like_windows_path(r.configured_value):
            return windows_path_message(r.source_var, r.configured_value)
        return (
            f"The input directory does not exist. Likely cause: the folder is not mounted into the container "
            f"(set ETL_INPUT_HOST_DIR in .env and restart the etl-api service) or {r.source_var} points to the wrong place."
        )
    if not r.dir_is_dir:
        return f"{r.input_dir} exists but is not a directory."
    if not r.listing:
        return "The input directory is empty. Likely cause: the wrong host folder is mounted, or the volume is not mounted at all."
    problems = [c for c in r.files if c.required and c.status != "ok"]
    if any(c.near_matches for c in problems):
        return "A file with a different name or letter case exists -- rename it to the exact expected name."
    if any(c.status in ("invalid_xlsx", "unreadable") for c in problems):
        return "A required file exists but is not a readable .xlsx workbook -- re-export or replace it."
    if problems:
        return "Copy the missing workbook(s) into the input directory (they are manual inputs, not produced by the pipeline)."
    return ""


def format_report(r: InputReport) -> str:
    lines = [
        f"Input validation failed: required input files are not usable.",
        f"  Configured : {r.source_var}={r.configured_value}",
        f"  Resolved   : {r.input_dir}  (exists={r.dir_exists}, is_directory={r.dir_is_dir}, runtime={r.platform})",
        "  Files:",
    ]
    for c in r.files:
        tag = "required" if c.required else "optional"
        extra = f" -- {c.detail}" if c.detail else ""
        lines.append(f"    [{c.status.upper():<11}] {c.name} ({tag}){extra}")
    if r.listing:
        more = " ..." if r.listing_truncated else ""
        lines.append(f"  Directory contains ({len(r.listing)} shown{more}): {', '.join(r.listing)}")
    elif r.dir_is_dir:
        lines.append("  Directory contains: (empty)")
    lines.append(f"  Hint: {r.hint}")
    return "\n".join(lines)


def check_writable(path: Path) -> tuple[bool, str]:
    """Whether files can be created in ``path`` (creating it if needed) -- used for the output dir."""
    try:
        path.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path, prefix=".write_probe_", delete=True):
            pass
    except OSError as exc:
        return False, f"{path} is not writable: {exc}"
    return True, ""
