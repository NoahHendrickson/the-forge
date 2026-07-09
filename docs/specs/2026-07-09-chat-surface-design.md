# Chat surface (milestone B) — design doc

**Date:** 2026-07-09
**Status:** Ratified (2026-07-09) — brainstormed same-day; implementation not started
**Parent spec:** [2026-07-09-embedded-sessions-design.md](2026-07-09-embedded-sessions-design.md) (milestone A, merged to main `7afe223` with live-CLI E2E passed)

## 1. Overview & north star

Milestone B turns the activity feed into a chat surface for the embedded session: free-form messages into the same conversation that applies design edits, with live-streamed replies, tool diffs, and model/effort/permission pickers.

**North-star criteria (user, 2026-07-09):** lightweight and easy to start — open the project, pick your harness, pick the model and its effort, toggle design mode, send edits, and talk to the session in the overlay. B delivers everything in that sentence except the harness picker, which is milestone C's job by the ratified adapter order (Claude first; Codex/Cursor are one-adapter-each behind the same `SessionAdapter` interface). Nothing in B may regress the easy-start posture: `npx the-forge init` stays the only setup, Send keeps auto-starting the session, zero new runtime dependencies.

### Ratified decisions (2026-07-09)

1. **Hybrid delivery:** chat messages are **direct turns** into the embedded session (`sendTurn`), never queue items — the queue's "apply exactly as written" framing is for deterministic design edits and was observed live making the agent refuse conversational requests. Element-anchored prompts merge INTO chat as **element chips**; the floating PromptBox is retired.
2. **Scope:** message history + input (core), live-typing streaming, Edit/Write diff rows, model + effort + permission-mode pickers. Mic/voice input stays deferred (again).
3. **Budget:** package ceiling raised **280 → 320KB** — B is the largest client feature to date; the tripwire's job is catching accidents, not blocking planned surface.
4. **Home:** the feed section of the docked panel grows into the chat — history scrolls in place, input pinned at its bottom, pickers in its header. No new top-level surface.
5. **No-session behavior:** input disabled + one-line reason (config-off / binary missing / last error). Typing when merely `idle` auto-starts the session, same semantics as Send.
6. **Architecture (approach A):** ring-authoritative history + manager-side turn FIFO. All rendering derives from the one event stream; reconnect replay gives history persistence for free.
7. **Turn precedence:** on turn-complete, a parked pull nudge flushes before queued chat turns — visible design edits outrank conversation by one turn.

## 2. Server & protocol

### 2.1 `POST /__the-forge/session/say` (secret-gated, MUTATING_PATHS)

Body `{ text: string, element?: { source: string, tag: string } }`.

- `text`: non-empty, ≤ 4,000 chars (sanity cap, not security).
- `element.source`: must match `^[\w./-]+:\d+:\d+$`; `element.tag`: must match `^[a-z][a-z0-9-]*$`. This is the documented **carve-out to the parent spec's §3.6 constant-turn-text rule**: turn text is user-typed chat plus a regex-pinned element reference — never free DOM/computed content.
- Rejections: 400 (validation), 429-style `{error}` when the chat FIFO is full.

### 2.2 SessionManager additions

