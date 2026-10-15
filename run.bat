@echo off
rem Starts Tonelith. Any Tonelith server already running on the same port is stopped first (app.py does this).
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo First run: installing prerequisites...
  call setup.bat /nopause
  if errorlevel 1 exit /b 1
)
".venv\Scripts\python.exe" app.py %*
