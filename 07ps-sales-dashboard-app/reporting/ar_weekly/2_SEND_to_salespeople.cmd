@echo off
title AR Weekly Report - SEND to salespeople
cd /d "%~dp0"
echo.
echo  REAL RUN: builds the report for last week from Odoo and emails each salesperson
echo  their report (as set in Input\AR_Report_Recipients.xlsx), plus the team summary.
echo.
set /p OK=  Type YES and press Enter to send, anything else to cancel: 
if /i not "%OK%"=="YES" (echo  Cancelled, nothing sent. & pause & exit /b 0)
echo.
call run_weekly.cmd --send
echo.
echo  Finished. The list above (Email plan) shows what was sent.
pause
