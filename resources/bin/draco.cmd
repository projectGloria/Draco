@echo off
rem The `draco` command for an installed copy. Add this folder to PATH.
rem
rem Runs the bundled CLI inside Draco.exe as plain Node (the same trick VS Code's
rem `code` command uses), so the CLI needs no separate Node install and always
rem matches the app it shipped with. Lives at <install>\resources\bin.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Draco.exe" "%~dp0draco.cjs" %*
exit /b %ERRORLEVEL%
