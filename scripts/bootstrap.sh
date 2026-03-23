#!/usr/bin/env bash
set -euo pipefail

echo "Bootstrapping environment"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20+ is required"
  exit 1
fi

echo "Installing dependencies"
npm install

echo "Building cursor-orch"
npm run build

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

echo "Running smoke check: npx cursor-orch --help"
node ./dist/cli.js --help >/dev/null
echo "Bootstrap complete"
