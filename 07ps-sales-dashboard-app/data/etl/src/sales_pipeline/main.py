from __future__ import annotations

import argparse
import logging
import sys

from config.settings import Settings
from sales_pipeline.pipeline import OutputMode, PowerBISalesPipeline
from sales_pipeline.runtime import optional_profiler


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Odoo sales and CRM Power BI pipeline.")
    parser.add_argument(
        "--output",
        choices=["excel", "sql", "both"],
        default="sql",
        help="Export target. Use 'excel' for workbook only, 'sql' for database only, or 'both'.",
    )
    parser.add_argument(
        "--load-mode",
        choices=["full", "incremental"],
        default="full",
        help="Use 'full' for the proven full sale.report export, or 'incremental' for SQL-backed staging updates.",
    )
    parser.add_argument(
        "--scheduled-refresh-time",
        default=None,
        help="Optional Power BI refresh label, for example 09:00. Stored in pipeline_run_log.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Run immediately in incremental mode using the normal overlap window. Useful for manual updates.",
    )
    parser.add_argument(
        "--full-refresh",
        action="store_true",
        help="Rebuild raw staging from Odoo before rebuilding final outputs.",
    )
    parser.add_argument(
        "--force-sales-full-refresh",
        action="store_true",
        help="Fully reload raw sale.order and sale.order.line only, then rebuild final outputs.",
    )
    parser.add_argument(
        "--odoo-cutoff-utc",
        default=None,
        help="Optional UTC cutoff for sales extraction, for example '2026-04-30 06:48:00'. Applies to sale.order date_order and sale.order.line order date.",
    )
    parser.add_argument(
        "--full-validation",
        action="store_true",
        help="Run full SQL/DataFrame mirror validation even in incremental mode.",
    )
    parser.add_argument(
        "--include-qa",
        action="store_true",
        help="Include QA sheets/tables during incremental SQL runs. By default expensive QA exports are skipped for SQL-only incremental runs.",
    )
    parser.add_argument(
        "--fast",
        action="store_true",
        help="Use the fast SQL incremental path: skip Excel, skip QA exports, and run only scoped SQL validations.",
    )
    parser.add_argument("--strict", action="store_true", help="Treat null modeled keys and validation warnings as run failures.")
    parser.add_argument("--profile", action="store_true", help="Write cProfile output and a cumulative-time report to the logs directory.")
    parser.add_argument("--validation-baseline", default=None, help="Compare schemas, row counts, and core KPI totals with a prior JSON manifest.")
    parser.add_argument("--write-validation-baseline", default=None, help="Write the current schemas, row counts, and core KPI totals to a JSON manifest.")
    return parser.parse_args(argv)


def main() -> int:
    configure_logging()
    try:
        args = parse_args()
        settings = Settings.from_env()
        profile_path = settings.output_dir.parent / "powerbi_sales_pipeline" / "logs" / "pipeline_profile.prof"
        with optional_profiler(args.profile, profile_path):
            result = PowerBISalesPipeline(settings).run(
                output_mode=args.output,
                load_mode=args.load_mode,
                scheduled_refresh_time=args.scheduled_refresh_time,
                force=args.force,
                full_refresh=args.full_refresh,
                force_sales_full_refresh=args.force_sales_full_refresh,
                odoo_cutoff_utc=args.odoo_cutoff_utc,
                full_validation=args.full_validation,
                include_qa=args.include_qa,
                fast=args.fast,
                strict=args.strict,
                validation_baseline=args.validation_baseline,
                write_validation_baseline=args.write_validation_baseline,
            )
        if result.workbook_path:
            logging.getLogger(__name__).info("Excel output: %s", result.workbook_path)
        if result.sql_result:
            mismatches = len(result.sql_result.mismatches)
            logging.getLogger(__name__).info("SQL output complete. Row-count mismatches: %s", mismatches)
        logging.getLogger(__name__).info("Total duration: %.2f minutes", result.total_duration_minutes)
        logging.getLogger(__name__).info("Load mode: %s | Full refresh: %s | Force: %s", result.load_mode, result.full_refresh, result.force)
        logging.getLogger(__name__).info("Done")
        return 0
    except Exception:
        logging.getLogger(__name__).exception("Pipeline failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
