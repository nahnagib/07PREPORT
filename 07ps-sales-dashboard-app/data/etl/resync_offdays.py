"""One-off, targeted re-sync of just Fact_OffDays from Input/OffDays.xlsx.

Reuses the real OffDaysFactBuilder + DatabaseExporter code paths (same ones the full
pipeline uses), scoped to this single small reference table only -- avoids running the
full Odoo-dependent pipeline (not needed here, and not worth the risk/time) just to
pick up the two new HolidayName/Reason columns on a 21-row sheet.
"""
import sys
sys.path.insert(0, "src")

from config.settings import Settings
from sales_pipeline.legacy_transform import OffDaysFactBuilder
from sales_pipeline.export.database_exporter import DatabaseExporter

settings = Settings.from_env(".env")
print(f"DB: {settings.db_host}:{settings.db_port}/{settings.db_name}  reload_mode={settings.db_reload_mode}")

df = OffDaysFactBuilder().build(settings.offdays_path, "Libya")
print(f"Extracted {len(df)} rows from {settings.offdays_path}, columns={df.columns.tolist()}")

exporter = DatabaseExporter(settings)
exporter._write_table("Fact_OffDays", df)
print("Write complete.")

counted = exporter._count_rows("Fact_OffDays")
print(f"Fact_OffDays row count after write: {counted}")
