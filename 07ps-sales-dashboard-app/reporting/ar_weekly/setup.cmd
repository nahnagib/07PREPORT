@echo off
rem One-time setup: creates a private Python environment and installs pandas + openpyxl.
setlocal
cd /d "%~dp0"
where py >nul 2>nul && (py -3 -m venv .venv) || (python -m venv .venv)
if errorlevel 1 (echo Could not create the Python environment. Is Python 3.10+ installed? & exit /b 1)
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 exit /b 1
echo.
echo Setup done. Next: run_weekly.cmd --check
