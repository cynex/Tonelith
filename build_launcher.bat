@echo off
rem Builds the Tonelith executable with PyInstaller. Output: dist\Tonelith\Tonelith.exe
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo First run: installing prerequisites...
  call setup.bat /nopause
  if errorlevel 1 exit /b 1
)
echo Installing build requirements...
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt -r requirements-build.txt
if errorlevel 1 goto failed
echo Building Tonelith...
".venv\Scripts\python.exe" -m PyInstaller tonelith.spec --noconfirm
if errorlevel 1 goto failed
echo.
echo Build complete: %~dp0dist\Tonelith\Tonelith.exe
if /i not "%~1"=="/nopause" pause
exit /b 0

:failed
echo.
echo Build failed.
if /i not "%~1"=="/nopause" pause
exit /b 1
