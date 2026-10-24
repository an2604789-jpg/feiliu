@echo off
rem downloadx launcher.
rem
rem Starts the daemon in the foreground and prints the address of the web GUI.
rem The daemon has to keep running for downloads to make progress, so leave this
rem window open. Close it, or press Ctrl-C, to stop accepting new work.
rem
rem To open the GUI in a browser as well, run `npm run gui` in another window, or
rem open the address this script prints.

setlocal
set "HERE=%~dp0"
if not exist "%HERE%bin\downloadx.mjs" (
  echo downloadx: bin\downloadx.mjs is missing from "%HERE%".
  echo Run this script from the folder you unpacked downloadx into.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo downloadx: Node.js was not found on PATH.
  echo Install Node.js 20 or newer from https://nodejs.org and reopen this window.
  exit /b 1
)

node "%HERE%bin\downloadx.mjs" daemon --port 0
endlocal
