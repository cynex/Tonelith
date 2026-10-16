#!/usr/bin/env bash
# Builds the Tonelith app with PyInstaller. Output: dist/Tonelith.app (macOS) or dist/Tonelith/ (Linux).
# Run it on the machine you want the build for: PyInstaller cannot cross-compile. "--nopause" skips the final prompt.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

NOPAUSE=0; [ "$1" = "--nopause" ] || [ "$1" = "/nopause" ] && NOPAUSE=1
finish() {  # $1 = exit code
  echo
  if [ "$NOPAUSE" -eq 0 ] && [ -t 0 ]; then read -n 1 -s -r -p "Press any key to close..."; echo; fi
  exit "$1"
}

if [ ! -x .venv/bin/python ]; then
  echo "First run: installing prerequisites..."
  bash ./setup.sh --nopause || finish 1
fi
VPY=.venv/bin/python

echo "Installing build requirements..."
"$VPY" -m pip install -q -r requirements.txt -r requirements-build.txt --disable-pip-version-check || { echo "Build failed."; finish 1; }
echo "Building Tonelith..."
"$VPY" -m PyInstaller tonelith.spec --noconfirm || { echo "Build failed."; finish 1; }

echo
if [ "$(uname)" = "Darwin" ]; then
  echo "Build complete: $PWD/dist/Tonelith.app"
  echo "If macOS says the app is damaged or from an unidentified developer, run:"
  echo "  xattr -cr dist/Tonelith.app"
else
  echo "Build complete: $PWD/dist/Tonelith/Tonelith"
fi
finish 0
