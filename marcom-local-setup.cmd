@echo off
rem MARCOM enhancements -- local setup (feature/marcom-enhancements):
rem   1. backs up marcom_brand + marcom_campaign_media, 2. applies migrations 0057 (brand -> company) and 0058 (media city),
rem   3. rebuilds the local Docker stack,
rem   4. opens the MARCOM Upload page to assign each brand to its company.
rem Local only: uses the MySQL on this PC (backend\.env) and the 07ps-local Docker project. Double-click to run.
rem Everything is also written to marcom-local-setup.log next to this file.
setlocal
set "ROOT=%~dp0"
set "APP=%~dp007ps-sales-dashboard-app"
set "LOG=%~dp0marcom-local-setup.log"
set "MYSQL_BIN=C:\Program Files\MySQL\MySQL Server 8.0\bin"
echo MARCOM local setup %DATE% %TIME% > "%LOG%"

for /f "usebackq tokens=1,* delims==" %%A in ("%APP%\backend\.env") do (
  if "%%A"=="DB_PORT" set "DB_PORT=%%~B"
  if "%%A"=="DB_USER" set "DB_USER=%%~B"
  if "%%A"=="DB_PASSWORD" set "DB_PASSWORD=%%~B"
  if "%%A"=="DB_NAME" set "DB_NAME=%%~B"
)
set "DB_HOST=127.0.0.1"
if not defined DB_PORT set "DB_PORT=3306"
if not defined DB_NAME set "DB_NAME=powerBI_Data"
if not defined DB_USER (call :fail "backend\.env has no DB_USER" & goto end)

cd /d "%APP%" || (call :fail "folder not found: %APP%" & goto end)

echo.
echo [1/4] Backing up marcom_brand and marcom_campaign_media...
echo [1/4] backup >> "%LOG%"
for /f %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%D"
if exist "%MYSQL_BIN%\mysqldump.exe" (
  "%MYSQL_BIN%\mysqldump.exe" -h %DB_HOST% -P %DB_PORT% -u %DB_USER% -p%DB_PASSWORD% %DB_NAME% marcom_brand marcom_campaign_media nps_followup_case > "db_backups\marcom_pre_0057_0058_%STAMP%.sql" 2>> "%LOG%"
  if errorlevel 1 (call :fail "backup failed - see the log" & goto end)
  echo     saved db_backups\marcom_pre_0057_0058_%STAMP%.sql
  echo     backup ok: db_backups\marcom_pre_0057_0058_%STAMP%.sql >> "%LOG%"
) else (
  echo     mysqldump not found at %MYSQL_BIN% - skipping the backup ^(the migration only adds a nullable column^).
  echo     backup skipped: no mysqldump >> "%LOG%"
)

echo.
echo [2/4] Applying migrations 0057 to 0060 (safe to run again)...
echo [2/4] migration >> "%LOG%"
python -c "import pymysql" 2>nul || python -m pip install --quiet pymysql >> "%LOG%" 2>&1
python data\warehouse\apply_migrations.py 0057_marcom_brand_company.sql 0058_marcom_media_city.sql 0059_nps_followup_owner_text.sql 0060_coming_soon_pages.sql >> "%LOG%" 2>&1
if errorlevel 1 (call :fail "migration failed - see the log" & goto end)
echo     migration ok
echo     migration ok >> "%LOG%"

echo.
echo [3/4] Rebuilding the local Docker stack (a few minutes)...
echo [3/4] docker >> "%LOG%"
docker info >nul 2>&1 || (call :fail "Docker Desktop is not running - start it and run this again" & goto end)
docker compose -p 07ps-local -f docker-compose.yml -f docker-compose.local.yml up -d --build >> "%LOG%" 2>&1
if errorlevel 1 (call :fail "docker build/start failed - see the log" & goto end)
docker compose -p 07ps-local ps >> "%LOG%" 2>&1
echo     stack started
echo     docker ok >> "%LOG%"

echo.
echo [4/4] Waiting for the app, then opening MARCOM Upload...
set /a TRIES=0
:wait_app
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://localhost:13000/Dashboard/login).StatusCode } catch { 0 }" | findstr /B "200" >nul && goto app_up
set /a TRIES+=1
if %TRIES% GEQ 40 (echo     the app is still starting - open http://localhost:13000/Dashboard/admin/marcom-upload yourself in a minute. & goto done)
ping -n 6 127.0.0.1 >nul
goto wait_app
:app_up
start "" "http://localhost:13000/Dashboard/admin/marcom-upload"
:done
echo SUCCESS >> "%LOG%"
echo.
echo Done. On the MARCOM Upload page, use the "Brand -> Company" card to assign each brand.
goto end

:fail
echo.
echo FAILED: %~1
echo FAILED: %~1 >> "%LOG%"
exit /b 1

:end
echo.
echo Log: %LOG%
pause
