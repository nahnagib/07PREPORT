@echo off
rem Starts the local TEST stack (project 07ps-test) next to production on this PC.
rem   test-stack-start.cmd            refresh the test database from production, then build and start
rem   test-stack-start.cmd /keepdata  keep the test database as it is, just build and start
rem Frontend http://localhost:3202/Dashboard  backend http://localhost:4201  ETL API http://localhost:4202
rem The test stack only READS production (one mysqldump --single-transaction); it never writes to it.
rem See docs/product_data_runbook.md, "Local test stack".
setlocal
set "APP=%~dp007ps-sales-dashboard-app"
set "MYSQL_BIN=C:\Program Files\MySQL\MySQL Server 8.0\bin"
set "DUMP=%APP%\db_backups\test-stack-copy.sql"
set "IMAGE_TAG=test"
set "COMPOSE=docker compose -p 07ps-test -f docker-compose.yml -f docker-compose.test-stack.yml"

for /f "usebackq tokens=1,* delims==" %%A in ("%APP%\backend\.env") do (
  if "%%A"=="DB_USER" set "TEST_DB_USER=%%~B"
  if "%%A"=="DB_PASSWORD" set "TEST_DB_PASSWORD=%%~B"
  if "%%A"=="DB_NAME" set "PROD_DB_NAME=%%~B"
)
if not defined TEST_DB_USER (echo backend\.env has no DB_USER & exit /b 1)
if not defined TEST_DB_PASSWORD (echo backend\.env has no DB_PASSWORD & exit /b 1)
if not defined PROD_DB_NAME set "PROD_DB_NAME=powerBI_Data"

cd /d "%APP%" || exit /b 1

rem Safety: every service must use the test database, never the production host.
%COMPOSE% config > "%TEMP%\07ps-test-config.yml" || exit /b 1
findstr /C:"DB_HOST: host.docker.internal" /C:"DB_HOST: 127.0.0.1" /C:"DB_HOST: localhost" "%TEMP%\07ps-test-config.yml" >nul
if not errorlevel 1 (echo ABORT: a test-stack service points at the production database host. & exit /b 1)

echo Starting the test database...
%COMPOSE% up -d test-mysql || exit /b 1
set /a TRIES=0
:wait_db
for /f %%H in ('docker inspect -f "{{.State.Health.Status}}" 07ps-test-test-mysql-1') do set "HEALTH=%%H"
if "%HEALTH%"=="healthy" goto db_ready
set /a TRIES+=1
if %TRIES% GEQ 60 (echo The test database did not become healthy. & exit /b 1)
ping -n 4 127.0.0.1 >nul
goto wait_db
:db_ready

if /i "%~1"=="/keepdata" goto start_stack
echo Copying the production database (read-only snapshot)...
if not exist "%APP%\db_backups" mkdir "%APP%\db_backups"
set "MYSQL_PWD=%TEST_DB_PASSWORD%"
"%MYSQL_BIN%\mysqldump.exe" -h127.0.0.1 -P3306 -u%TEST_DB_USER% --single-transaction --routines --triggers --no-tablespaces --default-character-set=utf8mb4 --databases %PROD_DB_NAME% --result-file="%DUMP%"
set "DUMP_RC=%ERRORLEVEL%"
set "MYSQL_PWD="
if not "%DUMP_RC%"=="0" (echo mysqldump failed. & exit /b 1)
echo Loading the copy into the test database...
%COMPOSE% exec -T -e MYSQL_PWD=%TEST_DB_PASSWORD% test-mysql mysql -u%TEST_DB_USER% --default-character-set=utf8mb4 < "%DUMP%" || (echo Restore failed. & exit /b 1)

:start_stack
echo Building and starting the test stack (images 07ps/*:test)...
%COMPOSE% up -d --build || exit /b 1
echo.
echo Test stack is up:  http://localhost:3202/Dashboard   (backend 4201, ETL API 4202, MySQL 127.0.0.1:33309)
echo Schedules are off: start an ETL run from Admin ^> ETL Control Center. Stop with test-stack-stop.cmd
exit /b 0
