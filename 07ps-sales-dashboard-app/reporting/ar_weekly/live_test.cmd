@echo off
rem Live test: packages, Odoo connection check, recipients update, full report with an email dry run.
rem Everything is written to live_test_result.txt next to this file. Nothing is emailed.
setlocal
cd /d "%~dp0"
set "OUT=%~dp0live_test_result.txt"
echo Live test started %DATE% %TIME% > "%OUT%"
echo Running... this window closes by itself. Do not close it.
if not exist ".venv\Scripts\python.exe" (
  echo ===== SETUP ===== >> "%OUT%"
  call setup.cmd >> "%OUT%" 2>&1
)
echo ===== PACKAGES ===== >> "%OUT%"
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt >> "%OUT%" 2>&1
echo ===== CHECK ===== >> "%OUT%"
call run_weekly.cmd --check >> "%OUT%" 2>&1
if errorlevel 1 goto end
echo ===== UPDATE RECIPIENTS ===== >> "%OUT%"
call run_weekly.cmd --update-recipients >> "%OUT%" 2>&1
echo ===== REPORT ===== >> "%OUT%"
call run_weekly.cmd --dry-run-email >> "%OUT%" 2>&1
:end
echo ===== FINISHED %DATE% %TIME% (exit %ERRORLEVEL%) ===== >> "%OUT%"
endlocal
