# Performance Optimization Summary

## Implemented Changes

| Bottleneck | Optimization / exact code | Equivalence |
|---|---|---|
| Incremental staging built `_sales_raw_from_staged_order_lines` from the full raw line table, then immediately replaced it with `raw_sale_report_api`. | `PowerBISalesPipeline._sync_and_read_staging` no longer reads the complete raw line table or builds the discarded merge. | Equivalent because `run` always replaces this value through `_sync_incremental_sale_report_cache` before transformation. |
| Incremental `sale.report` cache read all history into pandas, parsed all dates, concatenated the changed window, then dropped/recreated the full SQL table. | Added `StagingStore.replace_date_window`; `_sync_incremental_sale_report_cache` now deletes/inserts only the overlap window and reads the final cache once. | Same unchanged rows plus the same complete changed window. |
| Unchanged SalesTeam, targets, and product workbooks were fingerprinted but reparsed every incremental run. | Added `ReferenceDataCache`; `transform(... use_reference_cache=True)` reuses pipeline-owned parsed objects and invalidates on path/size/mtime/version change. | Cache stores the exact parsed result; changed or unreadable cache falls back to existing loaders. |
| Major stages lacked an optional function-level profile. | Added `optional_profiler` and CLI `--profile`. | Observability only. |
| Test invocation depended on external `PYTHONPATH`. | Added pytest `pythonpath` configuration. | Test environment only. |
| Performance changes needed stronger regression protection. | Added `ModelValidator`, `--strict`, referential checks, and JSON schema/row/KPI manifests. | Validation only; no business transformations changed. |

## Measured Result

Local reference-data benchmark using the actual input workbooks:

- Cold parse/cache population: 8.2779 seconds.
- Warm cache load: 0.4227 seconds.
- Reduction: approximately 94.9%.

An end-to-end incremental SQL benchmark requires live Odoo and configured production SQL credentials. Stage timings and `--profile` are ready to capture that comparison without changing outputs.

## Remaining Bottlenecks And Risks

- Modeled pandas tables are still rebuilt from cached full history to preserve legacy equivalence.
- Customer dimension performs multiple groupbys/merges; vectorizing/restructuring it needs dedicated output-parity benchmarks.
- CRM raw tables are intentionally full-refreshed for schema safety.
- Full Excel export and full mirror validation remain expensive by design.
- Odoo offset paging can degrade at very high row counts; switching to cursor-based paging requires careful domain-equivalence testing.
- Validation of the current workbook found 128 duplicate `Fact_Lead.LeadID` rows and 67,169 `Fact_Delivery.OrderDateKey` rows missing from the workbook's `Dim_Date`. Normal mode warns; `--strict` fails until these accepted-baseline issues are resolved or confirmed.
