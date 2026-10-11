@echo off
rem Creates the Windows scheduled task: every Sunday at 07:30, report for the week that ended on Saturday.
rem Change /D and /ST below to pick another day or time. Remove with:  schtasks /Delete /TN "07PREPORT\AR Weekly Report" /F
setlocal
schtasks /Create /TN "07PREPORT\AR Weekly Report" /TR "\"%~dp0run_weekly.cmd\" --send" /SC WEEKLY /D SUN /ST 07:30 /F
if errorlevel 1 exit /b 1
echo.
echo Scheduled. It runs while you are signed in to Windows; see README section 5 to run it when signed out.
echo Test it now with:  schtasks /Run /TN "07PREPORT\AR Weekly Report"
