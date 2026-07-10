#!/usr/bin/env bash
# Task 9 Step 2 — embedded-session feed E2E without a live Claude CLI.
#
# Spawns the Vite demo with PATH fronted by scripts/fake-bin/ (a scripted `claude`
# that speaks stream-json NDJSON), then drives the session endpoints over HTTP:
#   1. event stream connects and stays open
#   2. queue + dispatch auto-starts the embedded session (rung: embedded)
#   3. feed emits started → assistant-text → tool-started → tool-finished → turn-complete
#   4. interrupt returns 200
#   5. approval request parks, decide(allow) resolves it
#   6. /status reports a live session state
#   7. (Task 7) /session/say drives a chat turn: user-text → assistant-delta (seq 0) →
#      assistant-text → tool-started carrying an Edit before/after; /session/config round-trips
#      a model change onto the stream as config-changed
#
# Usage: ./scripts/e2e-embedded-feed.sh
# Requires: npm run build already done (or this script builds).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAKE_BIN="$ROOT/scripts/fake-bin"
PORT=5173
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t forge-e2e-feed.XXXXXX)"
EVENTS_FILE="$(mktemp -t forge-e2e-events.XXXXXX)"
# Fake-owned control_request receipt log (FORGE_FAKE_CLAUDE_LOG in scripts/fake-bin/claude):
# the adapter deliberately never logs control_responses, so asserting "the set_model ack
# landed in the fake" needs a record the fake itself writes.
FAKE_LOG="$(mktemp -t forge-e2e-fake-receipts.XXXXXX)"
SERVER_PID=""
CURL_PID=""

