@echo off
title AR Weekly Report - TEST (all emails to me)
cd /d "%~dp0"
echo.
echo  TEST RUN: builds the report for last week from Odoo and emails every report
echo  that WOULD go to a salesperson to YOUR mailbox only (subject starts with [TEST]).
echo  Nobody else receives anything.
echo.
call run_weekly.cmd --send --test-to me
echo.
echo  Finished. Check your inbox. The list above (Email plan) shows who would receive what.
pause
