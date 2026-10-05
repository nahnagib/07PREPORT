@echo off
rem Stops a local test that was left running (frees ports 3500 and 4500). Touches nothing else.
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 3500,4500 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; 'Local test stopped.'"
