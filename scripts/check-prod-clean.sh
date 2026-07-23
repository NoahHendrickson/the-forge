#!/usr/bin/env bash
# Spec §10: production output must contain no trace of the companion.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w forge-mode
npm run build -w demo-app
if [ ! -d fixtures/demo-app/dist ]; then
  echo "FAIL: fixtures/demo-app/dist does not exist" >&2
  exit 1
fi
if grep -riq "data-dc-source\|the-forge\|forge-mode\|__THE_FORGE__" fixtures/demo-app/dist/; then
  echo "FAIL: companion artifacts found in production build" >&2
  exit 1
fi

npm run build -w next-demo
if [ ! -d fixtures/next-demo/.next ]; then
  echo "FAIL: fixtures/next-demo/.next does not exist" >&2
  exit 1
fi
# Pattern deliberately drops the bare "the-forge"/"forge-mode" tokens used for the Vite dist grep above:
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
# guarantee. Raised 250→280 with the embedded-session milestone (SessionFeed + session/*
# manager/adapter/approvals + approve MCP tool — ~29KB of real surface after whitespace
# stripping was already applied to every bundle). Raised 280→320 for milestone B (chat surface
# — ratified 2026-07-09): session-feed.ts grew into the full chat surface (bubbles, deltas,
# diff rows, input, element chip, model/permission pickers) and PromptBox was retired in favor
# of it. Raised 320→336 for the Figma pivot P1 (2026-07-22 spec): the structural-op union
# (text/delete drafts, ops wire format + markdown, HmrSignal + inverted-polarity verify,
# inline text edit, changelist op rows, X/Y header) is ~7KB of real client surface.
# Still a regression tripwire, not a target.
MAX_UNPACKED_KB=336
PACK_JSON=$(npm pack --dry-run --json -w forge-mode 2>/dev/null)
# String(...) around the number: Node's console colorizes bare numbers under FORCE_COLOR
# (Claude Code background shells set FORCE_COLOR=3), which would wrap the digits in ANSI
# escapes and trip the ^[0-9]+$ guard below into a false FAIL. Strings are never colorized.
UNPACKED_KB=$(printf '%s' "$PACK_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(String(Math.ceil(j[0].unpackedSize/1024)))})')
# Guard against a silent PASS: [ -gt ] on an empty/non-numeric value errors to stderr but
# evaluates false, which would fall through to the PASS lines — the one failure mode this
# gate exists to prevent. (Unreachable today only because node throws first under pipefail.)
if ! [[ "$UNPACKED_KB" =~ ^[0-9]+$ ]]; then
  echo "FAIL: could not determine unpacked package size (got '${UNPACKED_KB}')" >&2
  exit 1
fi
if [ "$UNPACKED_KB" -gt "$MAX_UNPACKED_KB" ]; then
  echo "FAIL: forge-mode unpacked package is ${UNPACKED_KB}KB — exceeds the ${MAX_UNPACKED_KB}KB budget" >&2
  exit 1
fi
echo "PASS: package size ${UNPACKED_KB}KB (budget ${MAX_UNPACKED_KB}KB)"

# Client-bundle budget gate: dist/client.js is the browser overlay bundle served at
# GET /__the-forge/client.js — the 250KB figure is cited throughout docs/CLAUDE.md as a
# real budget, but until now nothing enforced it. wc -c is portable macOS/Linux (unlike
# `stat`, whose flags differ between the two). String(...) here for the same reason as the
# package-size gate above: bare console.log numbers get ANSI-wrapped under FORCE_COLOR.
CLIENT_BUDGET_KB=250
CLIENT_JS_PATH=packages/the-forge/dist/client.js
if [ ! -f "$CLIENT_JS_PATH" ]; then
  echo "FAIL: ${CLIENT_JS_PATH} does not exist" >&2
  exit 1
fi
CLIENT_BYTES=$(wc -c < "$CLIENT_JS_PATH" | tr -d ' ')
CLIENT_KB=$(node -e "console.log(String(Math.ceil(${CLIENT_BYTES}/1024)))")
if ! [[ "$CLIENT_KB" =~ ^[0-9]+$ ]]; then
  echo "FAIL: could not determine client bundle size (got '${CLIENT_KB}')" >&2
  exit 1
fi
if [ "$CLIENT_KB" -gt "$CLIENT_BUDGET_KB" ]; then
  echo "FAIL: dist/client.js is ${CLIENT_KB}KB — exceeds the ${CLIENT_BUDGET_KB}KB budget" >&2
  exit 1
fi
echo "PASS: client bundle size ${CLIENT_KB}KB (budget ${CLIENT_BUDGET_KB}KB)"

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
  echo "FAIL: forge-mode tarball contains files outside the dist/package.json/README.md/LICENSE allowlist:" >&2
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
  echo "FAIL: forge-mode tarball is missing dist/cli.js" >&2
  exit 1
fi
echo "PASS: tarball includes dist/cli.js"

# The published bin must be directly executable (`npx forge-mode`) without an explicit `node`
# prefix — that requires the shebang to survive the build unmodified as the file's first line.
SHEBANG=$(head -1 packages/the-forge/dist/cli.js)
if [ "$SHEBANG" != "#!/usr/bin/env node" ]; then
  echo "FAIL: packages/the-forge/dist/cli.js does not start with the node shebang (got '${SHEBANG}')" >&2
  exit 1
fi
echo "PASS: dist/cli.js starts with the node shebang"

echo "PASS: production build is clean"
