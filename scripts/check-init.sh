#!/usr/bin/env bash
# Task A4: real-world smoke gate for `npx the-forge init`. The vitest suite never
# runs a real package manager or dev server, so this proves the whole loop on the
# built npm artifact, outside the monorepo, against bare Vite and Next apps. Not
# part of `npm test`; run before merging, like check-prod-clean.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

VITE_PORT=5199
NEXT_PORT=5198

# Assert ports are free BEFORE doing anything — never kill a stale server
# ourselves (stale-dev-server gotcha), just fail loudly and tell the user.
for PORT in "$VITE_PORT" "$NEXT_PORT"; do
  if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "FAIL: port $PORT is already in use — kill whatever's listening on it (lsof -iTCP:$PORT -sTCP:LISTEN) and re-run" >&2
    exit 1
  fi
done

TMP_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# --- Step 1: build the plugin and pack the real tarball -------------------
npm run build
npm pack -w the-forge --pack-destination "$TMP_DIR" >/dev/null
TARBALL="$(find "$TMP_DIR" -maxdepth 1 -name 'the-forge-*.tgz' | head -n1)"
if [ -z "$TARBALL" ]; then
  echo "FAIL: npm pack did not produce a the-forge-*.tgz in $TMP_DIR" >&2
  exit 1
fi
echo "PASS: built plugin and packed $(basename "$TARBALL")"

# ===========================================================================
# Vite half
# ===========================================================================

VITE_APP="$TMP_DIR/vite-app"
mkdir -p "$VITE_APP/src"

cat > "$VITE_APP/package.json" <<'EOF'
{
  "name": "check-init-vite-app",
  "private": true,
  "type": "module",
  "scripts": {},
  "dependencies": {
    "react": "^19",
    "react-dom": "^19"
  },
  "devDependencies": {
    "vite": "^6",
    "@vitejs/plugin-react": "^4"
  }
}
EOF

cat > "$VITE_APP/vite.config.ts" <<'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
EOF

cat > "$VITE_APP/index.html" <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>check-init vite app</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF

cat > "$VITE_APP/src/main.tsx" <<'EOF'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
EOF

cat > "$VITE_APP/src/App.tsx" <<'EOF'
export default function App() {
  return <h1>check-init smoke app</h1>
}
EOF

echo "--- Vite: npm install ---"
(cd "$VITE_APP" && npm install --no-fund --no-audit >"$TMP_DIR/vite-install.log" 2>&1) \
  || { echo "FAIL: Vite scaffold npm install failed — see $TMP_DIR/vite-install.log" >&2; exit 1; }
(cd "$VITE_APP" && npm install -D --no-fund --no-audit "$TARBALL" >"$TMP_DIR/vite-install-tarball.log" 2>&1) \
  || { echo "FAIL: Vite scaffold npm install of tarball failed — see $TMP_DIR/vite-install-tarball.log" >&2; exit 1; }
echo "PASS: Vite scaffold dependencies installed"

# --- Step 3: run init, assert exit 0 + config wired --------------------
echo "--- Vite: node node_modules/the-forge/dist/cli.js init ---"
VITE_INIT_OUT="$TMP_DIR/vite-init-1.log"
if ! (cd "$VITE_APP" && node node_modules/the-forge/dist/cli.js init >"$VITE_INIT_OUT" 2>&1); then
  echo "FAIL: Vite init (first run) exited non-zero — see $VITE_INIT_OUT" >&2
  cat "$VITE_INIT_OUT" >&2
  exit 1
fi
cat "$VITE_INIT_OUT"

if ! grep -q "the-forge/vite" "$VITE_APP/vite.config.ts"; then
  echo "FAIL: vite.config.ts does not import the-forge/vite after init" >&2
  exit 1
fi
if ! grep -qE 'plugins:\s*\[\s*theForge\(\)' "$VITE_APP/vite.config.ts"; then
  echo "FAIL: vite.config.ts does not have theForge() first in plugins after init" >&2
  cat "$VITE_APP/vite.config.ts" >&2
  exit 1
fi
if ! grep -q '\[skip\] dependency' "$VITE_INIT_OUT"; then
  echo "FAIL: expected Vite init to [skip] the dependency step (tarball install already declares the-forge) — got:" >&2
  cat "$VITE_INIT_OUT" >&2
  exit 1
