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
#   8. (C1 Task 6) harness switch: /session/config {harness:'cursor'} swaps the embedded
#      adapter to the fake `cursor-agent` (scripted ACP JSON-RPC, scripts/fake-bin/cursor-agent);
#      a dispatch drives a cursor turn onto the same feed, its execute-kind permission request
#      round-trips through /approval/decide as a REJECT (receipt-logged by the fake), then a
#      switch back to claude-code proves the original harness still turns.
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
# Same contract for the fake cursor-agent (FORGE_FAKE_CURSOR_LOG in scripts/fake-bin/
# cursor-agent): the adapter answers ACP permission requests on the fake's stdin, which no
# server-side surface records — the fake's receipt log is the only proof the reject landed.
FAKE_CURSOR_LOG="$(mktemp -t forge-e2e-fake-cursor-receipts.XXXXXX)"
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
  # SERVER_PID is the backgrounded subshell — killing it does NOT reach the npm→vite
  # descendants, and a SIGKILL'd vite never SIGTERMs its embedded-session children. Reap
  # both directly: the port listener (same lsof idiom as the startup stale-server kill)
  # and any fake harness process spawned from OUR fake-bin dir (path-anchored pkill, so
  # a real `claude`/`cursor-agent` elsewhere on the machine is never touched).
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
  pkill -9 -f "$FAKE_BIN/" 2>/dev/null || true
  rm -f "$LOG" "$EVENTS_FILE" "$FAKE_LOG" "$FAKE_CURSOR_LOG"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

chmod +x "$FAKE_BIN/claude" "$FAKE_BIN/cursor-agent"

# Reset persisted harness selection/session slots — a prior run leaves session.json with
# selected:'claude-code' (the switch-back below) and per-harness resume ids; starting from
# a known-clean slate keeps both runs of this script byte-identical in behavior.
rm -f "$ROOT/.the-forge/session.json"

# Kill anything already on the demo port (stale servers cause phantom bugs).
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Killing stale listener(s) on :$PORT"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true
  sleep 0.5
fi

echo "==> Building plugin"
(cd "$ROOT" && npm run build) >/dev/null

# Build sanity (composer consolidation) — the served browser bundle must carry the composer's
# new class hooks. These are the only surfaces this HTTP-level script can't assert via the feed
# stream (they're DOM/CSS, not NDJSON), so grep the built client bundle directly: a refactor that
# renamed/dropped .chat-composer / .draft-pill / .feed-divider would sail past every feed
# assertion below but ship a broken overlay. CSS class names are test hooks — extend, don't rename.
echo "==> Build sanity: composer class hooks in dist/client.js"
CLIENT_JS="$ROOT/packages/the-forge/dist/client.js"
[[ -f "$CLIENT_JS" ]] || fail "dist/client.js missing after build"
for hook in chat-composer draft-pill feed-divider; do
  grep -q "$hook" "$CLIENT_JS" || fail "dist/client.js missing composer hook: $hook"
done
pass "dist/client.js carries chat-composer, draft-pill, feed-divider"

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
    FORGE_FAKE_CURSOR_LOG="$FAKE_CURSOR_LOG" \
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

# ---------------------------------------------------------------------------------------
# C1 Task 6 — harness switch scenario (fake cursor-agent, ACP JSON-RPC)
# ---------------------------------------------------------------------------------------

# /session/config {harness} 409s while a turn is in flight — switch only from a settled state.
wait_session_settled() {
  local deadline=$((SECONDS + 15))
  local st=""
  while (( SECONDS < deadline )); do
    st="$(curl -sf -H "Origin: $BASE" "$BASE/__the-forge/status" 2>/dev/null \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).session||'')}catch{}})" \
      || true)"
    case "$st" in
      ready|idle) return 0 ;;
    esac
    sleep 0.2
  done
  fail "session never settled to ready/idle for harness switch (last state: $st)"
}

echo "==> Harness switch: claude-code → cursor"
wait_session_settled
SWITCH_RES="$(curl -sf "${HDR[@]}" -d '{"harness":"cursor"}' "$BASE/__the-forge/session/config")" \
  || fail "POST /session/config {harness:cursor} failed"
SWITCH_OK="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.ok))" "$SWITCH_RES")"
[[ "$SWITCH_OK" == "true" ]] || fail "harness switch returned ok≠true: $SWITCH_RES"
pass "config {harness:cursor} → ok"

deadline=$((SECONDS + 5))
have_switch_evt=0
while (( SECONDS < deadline )); do
  if grep '"kind":"config-changed"' "$EVENTS_FILE" 2>/dev/null | grep -q '"harness":"cursor"'; then
    have_switch_evt=1
    break
  fi
  sleep 0.1
done
(( have_switch_evt )) || fail "missing config-changed(harness=cursor) on stream. feed so far:\n$(cat "$EVENTS_FILE")"
pass "config-changed(harness=cursor) on stream"

STATUS="$(curl -sf -H "Origin: $BASE" "$BASE/__the-forge/status")" || fail "GET /status failed"
HARNESS_NOW="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.harness||'')" "$STATUS")"
[[ "$HARNESS_NOW" == "cursor" ]] || fail "expected status.harness=cursor, got: $STATUS"
pass "status.harness=cursor"

