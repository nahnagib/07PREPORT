@echo off
rem Rebuild the complete local Docker app from this checkout before starting it.
rem Uses the existing local database configured in backend/.env and data/etl/.env.
rem For an isolated database copy, use test-stack-start.cmd instead.
setlocal
cd /d "%~dp007ps-sales-dashboard-app" || exit /b 1
docker compose -p 07ps-local -f docker-compose.yml -f docker-compose.local.yml up -d --build --wait || exit /b 1
echo.
echo Local dashboard: http://localhost:13000/Dashboard
exit /b 0
