# Automation

Power BI Service refresh times:

- `09:00`
- `12:00`
- `15:00`
- `18:00`
- `21:00`

The pipeline must finish 2-3 minutes before each refresh starts.

## Measured Runtime

Original full extract SQL measurement:

- Start: `2026-04-29 11:46:18`
- End: `2026-04-29 12:02:47`
- Total duration: `16.49 minutes`
- Status: `SUCCESS`
- SQL row-count mismatches: `0`

After the hybrid incremental staging change, the production incremental SQL run measured:

- Start: `2026-04-29 13:57:28`
- End: `2026-04-29 14:00:28`
- Total duration: `3.01 minutes`
- Status: `SUCCESS`
- SQL row-count mismatches: `0`

Step durations:

- `validate_config_and_inputs`: `0.00 minutes`
- `odoo_authenticate`: `0.01 minutes`
- `extract_sale_report`: `8.56 minutes`
- `extract_crm_models`: `1.26 minutes`
- `transform_sales_model`: `0.68 minutes`
- `transform_crm_model`: `0.31 minutes`
- `load_database_and_validate`: `5.67 minutes`

For scheduling, the incremental runtime is rounded up to `4 minutes`, then a `3 minute` buffer is added.

## Formula

```text
Pipeline Start Time = Power BI Refresh Time - Total Pipeline Runtime - 3 minutes buffer
```

Using the rounded incremental runtime:

```text
Pipeline Start Time = Power BI Refresh Time - 4 minutes - 3 minutes
```

## Final Start Times

| Power BI Refresh | Pipeline Start |
|---|---|
| `09:00` | `08:53` |
| `12:00` | `11:53` |
| `15:00` | `14:53` |
| `18:00` | `17:53` |
| `21:00` | `20:53` |

This gives about `4 minutes` of readiness buffer based on the measured `3.01 minute` runtime.

## Scheduled Command

Each Windows task runs:

```powershell
python -m sales_pipeline.main --output sql --scheduled-refresh-time HH:MM
```

The task wrapper writes timestamped logs to:

```text
C:\Users\Lenovo\Desktop\PowerBIData\powerbi_sales_pipeline\logs
```

## Setup Files

- `scripts\generate_windows_tasks.py`
- `scripts\setup_windows_tasks.ps1`
- `scripts\run_pipeline_task.ps1`

Regenerate the schedule after a new runtime measurement:

```powershell
python scripts\generate_windows_tasks.py --runtime-minutes 3.01 --buffer-minutes 3 --output-mode sql
```

Register or update the Windows tasks:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_windows_tasks.ps1
```

## Verify Scheduled Tasks

```powershell
Get-ScheduledTask |
  Where-Object { $_.TaskName -like 'PowerBI Sales Pipeline before*' } |
  Select-Object TaskName,State
```

## Verify Run History

```sql
SELECT run_id,
       scheduled_refresh_time,
       pipeline_start_time,
       pipeline_end_time,
       total_duration_minutes,
       status,
       odoo_extract_count,
       db_loaded_count,
       qa_issues_count,
       created_at
FROM public.pipeline_run_log
ORDER BY run_id DESC
LIMIT 10;
```

## Failure Handling

The pipeline stops on extraction failure, transformation failure, database load failure, or SQL row-count QA mismatch. Failed SQL runs are written to `pipeline_run_log` when the database is reachable, and detailed logs are written to the task log file.
