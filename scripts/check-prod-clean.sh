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

# Package-size gate: the npm package ("files": ["dist"]) is the product's headline lightweight
# guarantee. Budget sits ~40% above today's ~180KB unpacked so only real regressions trip it.
MAX_UNPACKED_KB=250
PACK_JSON=$(npm pack --dry-run --json -w @the-forge/vite 2>/dev/null)
UNPACKED_KB=$(printf '%s' "$PACK_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(Math.ceil(j[0].unpackedSize/1024))})')
# Guard against a silent PASS: [ -gt ] on an empty/non-numeric value errors to stderr but
# evaluates false, which would fall through to the PASS lines — the one failure mode this
# gate exists to prevent. (Unreachable today only because node throws first under pipefail.)
if ! [[ "$UNPACKED_KB" =~ ^[0-9]+$ ]]; then
  echo "FAIL: could not determine unpacked package size (got '${UNPACKED_KB}')" >&2
  exit 1
fi
if [ "$UNPACKED_KB" -gt "$MAX_UNPACKED_KB" ]; then
  echo "FAIL: @the-forge/vite unpacked package is ${UNPACKED_KB}KB — exceeds the ${MAX_UNPACKED_KB}KB budget" >&2
  exit 1
fi
echo "PASS: package size ${UNPACKED_KB}KB (budget ${MAX_UNPACKED_KB}KB)"

echo "PASS: production build is clean"
