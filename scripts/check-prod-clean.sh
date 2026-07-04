#!/usr/bin/env bash
# Spec §10: production output must contain no trace of the companion.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w demo-app
if grep -r "data-dc-source\|design-companion" fixtures/demo-app/dist/; then
  echo "FAIL: companion artifacts found in production build" >&2
  exit 1
fi
echo "PASS: production build is clean"
