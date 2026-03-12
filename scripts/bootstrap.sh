#!/usr/bin/env bash
set -euo pipefail

echo "Bootstrapping environment"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required"
  exit 1
fi

python3 -m venv .venv

echo "Installing cursor-orch in editable mode"
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e .

if [ ! -f .env ]; then
  echo "Error: .env not found. Run: cp .env.example .env"
  exit 1
fi

set -a
source .env
set +a

if [ -z "${CURSOR_API_KEY:-}" ]; then
  echo "Error: CURSOR_API_KEY is required in .env"
  exit 1
fi

if [ -z "${GH_TOKEN:-}" ]; then
  echo "Error: GH_TOKEN is required in .env"
  exit 1
fi

echo "Running smoke check: cursor-orch --help"
.venv/bin/cursor-orch --help >/dev/null
echo "Bootstrap complete"
