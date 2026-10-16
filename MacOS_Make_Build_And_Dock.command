#!/usr/bin/env bash
# Double-click this file in Finder to build Tonelith.app, put it in Applications and add it to the Dock.
# Run it again after updating the source to rebuild: it replaces the installed app and keeps the one Dock icon.
# First time: if macOS won't open it, right-click it > Open. "--nopause" skips the final prompt.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

NOPAUSE=0; [ "$1" = "--nopause" ] && NOPAUSE=1
finish() {  # $1 = exit code
  echo
  if [ "$NOPAUSE" -eq 0 ] && [ -t 0 ]; then read -n 1 -s -r -p "Press any key to close..."; echo; fi
  exit "$1"
}

if [ "$(uname)" != "Darwin" ]; then
  echo "This installer is for macOS."
  finish 1
fi

# ---- 1. Python and packages (setup.sh does the work the first time) ----------------------------------
if [ ! -x .venv/bin/python ]; then
  echo "First run: installing prerequisites..."
  bash ./setup.sh --nopause || finish 1
fi
VPY=.venv/bin/python

echo "Installing build requirements..."
"$VPY" -m pip install -q -r requirements.txt -r requirements-build.txt --disable-pip-version-check \
  || { echo "Build failed."; finish 1; }

# ---- 2. Build and sign -----------------------------------------------------------------------------------
# Built and signed outside this folder: if it is in Documents or Desktop with iCloud sync on, macOS keeps adding
# Finder metadata to files there, and code signing refuses a bundle that has it (an unsigned app won't run on
# Apple Silicon).
echo "Building Tonelith (this takes a few minutes)..."
WORK="${TMPDIR:-/tmp}/tonelith-build"
rm -rf "$WORK"
"$VPY" -m PyInstaller tonelith.spec --noconfirm --clean --log-level WARN --distpath "$WORK/dist" --workpath "$WORK/work" \
  || { echo "Build failed."; finish 1; }
APP="$WORK/dist/Tonelith.app"
xattr -cr "$APP"
codesign --force --deep -s - "$APP" 2>/dev/null && codesign --verify --deep --strict "$APP" \
  || { echo "Build failed: could not sign the app."; finish 1; }
rm -rf dist/Tonelith.app
mkdir -p dist
ditto --noextattr --norsrc "$APP" dist/Tonelith.app || { echo "Could not copy the app to dist/."; finish 1; }
echo "Built: $PWD/dist/Tonelith.app"

# ---- 3. Install into Applications ----------------------------------------------------------------------
DEST=/Applications
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
pkill -f "$DEST/Tonelith.app/Contents/MacOS/Tonelith" 2>/dev/null && sleep 1  # a running copy holds its files
rm -rf "$DEST/Tonelith.app"
ditto --noextattr --norsrc "$APP" "$DEST/Tonelith.app" || { echo "Could not copy the app to $DEST."; finish 1; }
echo "Installed: $DEST/Tonelith.app"

# ---- 4. Add to the Dock (once) -------------------------------------------------------------------------
if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "/Tonelith.app/"; then
  echo "Tonelith is already in the Dock."
else
  defaults write com.apple.dock persistent-apps -array-add \
    "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://$DEST/Tonelith.app/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>" \
    && killall Dock && echo "Added Tonelith to the Dock."
fi

echo
echo "Done. Start Tonelith from the Dock, Launchpad or Spotlight."
finish 0
