#!/usr/bin/env bash
# Double-click this file in Finder to build Tonelith, put it in Applications and add it to the Dock.
# Run it again after updating the source to rebuild. (First time: right-click > Open if macOS blocks it.)
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
exec bash ./build_launcher.sh --install --dock
