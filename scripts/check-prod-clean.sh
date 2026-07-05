#!/usr/bin/env bash
# Spec §10: production output must contain no trace of the companion.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w the-forge
npm run build -w demo-app
if [ ! -d fixtures/demo-app/dist ]; then
  echo "FAIL: fixtures/demo-app/dist does not exist" >&2
  exit 1
fi
if grep -riq "data-dc-source\|the-forge\|__THE_FORGE__" fixtures/demo-app/dist/; then
  echo "FAIL: companion artifacts found in production build" >&2
  exit 1
fi

npm run build -w next-demo
if [ ! -d fixtures/next-demo/.next ]; then
  echo "FAIL: fixtures/next-demo/.next does not exist" >&2
  exit 1
fi
# Pattern deliberately drops the bare "the-forge" used for the Vite dist grep above:
# .next/ build metadata legitimately contains the devDependency's package name (e.g. in
# trace files and manifests), whereas the three markers below are the actual runtime
# traces we must never ship.
# Sourcemaps are excluded: they embed pre-DCE sourcesContent verbatim (Turbopack keeps
# ForgeDesignMode's dev branch there for stack traces); they are debug metadata, never
# served to browsers, and the component is explicitly user-mounted. The gate's guarantee
# is about executed/served output — the chunks themselves must stay clean.
if grep -riq --exclude='*.map' "data-dc-source\|__the-forge\|__THE_FORGE__" fixtures/next-demo/.next/; then
  echo "FAIL: companion artifacts found in Next.js production build" >&2
  exit 1
fi
echo "PASS: Next.js production build is clean"

# Package-size gate: the npm package ("files": ["dist"]) is the product's headline lightweight
# guarantee. Budget sits ~40% above today's ~180KB unpacked so only real regressions trip it.
MAX_UNPACKED_KB=250
PACK_JSON=$(npm pack --dry-run --json -w the-forge 2>/dev/null)
UNPACKED_KB=$(printf '%s' "$PACK_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(Math.ceil(j[0].unpackedSize/1024))})')
# Guard against a silent PASS: [ -gt ] on an empty/non-numeric value errors to stderr but
# evaluates false, which would fall through to the PASS lines — the one failure mode this
# gate exists to prevent. (Unreachable today only because node throws first under pipefail.)
if ! [[ "$UNPACKED_KB" =~ ^[0-9]+$ ]]; then
  echo "FAIL: could not determine unpacked package size (got '${UNPACKED_KB}')" >&2
  exit 1
fi
if [ "$UNPACKED_KB" -gt "$MAX_UNPACKED_KB" ]; then
  echo "FAIL: the-forge unpacked package is ${UNPACKED_KB}KB — exceeds the ${MAX_UNPACKED_KB}KB budget" >&2
  exit 1
fi
echo "PASS: package size ${UNPACKED_KB}KB (budget ${MAX_UNPACKED_KB}KB)"

# Tarball-content gate: the published package must be dist/ plus the handful of files npm
# auto-includes (package.json always; README.md/LICENSE once they exist at the package
# root) — never source, tests, or config leaking into what users install. Allowlist check
# happens here (not in vitest) because it needs the real npm-pack file list, which only
# exists after a build.
BAD_PATHS=$(printf '%s' "$PACK_JSON" | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  const files = JSON.parse(s)[0].files.map(f => f.path);
  const bad = files.filter(p => !(p === "package.json" || p === "README.md" || p === "LICENSE" || p.startsWith("dist/")));
  console.log(bad.join("\n"));
});
')
if [ -n "$BAD_PATHS" ]; then
  echo "FAIL: the-forge tarball contains files outside the dist/package.json/README.md/LICENSE allowlist:" >&2
  echo "$BAD_PATHS" >&2
  exit 1
fi
echo "PASS: tarball contents match the dist/package.json/README.md/LICENSE allowlist"

HAS_CLI=$(printf '%s' "$PACK_JSON" | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  const files = JSON.parse(s)[0].files.map(f => f.path);
  console.log(files.includes("dist/cli.js") ? "yes" : "no");
});
')
if [ "$HAS_CLI" != "yes" ]; then
  echo "FAIL: the-forge tarball is missing dist/cli.js" >&2
  exit 1
fi
echo "PASS: tarball includes dist/cli.js"

echo "PASS: production build is clean"