fi
echo "PASS: Vite init wired theForge() into vite.config.ts"

# --- Step 4: boot vite, assert the transform is live -----------------------
echo "--- Vite: booting dev server on :$VITE_PORT ---"
(cd "$VITE_APP" && nohup npx vite --port "$VITE_PORT" >"$TMP_DIR/vite-dev.log" 2>&1 &)
# Grab the PID of the actual vite process (nohup'd in a subshell, so re-find it).
for i in $(seq 1 30); do
  SERVER_PID="$(lsof -iTCP:"$VITE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true)"
  if [ -n "$SERVER_PID" ] && curl -s -o /dev/null "http://localhost:$VITE_PORT/"; then
    break
  fi
  sleep 1
done
if [ -z "$SERVER_PID" ] || ! curl -s -o /dev/null "http://localhost:$VITE_PORT/"; then
  echo "FAIL: Vite dev server did not come up on :$VITE_PORT within 30s — see $TMP_DIR/vite-dev.log" >&2
  cat "$TMP_DIR/vite-dev.log" >&2
  exit 1
fi

if ! curl -s "http://localhost:$VITE_PORT/src/App.tsx" | grep -q 'data-dc-source'; then
  echo "FAIL: served src/App.tsx has no data-dc-source tagging — the Forge transform is not live" >&2
  exit 1
fi
echo "PASS: Vite dev server tags JSX with data-dc-source"

kill "$SERVER_PID" >/dev/null 2>&1 || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# --- Step 5: re-run init, assert idempotency -------------------------------
VITE_CONFIG_BEFORE="$TMP_DIR/vite.config.before.ts"
cp "$VITE_APP/vite.config.ts" "$VITE_CONFIG_BEFORE"

VITE_INIT_OUT_2="$TMP_DIR/vite-init-2.log"
if ! (cd "$VITE_APP" && node node_modules/the-forge/dist/cli.js init >"$VITE_INIT_OUT_2" 2>&1); then
  echo "FAIL: Vite init (second run) exited non-zero — see $VITE_INIT_OUT_2" >&2
  cat "$VITE_INIT_OUT_2" >&2
  exit 1
fi
if grep -q '\[done\]' "$VITE_INIT_OUT_2"; then
  echo "FAIL: Vite re-init printed [done] — expected all [skip] (not idempotent):" >&2
  cat "$VITE_INIT_OUT_2" >&2
  exit 1
fi
if ! cmp -s "$VITE_CONFIG_BEFORE" "$VITE_APP/vite.config.ts"; then
  echo "FAIL: vite.config.ts changed on re-init — expected byte-identical" >&2
  diff "$VITE_CONFIG_BEFORE" "$VITE_APP/vite.config.ts" >&2 || true
  exit 1
fi
echo "PASS: Vite re-init is idempotent (no [done], config byte-identical)"

# ===========================================================================
# Next half
# ===========================================================================

NEXT_APP="$TMP_DIR/next-app"
mkdir -p "$NEXT_APP/app"

cat > "$NEXT_APP/package.json" <<'EOF'
{
  "name": "check-init-next-app",
  "private": true,
  "scripts": {},
  "dependencies": {
    "next": "^16",
    "react": "^19",
    "react-dom": "^19"
  }
}
EOF

cat > "$NEXT_APP/next.config.ts" <<'EOF'
export default {}
EOF

cat > "$NEXT_APP/app/layout.tsx" <<'EOF'
import type { ReactNode } from 'react'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
EOF

cat > "$NEXT_APP/app/page.tsx" <<'EOF'
export default function Page() {
  return <h1>check-init smoke app</h1>
}
EOF

echo "--- Next: npm install ---"
(cd "$NEXT_APP" && npm install --no-fund --no-audit >"$TMP_DIR/next-install.log" 2>&1) \
  || { echo "FAIL: Next scaffold npm install failed — see $TMP_DIR/next-install.log" >&2; exit 1; }
(cd "$NEXT_APP" && npm install -D --no-fund --no-audit "$TARBALL" >"$TMP_DIR/next-install-tarball.log" 2>&1) \
  || { echo "FAIL: Next scaffold npm install of tarball failed — see $TMP_DIR/next-install-tarball.log" >&2; exit 1; }
echo "PASS: Next scaffold dependencies installed"

