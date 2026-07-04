#!/usr/bin/env bash
# Spec §10: production output must contain no trace of the companion.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w @the-forge/vite
npm run build -w demo-app
if [ ! -d fixtures/demo-app/dist ]; then
  echo "FAIL: fixtures/demo-app/dist does not exist" >&2
  exit 1
fi
if grep -riq "data-dc-source\|the-forge\|__THE_FORGE__" fixtures/demo-app/dist/; then
  echo "FAIL: companion artifacts found in production build" >&2
  exit 1
fi
echo "PASS: production build is clean"
