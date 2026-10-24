@echo off
rem downloadx native messaging host launcher.
rem The browser manifest must point at an executable; node cannot be given
rem the script as an argument there, so this shim carries the command line.
"C:\Program Files\nodejs\node.exe" "%~dp0host.mjs" %*
