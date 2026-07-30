#!/bin/zsh
# Start the AudioVis texture server. Sets up the venv on first run.
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "Creating venv + installing deps (one-time)..."
  python3 -m venv .venv
  .venv/bin/pip install --quiet --disable-pip-version-check -r requirements.txt
fi
exec .venv/bin/python server.py
