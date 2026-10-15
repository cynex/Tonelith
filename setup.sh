#!/usr/bin/env bash
# Installs everything Tonelith needs on macOS/Linux: Python (offers Homebrew if missing), a private
# virtual environment and the packages. Safe to run again. "./setup.sh --nopause" skips the final prompt.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

NOPAUSE=0; [ "$1" = "--nopause" ] || [ "$1" = "/nopause" ] && NOPAUSE=1
finish() {  # $1 = exit code
  echo
  if [ "$NOPAUSE" -eq 0 ] && [ -t 0 ]; then read -n 1 -s -r -p "Press any key to close..."; echo; fi
  exit "$1"
}

echo
echo "=== Tonelith setup ==="
echo

# ---- 1. Find Python 3.10 or newer -------------------------------------------------------------
PY=""
for c in python3 python3.13 python3.12 python3.11 python3.10 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
    PY="$c"; break
  fi
done

if [ -z "$PY" ]; then
  echo "[1/4] Python 3.10 or newer was not found."
  if command -v brew >/dev/null 2>&1; then
    read -r -p "      Install Python 3.12 with Homebrew now? [y/N] " ans
    if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
      brew install python@3.12 || { echo "Homebrew could not install Python."; finish 1; }
      echo
      echo "Python was installed. Open a new Terminal window and run ./setup.sh again."
      finish 0
    fi
  fi
  echo "      Install Python from https://www.python.org/downloads/ (or run: brew install python@3.12),"
  echo "      then run ./setup.sh again."
  finish 1
fi
echo "[1/4] Found $("$PY" --version)"

# ---- 2. Virtual environment ---------------------------------------------------------------------
venv_python() {
  if [ -x .venv/bin/python ]; then echo .venv/bin/python
  elif [ -x .venv/Scripts/python.exe ]; then echo .venv/Scripts/python.exe; fi
}
VPY="$(venv_python)"
if [ -n "$VPY" ]; then
  echo "[2/4] Virtual environment already exists."
else
  echo "[2/4] Creating virtual environment in .venv ..."
  rm -rf .venv
  "$PY" -m venv .venv || { echo "Could not create the virtual environment."; finish 1; }
  VPY="$(venv_python)"
fi

# ---- 3. Packages -----------------------------------------------------------------------------------
fail() {
  echo
  echo "Setup failed. Scroll up for the first error message. If a package has no build for your Python"
  echo "version, installing Python 3.12 usually fixes it."
  finish 1
}
echo "[3/4] Installing packages (first time can take a few minutes) ..."
"$VPY" -m pip install --upgrade pip --quiet --disable-pip-version-check
"$VPY" -m pip install -r requirements.txt --disable-pip-version-check || fail

# ---- 4. Check it all imports -------------------------------------------------------------------------
echo "[4/4] Checking the install ..."
"$VPY" -c "import flask, numpy, cv2, PIL, pillow_heif, rawpy; from importlib.metadata import version as v; print('      Flask', v('flask'), '| NumPy', numpy.__version__, '| OpenCV', cv2.__version__, '| Pillow', PIL.__version__, '| LibRaw', '.'.join(map(str, rawpy.libraw_version)))" || fail

mkdir -p data
echo
echo "Setup complete. Start Tonelith with ./run.sh"
finish 0
