@echo off
rem Queue a URL with the running daemon and then show the queue.
rem
rem Starts the daemon if it is not running, so this works as a first command.
rem
rem usage: add.cmd <url>

setlocal
set "HERE=%~dp0"
if "%~1"=="" (
  echo usage: add.cmd ^<url^>
  echo example: add.cmd https://example.com/big.iso
  exit /b 2
)

where node >nul 2>nul
if errorlevel 1 (
  echo downloadx: Node.js was not found on PATH.
  echo Install Node.js 20 or newer from https://nodejs.org and reopen this window.
  exit /b 1
)

node "%HERE%bin\downloadx.mjs" add "%~1"
if errorlevel 1 (
  echo.
  echo The URL was not queued. Run this to see what is wrong:
  echo   node "%HERE%bin\downloadx.mjs" doctor
  exit /b 1
)
node "%HERE%bin\downloadx.mjs" list
endlocal