cleanup() {
  if [[ -n "${CURL_PID}" ]] && kill -0 "$CURL_PID" 2>/dev/null; then
    kill "$CURL_PID" 2>/dev/null || true
    wait "$CURL_PID" 2>/dev/null || true
  fi
  if [[ -n "${SERVER_PID}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    # Give Vite a moment to unlink its endpoint file.
    sleep 0.5
    kill -9 "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG" "$EVENTS_FILE" "$FAKE_LOG"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

chmod +x "$FAKE_BIN/claude"

# Kill anything already on the demo port (stale servers cause phantom bugs).
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Killing stale listener(s) on :$PORT"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true
  sleep 0.5
fi

echo "==> Building plugin"
(cd "$ROOT" && npm run build) >/dev/null

echo "==> Starting demo-app with fake claude on PATH"
# Prefer IPv4 so curl to 127.0.0.1 matches the bound address.
(
  cd "$ROOT"
  # chat (not default): Task 7 adds a /session/say + /session/config section below that needs
  # the chat scenario's deltas/Edit-with-payload turn shape. chat is a superset of default's
  # event kinds (assistant-text, tool-started, tool-finished, turn-complete all still fire), so
  # every existing assertion in this script keeps passing under it.
  PATH="$FAKE_BIN:$PATH" \
    FORGE_FAKE_CLAUDE_SCENARIO=chat \
    FORGE_FAKE_CLAUDE_LOG="$FAKE_LOG" \
    npm run dev -w demo-app -- --host 127.0.0.1 --port "$PORT" --strictPort
) >"$LOG" 2>&1 &
SERVER_PID=$!

echo "==> Waiting for server"
for i in $(seq 1 60); do
  if curl -sf "$BASE/" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "---- server log ----" >&2
    cat "$LOG" >&2
    fail "demo-app exited before becoming ready"
  fi
  sleep 0.25
  if [[ "$i" -eq 60 ]]; then
    echo "---- server log ----" >&2
    cat "$LOG" >&2
    fail "demo-app did not become ready on :$PORT"
  fi
done
pass "demo-app listening on :$PORT"

# Discover the live endpoint file (newest live pid wins — same rule as the MCP bin).
ENDPOINT=""
SECRET=""
for i in $(seq 1 40); do
  for f in "$ROOT"/.the-forge/endpoint-*.json; do
    [[ -f "$f" ]] || continue
    pid="$(node -e "const j=require('$f'); process.stdout.write(String(j.pid||''))")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      ENDPOINT="$f"
      SECRET="$(node -e "const j=require('$f'); process.stdout.write(j.secret||'')")"
      break 2
    fi
  done
  sleep 0.25
done
[[ -n "$ENDPOINT" && -n "$SECRET" ]] || fail "no live endpoint file under .the-forge/"
pass "endpoint $(basename "$ENDPOINT") (secret present)"

HDR=(-H "X-Forge-Secret: $SECRET" -H "Content-Type: application/json" -H "Origin: $BASE")

echo "==> Opening event stream"
# Background curl keeps the NDJSON connection open; we poll the file for events.
curl -sN -H "X-Forge-Secret: $SECRET" -H "Origin: $BASE" \
  "$BASE/__the-forge/session/events?since=0" >"$EVENTS_FILE" 2>/dev/null &
CURL_PID=$!
sleep 0.3
kill -0 "$CURL_PID" 2>/dev/null || fail "event-stream curl died immediately"
pass "event stream connected"

echo "==> Queue + dispatch (auto-start embedded session)"
QUEUE_BODY='{"request":{"kind":"change","createdAt":"2026-07-09T00:00:00.000Z","viewport":{"width":1280,"height":800},"tailwind":true,"elements":[]},"markdown":"# Design change request\n\nE2E fixture — fake claude will not apply this; we only assert the feed."}'
QUEUE_RES="$(curl -sf "${HDR[@]}" -d "$QUEUE_BODY" "$BASE/__the-forge/queue")" \
  || fail "POST /queue failed"
QUEUE_ID="$(node -e "const j=JSON.parse(process.argv[1]); if(!j.id) process.exit(1); process.stdout.write(j.id)" "$QUEUE_RES")" \
  || fail "queue response missing id: $QUEUE_RES"
pass "queued id=$QUEUE_ID"

DISPATCH_RES="$(curl -sf "${HDR[@]}" -d '{"agent":"claude-code"}' "$BASE/__the-forge/dispatch")" \
  || fail "POST /dispatch failed"
RUNG="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.rung||'')" "$DISPATCH_RES")"
[[ "$RUNG" == "embedded" ]] || fail "expected rung=embedded, got: $DISPATCH_RES"
pass "dispatch rung=embedded ($DISPATCH_RES)"

echo "==> Waiting for feed events"
# Expect: started, assistant-text, tool-started, tool-finished, turn-complete
deadline=$((SECONDS + 15))
have_started=0 have_text=0 have_tool_start=0 have_tool_finish=0 have_complete=0
while (( SECONDS < deadline )); do
  if grep -q '"kind":"started"' "$EVENTS_FILE" 2>/dev/null; then have_started=1; fi
  if grep -q '"kind":"assistant-text"' "$EVENTS_FILE" 2>/dev/null; then have_text=1; fi
  if grep -q '"kind":"tool-started"' "$EVENTS_FILE" 2>/dev/null; then have_tool_start=1; fi
  if grep -q '"kind":"tool-finished"' "$EVENTS_FILE" 2>/dev/null; then have_tool_finish=1; fi
  if grep -q '"kind":"turn-complete"' "$EVENTS_FILE" 2>/dev/null; then have_complete=1; fi
  if (( have_started && have_text && have_tool_start && have_tool_finish && have_complete )); then
    break
  fi
  sleep 0.2
done

(( have_started ))      || fail "missing started event. feed so far:\n$(cat "$EVENTS_FILE")"
(( have_text ))         || fail "missing assistant-text. feed so far:\n$(cat "$EVENTS_FILE")"
(( have_tool_start ))   || fail "missing tool-started. feed so far:\n$(cat "$EVENTS_FILE")"
(( have_tool_finish ))  || fail "missing tool-finished. feed so far:\n$(cat "$EVENTS_FILE")"
(( have_complete ))     || fail "missing turn-complete. feed so far:\n$(cat "$EVENTS_FILE")"
pass "feed: started → text → tool-started → tool-finished → turn-complete"

# Confirm tool detail carried the file path
grep -q 'src/App.tsx' "$EVENTS_FILE" || fail "tool-started missing file path detail"
pass "tool detail includes src/App.tsx"

echo "==> /status reports a live session"
STATUS="$(curl -sf -H "Origin: $BASE" "$BASE/__the-forge/status")" \
  || fail "GET /status failed"
SESSION_STATE="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.session||'')" "$STATUS")"
case "$SESSION_STATE" in
  ready|busy|starting|failed) pass "status.session=$SESSION_STATE" ;;
  *) fail "unexpected status.session=$SESSION_STATE (full: $STATUS)" ;;
