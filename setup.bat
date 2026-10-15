@echo off
setlocal
rem Installs everything Tonelith needs: Python (if missing), a private virtual environment and the packages.
rem Safe to run again at any time.  Use "setup.bat /nopause" to skip the final key press.
cd /d "%~dp0"
title Tonelith setup
echo.
echo === Tonelith setup ===
echo.

rem ---- 1. Find Python 3.10 or newer ------------------------------------------------------------
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY (
  python --version >nul 2>&1 && set "PY=python"
)
if not defined PY goto :nopython

%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if errorlevel 1 goto :oldpython
for /f "delims=" %%v in ('%PY% --version') do echo [1/4] Found %%v
goto :venv

:nopython
echo [1/4] Python was not found.
where winget >nul 2>&1
if errorlevel 1 goto :manualpython
echo       Python 3.12 can be installed now with winget.
choice /m "      Install Python 3.12"
if errorlevel 2 goto :manualpython
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto :manualpython
echo.
echo Python was installed. Close this window and run setup.bat again so Windows picks it up.
goto :done

:oldpython
echo [1/4] This Python is too old. Tonelith needs Python 3.10 or newer.
:manualpython
echo       Install Python from https://www.python.org/downloads/ and tick "Add python.exe to PATH",
echo       then run setup.bat again.
set "FAILED=1"
goto :done

rem ---- 2. Virtual environment ------------------------------------------------------------------
:venv
if exist ".venv\Scripts\python.exe" (
  echo [2/4] Virtual environment already exists.
) else (
  echo [2/4] Creating virtual environment in .venv ...
  if exist ".venv" rmdir /s /q ".venv"
  %PY% -m venv .venv
  if errorlevel 1 goto :fail
)

rem ---- 3. Packages -----------------------------------------------------------------------------
echo [3/4] Installing packages (first time can take a few minutes) ...
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet --disable-pip-version-check
".venv\Scripts\python.exe" -m pip install -r requirements.txt --disable-pip-version-check
if errorlevel 1 goto :fail

rem ---- 4. Check it all imports -----------------------------------------------------------------
echo [4/4] Checking the install ...
".venv\Scripts\python.exe" -c "import flask, numpy, cv2, PIL, pillow_heif, rawpy; from importlib.metadata import version as v; print('      Flask', v('flask'), '| NumPy', numpy.__version__, '| OpenCV', cv2.__version__, '| Pillow', PIL.__version__, '| LibRaw', '.'.join(map(str, rawpy.libraw_version)))"
if errorlevel 1 goto :fail

if not exist "data" mkdir "data"
echo.
echo Setup complete. Start Tonelith with run.bat
goto :done

:fail
echo.
echo Setup failed. Scroll up for the first error message. If a package has no build for your Python
echo version, installing Python 3.12 from python.org usually fixes it.
set "FAILED=1"

:done
echo.
if /i not "%~1"=="/nopause" pause
if defined FAILED exit /b 1
exit /b 0
