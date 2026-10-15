#!/usr/bin/env bash
# Starts Tonelith (installing prerequisites first if this is a fresh copy). A Tonelith server already running on
# the same port is stopped first (app.py does this). Extra arguments go to app.py,
# e.g. ./run.sh --port 5200 --no-browser
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

if [ -x .venv/bin/python ]; then VPY=.venv/bin/python
elif [ -x .venv/Scripts/python.exe ]; then VPY=.venv/Scripts/python.exe
else
  echo "First run: installing prerequisites..."
  bash ./setup.sh --nopause || exit 1
  if [ -x .venv/bin/python ]; then VPY=.venv/bin/python; else VPY=.venv/Scripts/python.exe; fi
fi

exec "$VPY" app.py "$@"