- `say(text, element?)`: composes the turn (`text` + optional trailing `[Selected element: <source> <tag>]` line), pushes `{kind:'user-text', text, element?}` to the ring, then by state: `ready` → send now (busy + watchdog); `busy`/`starting` → park in `_chatQueue` (FIFO, cap 20 — **not** the nudge's dedup slot: two messages are two turns); `idle`/`failed` → start + send immediately (lazy-boot send-at-spawn semantics, same as the pull path).
- Turn-complete flush order: pull nudge, then chat FIFO in order.
- **In-flight turn recovery:** the manager records the text of the turn currently in flight; watchdog/crash respawn re-sends *that* turn (milestone A always re-sent `PULL_TURN_TEXT`, which would silently drop a dying chat turn).
- New ring-borne SessionEvents: `user-text {text, element?}`, `config-changed {model?, permissionMode?, effort?}`.
- Subscriber-only SessionEvent (never pushed to the ring, like `activity`): `assistant-delta {text}`.

### 2.3 ClaudeAdapter additions

- `--include-partial-messages` joins `CLAUDE_ARGS`; `stream_event` text deltas → `assistant-delta`. The final complete `assistant` message still arrives and is pushed to the ring as today — the ring stays bounded and replay shows whole messages; a client mid-stream replaces its in-progress bubble with the final text.
- `tool-started` for Edit/Write/MultiEdit gains optional `edit: {file, before, after}` (each side truncated to ~1.5KB) — raw material for diff rows.
- `setModel(model)`, `setPermissionMode(mode)`, `setEffort(level)` write the CLI's control requests to stdin. Exact wire shapes (and whether effort is a control request or requires respawn with a flag) are pinned by the spike (§6) before implementation.

### 2.4 `POST /__the-forge/session/config` (secret-gated)

`{ model?, permissionMode?, effort? }`. Hard allowlists: `permissionMode ∈ {default, acceptEdits, plan}` — **`bypassPermissions` deliberately excluded** (it would silently disable the overlay approval gate); `effort` from the spike-pinned level set. Success pushes `config-changed` to the ring so every connected panel sees it.

### 2.5 `/status` addition

`sessionEnabled: boolean` (from `dispatchConfig.embedded`) so the client can distinguish "disabled in config" from runtime failures.

## 3. Client

- `session-feed.ts` keeps its file name and `.session-feed` root class (test hooks: extend, don't rename). Adds: `.chat-msg.user` / `.chat-msg.assistant` bubbles from `user-text`/`assistant-text`; an in-progress bubble fed by `assistant-delta` and replaced by the final message; tool/approval rows interleave in the same list as today.
- **Input cluster** pinned at the section bottom: textarea + Send via `ui/` factories, Cmd/Ctrl-Enter sends, `.chat-chip` shows the attached element (`main · App.tsx:3 ×`), cleared on send or ×.
- **Prompt button** (panel header) now focuses the chat input and attaches the selected element's chip. `prompt.ts` (PromptBox) is deleted. The queue's `kind:'prompt'` handling stays server-side for old queue files; nothing produces new prompt items.
- **Diff rows:** Edit/Write tool rows with an `edit` payload get a collapsed `.session-diff` disclosure — before/after blocks, hand-rolled render, no diff library.
- **Header:** model select, effort select, permission-mode select (all `ui/select`), seeded from `started` + `config-changed`; Stop as today.
- **Disabled states:** input disabled + reason line — `sessionEnabled:false` → "Embedded sessions are disabled in config"; `failed` → last `session-error` text from the ring; binary-missing surfaces the spawn error the same way.
- Stories for chat bubbles, chip, diff row, picker header in `stories/`.

## 4. Security

Delta from milestone A only:

- §3.6 carve-out (above): user chat + regex-pinned element reference in turn text.
- `/say`, `/config` secret-gated POSTs behind the same Origin/Host + DNS-rebinding gates.
- `permissionMode` allowlist excludes `bypassPermissions`; effort/model values allowlist-validated.
- Flood control: 4,000-char text cap, FIFO cap 20.

## 5. Reliability

- Chat turns share milestone A's busy/watchdog machinery (deltas re-arm it like any event).
- FIFO contents survive respawn (manager-side state); the in-flight turn is re-sent on recovery (§2.2).
- Ring cap 200 evicts old rows in long conversations — accepted; the ring is recent-history, not an archive.
- Reconnect mid-stream: deltas are lost by design; the final `assistant-text` replay renders the complete message.

## 6. Spike (pre-implementation, real CLI — the lazy-boot lesson institutionalized)

Cheap piped-turn probes, recorded outputs become adapter fixtures:

1. `stream_event` delta shapes under `--include-partial-messages`.
2. `set_model` / `set_permission_mode` control-request + ack wire shapes.
3. **Effort mechanism:** what the CLI exposes (control request vs. spawn flag) and the level vocabulary; if respawn-only, the picker respawns with `--resume` (session survives).
4. Second user turn written mid-turn: does the CLI queue it cleanly? (Decides whether the FIFO may ever trust stdin buffering; default remains flush-on-turn-complete.)

## 7. Testing

- **Manager:** `say()` from every state; FIFO order; nudge-before-chat precedence; in-flight-turn recovery re-sends the chat turn; `user-text` in ring/replay; `assistant-delta` never in ring; FIFO survives respawn.
- **Adapter:** delta mapping from spike fixtures; `edit` extraction + truncation; control-request stdin writes.
- **Endpoints:** `/say` validation (regex negatives, caps, FIFO overflow), `/config` allowlists, secret gates, `/status.sessionEnabled`.
- **Client (jsdom):** bubble rendering from synthetic streams; delta→final replacement; chip attach/clear; disabled reasons; diff collapse; picker seeding.
- **fake-claude:** chat scenario (deltas + Edit with before/after + config acks); `e2e-embedded-feed.sh` extended to cover say → stream → reply.
- **Live E2E** (real browser + real CLI) at milestone end; **budget gate 320KB** in `check-prod-clean.sh`.

## 8. Out of scope

- Mic/voice input (deferred; Web Speech research lives in the prompt-mode spec).
- Codex/Cursor adapters and the harness picker (milestone C).
- Chat persistence beyond the ring (no transcript archive).
- Any queue/lifecycle changes — design edits' `draft → sent → applying → done` path is untouched.
