"""Builds a vendored ``config_src.settings.Settings`` object pointed at the manual-input Excel
sheets, and validates the 5 required files are present before anything downstream tries to read
them.

This module does NOT reimplement any parsing/validation logic - the vendored pipeline's own
``ProductMasterLoader``, ``SalesOrgRepository``, ``TargetsLoader``, ``BlockedCustomersLoader``,
``OffDaysFactBuilder`` classes (all imported unmodified from ``legacy_transform``/``facts`` in the
vendored package) do that, and are invoked automatically inside ``PowerBISalesPipeline.transform()``
via ``settings.sales_team_path`` / ``settings.targets_path`` / ``settings.products_path`` /
``settings.blocked_customers_path`` / ``settings.offdays_path`` (see vendor's
``config/settings.py``). This module's only job is producing a correctly-pointed ``Settings``
and failing loudly, with a clear message, if a required file is missing - before the pipeline
gets a chance to fail with a less obvious file-not-found deep inside a loader.

Portability note (flagged, not silently patched): the vendored pipeline's own
``Settings.from_env()`` hardcodes a Windows default for INPUT_DIR
(``C:\\Users\\Lenovo\\Desktop\\PowerBIData\\Input``) when the ``INPUT_DIR`` env var isn't set.
That path does not exist on the Linux VPS this app will eventually deploy to. This module makes
``INPUT_DIR`` a required, explicit environment variable in production (no silent Windows-path
fallback) while still allowing local/dev runs to pass an explicit override. See
``../README.md``'s "Input-folder portability" section for the production options this raises
(SFTP drop folder / shared network drive / small internal upload form) - none of them has been
implemented or chosen yet; that decision was explicitly left to be made by the user, not picked
here.
"""
from __future__ import annotations

import os
from pathlib import Path

from config_src.settings import Settings

REQUIRED_INPUT_FILES = [
    "sales_targets.xlsx",
    "SalesTeam.xlsx",
    "OffDays.xlsx",
    "PRODUCTS.xlsx",
    "BlockedCustomers.xlsx",
]


class InputSheetsError(RuntimeError):
    """Raised when the manual-input folder is missing, or missing required files."""


def resolve_input_dir(explicit_override: str | Path | None = None) -> Path:
    """INPUT_DIR resolution order: explicit function argument, then INPUT_DIR env var. Does NOT
    fall back to the vendored pipeline's Windows-path default - that default is real for the
    Data Analyst's own machine but meaningless (and silently wrong) anywhere else this ingestion
    layer runs, most importantly the Linux VPS deployment target.
    """
    if explicit_override is not None:
        return Path(explicit_override)
    env_value = os.environ.get("INPUT_DIR")
    if not env_value:
        raise InputSheetsError(
            "INPUT_DIR is not set. This ingestion layer requires an explicit INPUT_DIR - it will "
            "not silently fall back to the vendored pipeline's own Windows-path default "
            "(C:\\Users\\Lenovo\\Desktop\\PowerBIData\\Input), which does not exist on the Linux "
            "VPS deployment target. Set INPUT_DIR to wherever the manual-input Excel sheets "
            "actually live in this environment - see README.md's portability note for production "
            "intake options that still need a decision."
        )
    return Path(env_value)


def validate_input_dir(input_dir: Path) -> list[str]:
    """Returns a list of human-readable problems (empty list = all good). Does not raise, so
    callers can decide whether a partial set of files is acceptable (e.g. a dry run against only
    some sheets) - the orchestrator treats any non-empty list as a hard failure, per the
    "report, don't silently fix" standard.
    """
    problems = []
    if not input_dir.exists():
        problems.append(f"INPUT_DIR does not exist: {input_dir}")
        return problems
    if not input_dir.is_dir():
        problems.append(f"INPUT_DIR is not a directory: {input_dir}")
        return problems
    for filename in REQUIRED_INPUT_FILES:
        path = input_dir / filename
        if not path.exists():
            problems.append(f"Required input file missing: {path}")
        elif path.stat().st_size == 0:
            problems.append(f"Required input file is empty (0 bytes): {path}")
    return problems


def build_settings(
    input_dir_override: str | Path | None = None,
    output_dir_override: str | Path | None = None,
    env_file: str | Path | None = None,
) -> Settings:
    """Builds a Settings object using the vendored Settings.from_env() (same odoo_url/odoo_db/
    odoo_user/batch_size/timezone/etc defaults and env var names as the original pipeline -
    nothing about those is redefined here), then overrides input_dir/output_dir with portable
    values and validates the input folder before returning.
    """
    settings = Settings.from_env(env_file)
    input_dir = resolve_input_dir(input_dir_override)
    output_dir = Path(output_dir_override) if output_dir_override else settings.output_dir
    # Settings is a frozen dataclass (see vendor/config/settings.py) - replace() gives back a
    # new instance with only input_dir/output_dir overridden, everything else untouched.
    from dataclasses import replace

    settings = replace(settings, input_dir=input_dir, output_dir=output_dir)
    problems = validate_input_dir(settings.input_dir)
    if problems:
        raise InputSheetsError(
            "Input-sheet validation failed:\n  - " + "\n  - ".join(problems)
        )
    output_dir.mkdir(parents=True, exist_ok=True)
    return settings