esac

echo "==> Interrupt"
INT_RES="$(curl -sf "${HDR[@]}" -d '{}' "$BASE/__the-forge/session/interrupt")" \
  || fail "POST /session/interrupt failed"
pass "interrupt → $INT_RES"

echo "==> Approval round-trip (park → decide allow)"
# Drive the registry directly via HTTP (same path the MCP approve tool uses). Long-poll
# /approval in the background; decide from a second request.
APPROVAL_RES_FILE="$(mktemp -t forge-e2e-approval.XXXXXX)"
curl -sf "${HDR[@]}" -d '{"toolName":"Bash","detail":"ls -la"}' \
  "$BASE/__the-forge/approval" >"$APPROVAL_RES_FILE" 2>/dev/null &
APPROVAL_CURL_PID=$!
# Wait until the approval appears on the event stream (or in pending via a fresh connect).
deadline=$((SECONDS + 10))
APPROVAL_ID=""
while (( SECONDS < deadline )); do
  APPROVAL_ID="$(node -e "
    const fs=require('fs');
    const lines=fs.readFileSync(process.argv[1],'utf8').split(/\n/).filter(Boolean);
    for (const l of lines) {
      try {
        const j=JSON.parse(l);
        if (j.type==='approval' && j.toolName==='Bash') { process.stdout.write(j.id); process.exit(0); }
      } catch {}
    }
  " "$EVENTS_FILE" || true)"
  if [[ -n "$APPROVAL_ID" ]]; then break; fi
  sleep 0.2
done
[[ -n "$APPROVAL_ID" ]] || fail "approval-request never appeared on the event stream"
pass "approval-request id=$APPROVAL_ID on stream"

DECIDE_RES="$(curl -sf "${HDR[@]}" -d "{\"id\":\"$APPROVAL_ID\",\"allow\":true}" \
  "$BASE/__the-forge/approval/decide")" || fail "POST /approval/decide failed"
DECIDE_OK="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.ok))" "$DECIDE_RES")"
[[ "$DECIDE_OK" == "true" ]] || fail "decide returned ok≠true: $DECIDE_RES"
pass "decide(allow) → ok"

# The long-poll /approval should resolve with behavior:allow
deadline=$((SECONDS + 10))
while (( SECONDS < deadline )); do
  if [[ -s "$APPROVAL_RES_FILE" ]]; then break; fi
  sleep 0.1
done
wait "$APPROVAL_CURL_PID" 2>/dev/null || true
APPROVAL_BODY="$(cat "$APPROVAL_RES_FILE")"
rm -f "$APPROVAL_RES_FILE"
BEHAVIOR="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.behavior||'')" "$APPROVAL_BODY")" \
  || fail "approval long-poll body unparseable: $APPROVAL_BODY"
[[ "$BEHAVIOR" == "allow" ]] || fail "expected behavior=allow, got: $APPROVAL_BODY"
pass "approval long-poll resolved allow"

# Stream should also carry approval-resolved
deadline=$((SECONDS + 5))
have_resolved=0
while (( SECONDS < deadline )); do
  if grep -q '"type":"approval-resolved"' "$EVENTS_FILE" 2>/dev/null; then have_resolved=1; break; fi
  sleep 0.1
done
(( have_resolved )) || fail "missing approval-resolved on stream"
pass "approval-resolved on stream"

echo "==> Chat: POST /session/say"
SAY_RES="$(curl -sf "${HDR[@]}" -d '{"text":"hello from e2e"}' "$BASE/__the-forge/session/say")" \
  || fail "POST /session/say failed"
