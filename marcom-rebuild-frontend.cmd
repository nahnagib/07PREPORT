@echo off
rem Rebuilds and restarts only the local frontend container (07ps-local) so the latest page changes show up.
rem Double-click to run. Takes a few minutes. Log: marcom-rebuild-frontend.log next to this file.
setlocal
set "APP=%~dp007ps-sales-dashboard-app"
set "LOG=%~dp0marcom-rebuild-frontend.log"
cd /d "%APP%" || (echo folder not found & pause & exit /b 1)
echo Rebuilding the frontend (a few minutes)...
echo rebuild %DATE% %TIME% > "%LOG%"
docker compose -p 07ps-local -f docker-compose.yml -f docker-compose.local.yml build frontend >> "%LOG%" 2>&1 || (echo FAILED - see %LOG% & echo FAILED >> "%LOG%" & pause & exit /b 1)
docker compose -p 07ps-local -f docker-compose.yml -f docker-compose.local.yml up -d --force-recreate frontend >> "%LOG%" 2>&1 || (echo FAILED - see %LOG% & echo FAILED >> "%LOG%" & pause & exit /b 1)
echo SUCCESS >> "%LOG%"
echo Done. Wait about 20 seconds, then refresh the MARCOM page with Ctrl+F5.
pause
