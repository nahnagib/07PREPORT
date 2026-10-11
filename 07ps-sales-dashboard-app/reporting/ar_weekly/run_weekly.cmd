@echo off
rem Runs the weekly report. Any options are passed through, e.g.  run_weekly.cmd --rep Marwan
setlocal
cd /d "%~dp0"
set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
rem make sure the needed packages are installed (takes a second when they already are)
"%PY%" -m pip install -q --disable-pip-version-check -r requirements.txt
"%PY%" ar_weekly.py %*
exit /b %ERRORLEVEL%