echo "==> Queue + dispatch on cursor harness (auto-start fake cursor-agent)"
# Baselines: the events file already carries the whole claude scenario — count, don't grep-once.
COMPLETES_BEFORE="$(grep -c '"kind":"turn-complete"' "$EVENTS_FILE" || true)"
QUEUE_BODY_2='{"request":{"kind":"change","createdAt":"2026-07-11T00:00:00.000Z","viewport":{"width":1280,"height":800},"tailwind":true,"elements":[]},"markdown":"# Design change request\n\nE2E fixture — fake cursor-agent will not apply this; we only assert the feed."}'
QUEUE_RES_2="$(curl -sf "${HDR[@]}" -d "$QUEUE_BODY_2" "$BASE/__the-forge/queue")" \
  || fail "POST /queue (cursor scenario) failed"
QUEUE_ID_2="$(node -e "const j=JSON.parse(process.argv[1]); if(!j.id) process.exit(1); process.stdout.write(j.id)" "$QUEUE_RES_2")" \
  || fail "queue response missing id: $QUEUE_RES_2"
pass "queued id=$QUEUE_ID_2"

DISPATCH_RES_2="$(curl -sf "${HDR[@]}" -d '{"agent":"cursor"}' "$BASE/__the-forge/dispatch")" \
  || fail "POST /dispatch (cursor) failed"
RUNG_2="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.rung||'')" "$DISPATCH_RES_2")"
[[ "$RUNG_2" == "embedded" ]] || fail "expected rung=embedded, got: $DISPATCH_RES_2"
pass "dispatch rung=embedded ($DISPATCH_RES_2)"

echo "==> Waiting for cursor feed events"
# The fake's session/new response carries the fixture sessionId — its presence on a started
# row is the unambiguous "this spawn was the CURSOR adapter" signal (the claude scenario's
# session ids never collide with it). assistant text: the fixture agent_message_chunk "ping",
# flushed as assistant-text at the tool_call boundary. The tool row is the recorded execute
# fixture (`touch /tmp/forge-spike-probe`).
CURSOR_SESSION_ID="0d66f7c5-8dd6-4639-9480-03ee52d077ca"
deadline=$((SECONDS + 15))
have_cursor_started=0 have_cursor_text=0 have_cursor_tool=0
while (( SECONDS < deadline )); do
  if grep '"kind":"started"' "$EVENTS_FILE" 2>/dev/null | grep -q "$CURSOR_SESSION_ID"; then have_cursor_started=1; fi
  if grep '"kind":"assistant-text"' "$EVENTS_FILE" 2>/dev/null | grep -q '"text":"ping"'; then have_cursor_text=1; fi
  if grep '"kind":"tool-started"' "$EVENTS_FILE" 2>/dev/null | grep '"execute"' | grep -q 'forge-spike-probe'; then have_cursor_tool=1; fi
  if (( have_cursor_started && have_cursor_text && have_cursor_tool )); then
    break
  fi
  sleep 0.2
done
(( have_cursor_started )) || fail "missing cursor started event (sessionId $CURSOR_SESSION_ID). feed so far:\n$(cat "$EVENTS_FILE")"
(( have_cursor_text ))    || fail "missing cursor assistant-text(ping). feed so far:\n$(cat "$EVENTS_FILE")"
(( have_cursor_tool ))    || fail "missing cursor execute tool-started. feed so far:\n$(cat "$EVENTS_FILE")"
pass "cursor feed: started($CURSOR_SESSION_ID…) → assistant-text(ping) → tool-started(execute)"

echo "==> Cursor approval round-trip (park → decide REJECT)"
# The execute-kind session/request_permission is bridged through CursorAdapter.onApproval →
# ApprovalRegistry → the same {type:"approval"} stream line as the claude flow, with
# toolName = the ACP tool kind ("execute") — distinct from the claude section's "Bash".
deadline=$((SECONDS + 10))
CURSOR_APPROVAL_ID=""
while (( SECONDS < deadline )); do
  CURSOR_APPROVAL_ID="$(node -e "
    const fs=require('fs');
    const lines=fs.readFileSync(process.argv[1],'utf8').split(/\n/).filter(Boolean);
    for (const l of lines) {
      try {
        const j=JSON.parse(l);
        if (j.type==='approval' && j.toolName==='execute') { process.stdout.write(j.id); process.exit(0); }
      } catch {}
    }
  " "$EVENTS_FILE" || true)"
  if [[ -n "$CURSOR_APPROVAL_ID" ]]; then break; fi
  sleep 0.2
done
[[ -n "$CURSOR_APPROVAL_ID" ]] || fail "cursor approval-request never appeared on the event stream. feed so far:\n$(cat "$EVENTS_FILE")"
pass "approval-request id=$CURSOR_APPROVAL_ID (toolName=execute) on stream"

DECIDE_RES_2="$(curl -sf "${HDR[@]}" -d "{\"id\":\"$CURSOR_APPROVAL_ID\",\"allow\":false}" \
  "$BASE/__the-forge/approval/decide")" || fail "POST /approval/decide (reject) failed"
