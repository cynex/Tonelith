#!/usr/bin/env bash
# Builds the Tonelith app with PyInstaller. Output: dist/Tonelith.app (macOS) or dist/Tonelith/ (Linux).
# Run it on the machine you want the build for: PyInstaller cannot cross-compile.
#   --nopause   skip the final prompt
#   --install   macOS: also copy the app into /Applications (or ~/Applications if /Applications is not writable)
#   --dock      macOS: with --install, also add the app to the Dock (once; skipped if it is already there)
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

NOPAUSE=0; INSTALL=0; DOCK=0
for arg in "$@"; do
  case "$arg" in
    --nopause|/nopause) NOPAUSE=1 ;;
    --install) INSTALL=1 ;;
    --dock) DOCK=1 ;;
  esac
done
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
if [ "$(uname)" != "Darwin" ]; then
  "$VPY" -m PyInstaller tonelith.spec --noconfirm --clean || { echo "Build failed."; finish 1; }
  echo
  echo "Build complete: $PWD/dist/Tonelith/Tonelith"
  finish 0
fi

# macOS: build and sign outside this folder. If it is in Documents or Desktop with iCloud sync on, macOS keeps adding
# Finder metadata to files there, and code signing refuses a bundle that has it (an unsigned app won't run on
# Apple Silicon).
WORK="${TMPDIR:-/tmp}/tonelith-build"
rm -rf "$WORK"
"$VPY" -m PyInstaller tonelith.spec --noconfirm --clean --distpath "$WORK/dist" --workpath "$WORK/work" \
  || { echo "Build failed."; finish 1; }
APP="$WORK/dist/Tonelith.app"
xattr -cr "$APP"
codesign --force --deep -s - "$APP" 2>/dev/null && codesign --verify --deep --strict "$APP" \
  || { echo "Build failed: could not sign the app."; finish 1; }
rm -rf dist/Tonelith.app
mkdir -p dist
ditto --noextattr --norsrc "$APP" dist/Tonelith.app || { echo "Could not copy the app to dist/."; finish 1; }

echo
echo "Build complete: $PWD/dist/Tonelith.app"

if [ "$INSTALL" -eq 1 ]; then
  DEST=/Applications
  [ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
  pkill -f "$DEST/Tonelith.app/Contents/MacOS/Tonelith" 2>/dev/null && sleep 1  # a running copy holds its files
  rm -rf "$DEST/Tonelith.app"
  ditto --noextattr --norsrc "$APP" "$DEST/Tonelith.app" || { echo "Could not copy the app to $DEST."; finish 1; }
  echo "Installed: $DEST/Tonelith.app  (open it from Launchpad, Spotlight or Finder > Applications)"
  if [ "$DOCK" -eq 1 ]; then
    if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "/Tonelith.app/"; then
      echo "Tonelith is already in the Dock."
    else
      defaults write com.apple.dock persistent-apps -array-add \
        "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://$DEST/Tonelith.app/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>" \
        && killall Dock && echo "Added Tonelith to the Dock."
    fi
  fi
else
  echo "To install it, drag it into Applications, or run: ./build_launcher.sh --install --dock"
fi
finish 0
