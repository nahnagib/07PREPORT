from __future__ import annotations

import argparse
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Power BI sales pipeline job.")
    parser.add_argument("--mode", choices=["full", "incremental"], default="incremental")
    parser.add_argument("--output", choices=["sql", "excel", "both"], default="both")
    parser.add_argument("--scheduled-refresh-time", default=None)
    parser.add_argument("--odoo-cutoff-utc", default=None)
    parser.add_argument("--fast", action="store_true")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--profile", action="store_true")
    parser.add_argument("--full-validation", action="store_true")
    parser.add_argument("--include-qa", action="store_true")
    parser.add_argument("--validation-baseline", default=None)
    parser.add_argument("--write-validation-baseline", default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project_dir = Path(__file__).resolve().parent
    logs_dir = project_dir / "logs"
    logs_dir.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = logs_dir / f"pipeline_{args.mode}_{args.output}_{timestamp}.log"

    command = [
        sys.executable,
        "-m",
        "sales_pipeline.main",
        "--output",
        args.output,
        "--load-mode",
        args.mode,
    ]
    if args.scheduled_refresh_time:
        command.extend(["--scheduled-refresh-time", args.scheduled_refresh_time])
    if args.odoo_cutoff_utc:
        command.extend(["--odoo-cutoff-utc", args.odoo_cutoff_utc])
    for enabled, flag in [
        (args.fast, "--fast"),
        (args.strict, "--strict"),
        (args.profile, "--profile"),
        (args.full_validation, "--full-validation"),
        (args.include_qa, "--include-qa"),
    ]:
        if enabled:
            command.append(flag)
    if args.validation_baseline:
        command.extend(["--validation-baseline", args.validation_baseline])
    if args.write_validation_baseline:
        command.extend(["--write-validation-baseline", args.write_validation_baseline])

    print(f"Starting pipeline: {' '.join(command)}")
    print(f"Log file: {log_path}")
    with log_path.open("w", encoding="utf-8") as log_file:
        process = subprocess.run(
            command,
            cwd=project_dir,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )

    if process.returncode == 0:
        print(f"Pipeline SUCCESS. See log: {log_path}")
    else:
        print(f"Pipeline FAILED with exit code {process.returncode}. See log: {log_path}")
    return int(process.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
