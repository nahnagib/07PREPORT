# Known Issues

Tracked source-data defects that the ingestion pipeline deliberately does **not** patch, filter,
or silently correct. Per standing direction: report, don't silently fix. Each entry here should be
fixed at the source (the Excel input file) once the maintainer is able to, not worked around in
the pipeline or warehouse.

---

## 1. `TK-WST-BB` target rows carry a broken `TargetDate` (1970-01-01)

- **Status:** Pending source-file fix. Not corrected in the pipeline or warehouse.
- **Found:** 2026-07-05, during ingestion-layer reconciliation against the real
  `SalesModel_OneOutput.xlsx` export (`Fact_Targets` sheet).
- **Row count:** 12 rows.
- **Where:** `sales_targets.xlsx` (source Input file) -> `Fact_Targets` sheet (pipeline export) ->
  `fact_target_plan` (warehouse table).
- **Symptom:** All 12 rows for `SalesTeamKey = 'TK-WST-BB'` (team: مبيعات طرابلس B2B / Tripoli B2B,
  salesperson "Mohamed Abdulhady", `SalespersonKey = 40`, segment B2B, channel Wholesales) carry
  `TargetDate = 1970-01-01` (the Unix epoch) despite having distinct, valid `Year`/`Month`/
  `YearMonth` values (2026-01 through 2026-12) and distinct, non-zero `Target_Revenue`/
  `Target_Volume` figures per month. `DateKey` for these rows is therefore `19700101`, not the
  correct month-start key.
- **Root cause:** A source-data defect in `sales_targets.xlsx` -- the `TargetDate` field was never
  correctly computed/populated for this one team's rows, even though every other field on those
  rows is valid and distinct per month. Confirmed this is a real data issue, not a pipeline
  transformation bug: the raw `Fact_Targets` sheet in the real, already-produced
  `SalesModel_OneOutput.xlsx` export shows the same broken dates, i.e. it predates and is
  independent of this session's ingestion work.
- **Why it isn't patched here:** Silently rewriting or dropping these rows would hide a real data
  quality problem from whoever maintains `sales_targets.xlsx`, and would make the warehouse's
  target figures for team `TK-WST-BB` inconsistent with the authoritative source export. The
  warehouse is a faithful mirror of what the pipeline produces; fixing dates belongs upstream.
- **Current handling:** `StarSchemaLoader` loads these 12 rows into `fact_target_plan` as-is,
  broken date included. `_extend_dim_date()` back-fills a synthetic `dim_date` row for
  `date_key = 19700101` (weekday/quarter/etc. derived mechanically from that key) purely so the
  foreign key resolves -- this does **not** mean 1970-01-01 is being treated as a meaningful date,
  only that the load doesn't reject the row over it.
- **Impact on Tachometer KPIs:** Any FY/FM Target figure that sums `fact_target_plan` by calendar
  month for team `TK-WST-BB` (or any total that includes it) will not correctly attribute these 12
  rows to their intended month via `date_key` alone -- `Year`/`Month` columns on the same rows are
  correct and can be used as a fallback grain if a monthly rollup for this specific team is needed
  before the source is fixed. Flagged explicitly in `tachometer_kpi_validation.md` wherever this
  team's targets are part of a test-matrix comparison.
- **Recommended fix:** Correct `TargetDate` for these 12 rows directly in `sales_targets.xlsx` once
  it moves to the Google Drive-synced Input folder (see `README.md`), then re-run the pipeline. No
  warehouse or ingestion-code change is needed once the source is fixed -- the loader already
  handles a well-formed date correctly for every other team.