DECIDE_OK_2="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.ok))" "$DECIDE_RES_2")"
[[ "$DECIDE_OK_2" == "true" ]] || fail "decide(reject) returned ok≠true: $DECIDE_RES_2"
pass "decide(reject) → ok"

deadline=$((SECONDS + 5))
have_reject_resolved=0
while (( SECONDS < deadline )); do
  if grep '"type":"approval-resolved"' "$EVENTS_FILE" 2>/dev/null \
    | grep -q "\"id\":\"$CURSOR_APPROVAL_ID\",\"allow\":false"; then
    have_reject_resolved=1
    break
  fi
  sleep 0.1
done
(( have_reject_resolved )) || fail "missing approval-resolved(allow=false) on stream. feed so far:\n$(cat "$EVENTS_FILE")"
pass "approval-resolved(allow=false) on stream"

# The reject must have actually reached the fake CLI as the reject_once ACP answer — the
# adapter's reply rides the fake's stdin, so its receipt log is the only observable record.
deadline=$((SECONDS + 5))
have_reject_receipt=0
while (( SECONDS < deadline )); do
  if grep '"received":"permission_response"' "$FAKE_CURSOR_LOG" 2>/dev/null | grep -q '"optionId":"reject-once"'; then
    have_reject_receipt=1
    break
  fi
  sleep 0.1
done
(( have_reject_receipt )) || fail "reject-once receipt missing from fake cursor log. receipts so far:\n$(cat "$FAKE_CURSOR_LOG")"
pass "reject-once answer receipt in fake cursor log"

# The rejected turn still finishes cleanly: tool-finished + a NEW turn-complete (a rejected
# turn resolves stopReason end_turn — never an error turn).
deadline=$((SECONDS + 10))
have_cursor_complete=0
while (( SECONDS < deadline )); do
  COMPLETES_NOW="$(grep -c '"kind":"turn-complete"' "$EVENTS_FILE" || true)"
  if (( COMPLETES_NOW > COMPLETES_BEFORE )); then have_cursor_complete=1; break; fi
  sleep 0.2
done
(( have_cursor_complete )) || fail "cursor turn never completed after reject. feed so far:\n$(cat "$EVENTS_FILE")"
pass "cursor turn-complete after reject"

echo "==> Harness switch back: cursor → claude-code"
wait_session_settled
SWITCH_BACK_RES="$(curl -sf "${HDR[@]}" -d '{"harness":"claude-code"}' "$BASE/__the-forge/session/config")" \
  || fail "POST /session/config {harness:claude-code} failed"
SWITCH_BACK_OK="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.ok))" "$SWITCH_BACK_RES")"
[[ "$SWITCH_BACK_OK" == "true" ]] || fail "harness switch back returned ok≠true: $SWITCH_BACK_RES"
pass "config {harness:claude-code} → ok"

deadline=$((SECONDS + 5))
have_switch_back_evt=0
while (( SECONDS < deadline )); do
  if grep '"kind":"config-changed"' "$EVENTS_FILE" 2>/dev/null | grep -q '"harness":"claude-code"'; then
    have_switch_back_evt=1
    break
  fi
  sleep 0.1
done
(( have_switch_back_evt )) || fail "missing config-changed(harness=claude-code) on stream. feed so far:\n$(cat "$EVENTS_FILE")"
pass "config-changed(harness=claude-code) on stream"

echo "==> Claude turn still works after switching back"
COMPLETES_BEFORE="$(grep -c '"kind":"turn-complete"' "$EVENTS_FILE" || true)"
SAY_RES_2="$(curl -sf "${HDR[@]}" -d '{"text":"hello again after switch"}' "$BASE/__the-forge/session/say")" \
  || fail "POST /session/say (post-switch) failed"
SAY_OK_2="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.ok))" "$SAY_RES_2")"
[[ "$SAY_OK_2" == "true" ]] || fail "post-switch say returned ok≠true: $SAY_RES_2"
pass "say → ok"

deadline=$((SECONDS + 15))
have_switch_user_text=0 have_switch_complete=0
while (( SECONDS < deadline )); do
  if grep '"kind":"user-text"' "$EVENTS_FILE" 2>/dev/null | grep -q 'hello again after switch'; then have_switch_user_text=1; fi
  COMPLETES_NOW="$(grep -c '"kind":"turn-complete"' "$EVENTS_FILE" || true)"
  if (( COMPLETES_NOW > COMPLETES_BEFORE )); then have_switch_complete=1; fi
  if (( have_switch_user_text && have_switch_complete )); then break; fi
  sleep 0.2
done
(( have_switch_user_text )) || fail "missing post-switch user-text. feed so far:\n$(cat "$EVENTS_FILE")"
(( have_switch_complete )) || fail "post-switch claude turn never completed. feed so far:\n$(cat "$EVENTS_FILE")"
pass "post-switch claude turn: user-text → turn-complete"

echo
echo "ALL CHECKS PASSED (fake-claude feed E2E (embedded session + chat) + fake-cursor harness switch)"