echo "--- Next: node node_modules/the-forge/dist/cli.js init ---"
NEXT_INIT_OUT="$TMP_DIR/next-init-1.log"
if ! (cd "$NEXT_APP" && node node_modules/the-forge/dist/cli.js init >"$NEXT_INIT_OUT" 2>&1); then
  echo "FAIL: Next init (first run) exited non-zero — see $NEXT_INIT_OUT" >&2
  cat "$NEXT_INIT_OUT" >&2
  exit 1
fi
cat "$NEXT_INIT_OUT"

if ! grep -q "the-forge/next" "$NEXT_APP/next.config.ts"; then
  echo "FAIL: next.config.ts does not import the-forge/next after init" >&2
  exit 1
fi
if ! grep -q "withForge" "$NEXT_APP/next.config.ts"; then
  echo "FAIL: next.config.ts does not call withForge() after init" >&2
  cat "$NEXT_APP/next.config.ts" >&2
  exit 1
fi
if ! grep -q "ForgeDesignMode" "$NEXT_APP/app/layout.tsx"; then
  echo "FAIL: app/layout.tsx does not mount ForgeDesignMode after init" >&2
  cat "$NEXT_APP/app/layout.tsx" >&2
  exit 1
fi
if ! grep -q '\[skip\] dependency' "$NEXT_INIT_OUT"; then
  echo "FAIL: expected Next init to [skip] the dependency step (tarball install already declares the-forge) — got:" >&2
  cat "$NEXT_INIT_OUT" >&2
  exit 1
fi
echo "PASS: Next init wired withForge() into next.config.ts and mounted ForgeDesignMode"

# --- Boot next dev, assert the transform is live + layout tagged -----------
echo "--- Next: booting dev server on :$NEXT_PORT (this is the slow half) ---"
(cd "$NEXT_APP" && nohup npx next dev --port "$NEXT_PORT" >"$TMP_DIR/next-dev.log" 2>&1 &)
for i in $(seq 1 90); do
  SERVER_PID="$(lsof -iTCP:"$NEXT_PORT" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true)"
  if [ -n "$SERVER_PID" ] && curl -s -o /dev/null "http://localhost:$NEXT_PORT/"; then
    break
  fi
  sleep 1
done
if [ -z "$SERVER_PID" ] || ! curl -s -o /dev/null "http://localhost:$NEXT_PORT/"; then
  echo "FAIL: Next dev server did not come up on :$NEXT_PORT within 90s — see $TMP_DIR/next-dev.log" >&2
  cat "$TMP_DIR/next-dev.log" >&2
  exit 1
fi

if ! curl -s "http://localhost:$NEXT_PORT/" | grep -q 'data-dc-source'; then
  echo "FAIL: served / has no data-dc-source tagging — the Forge transform is not live under Next" >&2
  exit 1
fi
echo "PASS: Next dev server tags JSX with data-dc-source"

kill "$SERVER_PID" >/dev/null 2>&1 || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# --- Re-run init, assert idempotency ---------------------------------------
NEXT_CONFIG_BEFORE="$TMP_DIR/next.config.before.ts"
cp "$NEXT_APP/next.config.ts" "$NEXT_CONFIG_BEFORE"

NEXT_INIT_OUT_2="$TMP_DIR/next-init-2.log"
if ! (cd "$NEXT_APP" && node node_modules/the-forge/dist/cli.js init >"$NEXT_INIT_OUT_2" 2>&1); then
  echo "FAIL: Next init (second run) exited non-zero — see $NEXT_INIT_OUT_2" >&2
  cat "$NEXT_INIT_OUT_2" >&2
  exit 1
fi
if grep -q '\[done\]' "$NEXT_INIT_OUT_2"; then
  echo "FAIL: Next re-init printed [done] — expected all [skip] (not idempotent):" >&2
  cat "$NEXT_INIT_OUT_2" >&2
  exit 1
fi
if ! cmp -s "$NEXT_CONFIG_BEFORE" "$NEXT_APP/next.config.ts"; then
  echo "FAIL: next.config.ts changed on re-init — expected byte-identical" >&2
  diff "$NEXT_CONFIG_BEFORE" "$NEXT_APP/next.config.ts" >&2 || true
  exit 1
fi
echo "PASS: Next re-init is idempotent (no [done], config byte-identical)"

echo "PASS: check-init.sh — Vite and Next init loops verified end-to-end on the built tarball"
