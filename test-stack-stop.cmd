@echo off
rem Stops the local TEST stack (project 07ps-test). Production is not touched.
rem   test-stack-stop.cmd         stop and remove the containers; keep the test database for next time
rem   test-stack-stop.cmd /purge  also delete the test database and the test volumes
setlocal
cd /d "%~dp007ps-sales-dashboard-app" || exit /b 1
rem Only needed so the compose files can be read; nothing connects with them here.
set "TEST_DB_USER=unused"
set "TEST_DB_PASSWORD=unused"
set "IMAGE_TAG=test"
set "PURGE="
if /i "%~1"=="/purge" set "PURGE=-v"
docker compose -p 07ps-test -f docker-compose.yml -f docker-compose.test-stack.yml down %PURGE% || exit /b 1
if defined PURGE (echo Test stack stopped; test database and volumes deleted.) else (echo Test stack stopped; test database kept.)
exit /b 0
