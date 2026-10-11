"""CLI: python -m etl_platform.run <job> [--date YYYY-MM-DD] [--full] [--dataset X] [--allow-large-change]

Exit codes (backend/src/etl/jobs/runPipelineJob.ts maps them to the etl_job_runs status):
  0 success
  1 the job failed
  2 bad arguments / unknown job or dataset
  3 partial: an optional dependency job failed (finance in full_all), everything else loaded
  4 skipped: another ETL run holds the lock (nothing was written)
Logs go to stdout (the Flask ETL API streams them to the Control Center) and to logs/platform_<job>_<ts>.log.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import logging
import sys
from pathlib import Path

from etl_platform.config import PlatformConfig
from etl_platform.db import RunLockError, create_platform_engine
from etl_platform.registry import REGISTRY, RegistryError, load_definitions
from etl_platform.runner import STATUS_PARTIAL, Runner

LOG_DIR = Path(__file__).resolve().parents[2] / "logs"

EXIT_SUCCESS, EXIT_FAILED, EXIT_USAGE, EXIT_PARTIAL, EXIT_LOCKED = 0, 1, 2, 3, 4


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m etl_platform.run", description="Run a registered ETL job.")
    parser.add_argument("job", nargs="?", help="job name (see --list)")
    parser.add_argument("--date", type=_dt.date.fromisoformat, default=None, help="as-of / snapshot date (default: today, Africa/Tripoli)")
    parser.add_argument("--full", action="store_true", help="full refresh: ignore watermarks and rebuild dependencies")
    parser.add_argument("--dataset", default=None, help="only run the tasks that load this dataset")
    parser.add_argument("--allow-large-change", action="store_true", help="downgrade failing *_change checks to warnings")
    parser.add_argument("--trigger-source", default="cli", help="label stored in etl_run_log.trigger_source")
    parser.add_argument("--env-file", default=None, help=".env file to load (default: environment only)")
    parser.add_argument("--list", action="store_true", help="list registered jobs and datasets, then exit")
    return parser.parse_args(argv)


def _configure_logging(job: str | None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if job:
        try:
            LOG_DIR.mkdir(exist_ok=True)
            stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            handlers.append(logging.FileHandler(LOG_DIR / f"platform_{job}_{stamp}.log", encoding="utf-8"))
        except OSError:
            pass  # read-only checkout: stdout is enough
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", handlers=handlers, force=True)


def _print_catalogue() -> None:
    print("Jobs:")
    for job in sorted(REGISTRY.jobs.values(), key=lambda j: j.name):
        deps = f" (after {', '.join(job.depends_on_jobs)})" if job.depends_on_jobs else ""
        print(f"  {job.name:24} [{job.department}] {len(job.tasks)} task(s){deps}  {job.description}")
    print("Datasets:")
    for ds in sorted(REGISTRY.datasets.values(), key=lambda d: d.name):
        print(f"  {ds.name:32} {ds.layer:7} {ds.source}:{ds.source_object or '-'} -> {ds.target_table} ({ds.load_pattern})")


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    _configure_logging(None if args.list else args.job)
    log = logging.getLogger("etl_platform.run")
    try:
        load_definitions()
        REGISTRY.validate()
    except RegistryError as exc:
        log.error("%s", exc)
        return 2
    if args.list or not args.job:
        _print_catalogue()
        return 0 if args.list else 2
    if args.job not in REGISTRY.jobs:
        log.error("Unknown job '%s'. Registered: %s", args.job, ", ".join(sorted(REGISTRY.jobs)))
        return 2
    config = PlatformConfig.from_env(args.env_file)
    engine = create_platform_engine(config.database_url, config.db_session_timezone)
    runner = Runner(REGISTRY, engine, config)
    try:
        runner.run(
            args.job, as_of=args.date, full_refresh=args.full, dataset=args.dataset,
            allow_large_change=args.allow_large_change, trigger_source=args.trigger_source,
        )
    except RegistryError as exc:
        log.error("%s", exc)
        return EXIT_USAGE
    except RunLockError as exc:
        log.error("Job %s skipped: %s", args.job, exc)
        return EXIT_LOCKED
    except Exception as exc:  # noqa: BLE001 - already logged and recorded by the runner
        log.error("Job %s failed: %s", args.job, exc)
        return EXIT_FAILED
    finally:
        engine.dispose()
    if runner.last_status == STATUS_PARTIAL:
        log.warning("Job %s finished PARTIAL (see etl_run_log.error_message)", args.job)
        return EXIT_PARTIAL
    return EXIT_SUCCESS


if __name__ == "__main__":
    sys.exit(main())
