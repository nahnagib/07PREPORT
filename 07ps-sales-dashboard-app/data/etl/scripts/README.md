# Windows Task Scheduler

Generate the scheduler setup script after measuring a full SQL pipeline runtime:

```powershell
python scripts\generate_windows_tasks.py --runtime-minutes 18 --buffer-minutes 3 --output-mode sql
```

Then run PowerShell as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_windows_tasks.ps1
```

The generated tasks run:

```powershell
python -m sales_pipeline.main --output sql --scheduled-refresh-time HH:MM
```