SAY_OK="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.ok))" "$SAY_RES")"
[[ "$SAY_OK" == "true" ]] || fail "say returned ok≠true: $SAY_RES"
pass "say → ok"

echo "==> Waiting for chat feed events"
# Expect: a user-text row (say()-only, never produced by the pull/dispatch flow above), at
# least one seq:0 assistant-delta preview line, the final assistant-text, and an Edit-bearing
# tool-started (before/after) — the chat scenario's turn shape (scripts/fake-bin/claude).
deadline=$((SECONDS + 15))
have_user_text=0 have_delta=0 have_chat_text=0 have_tool_edit=0
while (( SECONDS < deadline )); do
  if grep -q '"kind":"user-text"' "$EVENTS_FILE" 2>/dev/null; then have_user_text=1; fi
  if grep '"seq":0' "$EVENTS_FILE" 2>/dev/null | grep -q '"assistant-delta"'; then have_delta=1; fi
  if grep -q '"kind":"assistant-text"' "$EVENTS_FILE" 2>/dev/null; then have_chat_text=1; fi
  if grep '"kind":"tool-started"' "$EVENTS_FILE" 2>/dev/null | grep -q '"edit"'; then have_tool_edit=1; fi
  if (( have_user_text && have_delta && have_chat_text && have_tool_edit )); then
    break
  fi
  sleep 0.2
done

(( have_user_text )) || fail "missing user-text event after say(). feed so far:\n$(cat "$EVENTS_FILE")"
(( have_delta ))     || fail "missing seq:0 assistant-delta event. feed so far:\n$(cat "$EVENTS_FILE")"
(( have_chat_text ))  || fail "missing assistant-text event. feed so far:\n$(cat "$EVENTS_FILE")"
(( have_tool_edit ))  || fail "missing edit-bearing tool-started event. feed so far:\n$(cat "$EVENTS_FILE")"
pass "chat feed: user-text → assistant-delta(seq 0) → assistant-text → tool-started(edit)"

grep '"kind":"tool-started"' "$EVENTS_FILE" | grep -q '"before"' || fail "tool-started edit payload missing before"
grep '"kind":"tool-started"' "$EVENTS_FILE" | grep -q '"after"' || fail "tool-started edit payload missing after"
pass "tool-started edit payload carries before/after"

echo "==> Config round-trip: POST /session/config"
CONFIG_RES="$(curl -sf "${HDR[@]}" -d '{"model":"sonnet"}' "$BASE/__the-forge/session/config")" \
  || fail "POST /session/config failed"
CONFIG_OK="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.ok))" "$CONFIG_RES")"
[[ "$CONFIG_OK" == "true" ]] || fail "config returned ok≠true: $CONFIG_RES"
pass "config → ok"

deadline=$((SECONDS + 5))
have_config=0
while (( SECONDS < deadline )); do
  if grep '"kind":"config-changed"' "$EVENTS_FILE" 2>/dev/null | grep -q '"sonnet"'; then
    have_config=1
    break
  fi
  sleep 0.1
done
(( have_config )) || fail "missing config-changed(model=sonnet) on stream. feed so far:\n$(cat "$EVENTS_FILE")"
pass "config-changed(model=sonnet) on stream"

# The set_model control_request must have actually reached the fake CLI (its ack carries no
# echo of the model on the stream, so the receipt log is the only place this is observable).
deadline=$((SECONDS + 5))
have_receipt=0
while (( SECONDS < deadline )); do
  if grep '"received":"set_model"' "$FAKE_LOG" 2>/dev/null | grep -q '"sonnet"'; then
    have_receipt=1
    break
  fi
  sleep 0.1
done
(( have_receipt )) || fail "set_model(sonnet) receipt missing from fake log. receipts so far:\n$(cat "$FAKE_LOG")"
pass "set_model(sonnet) ack receipt in fake log"

echo
echo "ALL CHECKS PASSED (fake-claude feed E2E (embedded session + chat))"
