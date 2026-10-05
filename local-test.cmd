@echo off
rem Local test of the dashboard against powerBI_Data, READ-ONLY (no Docker, no ETL, no schedules).
rem   local-test.cmd                 opens the Debt Report signed in as Admin
rem   local-test.cmd b2b             ... as B2B Director   (also: gceo, gcco, salesperson)
rem Close the browser window to stop everything. See docs/local-testing.md.
node "%~dp007ps-sales-dashboard-app\scripts\local-test.mjs" %1
