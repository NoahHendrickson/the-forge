# Chat surface — milestone B: feed becomes the conversation (2026-07-09)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: [docs/specs/2026-07-09-chat-surface-design.md](../specs/2026-07-09-chat-surface-design.md). Parent: [docs/specs/2026-07-09-embedded-sessions-design.md](../specs/2026-07-09-embedded-sessions-design.md) (milestone A, merged `7afe223`).

**Goal:** Free-form chat with the embedded session in the overlay feed — direct turns (never queue items), element chips replacing the PromptBox, live-streamed replies, Edit/Write diff rows, and model/effort/permission pickers.

**Architecture:** Ring-authoritative history: `user-text` events join the same ring/stream the feed already renders, so replay-on-reconnect gives history for free. Manager gains a chat FIFO (nudge flushes first) and in-flight-turn recovery; adapter gains delta streaming, edit payloads, and config control-requests; two new endpoints (`/session/say`, `/session/config`). Queue/lifecycle for design edits: untouched.

**Tech stack:** unchanged — TypeScript, node child_process/http, vanilla shadow-DOM client, vitest + jsdom. Zero new dependencies.

## Global constraints (from spec + CLAUDE.md)

- Zero new runtime deps; zero prod footprint; zero idle overhead (no stream/timer until design mode on).
- Turn text = user-typed chat + a regex-pinned element reference ONLY (`^[\w./-]+:\d+:\d+$` source, `^[a-z][a-z0-9-]*$` tag) — the documented §3.6 carve-out; never free DOM/computed content. Text cap 4,000 chars; FIFO cap 20.
- `permissionMode` allowlist `{default, acceptEdits, plan}` — `bypassPermissions` NEVER accepted (silently disables the approve gate).
- New POSTs secret-gated via MUTATING_PATHS; same Origin/Host gates.
- Buttons/selects via `src/client/ui/` factories; new CSS classes are test hooks (`.chat-msg`, `.chat-input`, `.chat-chip`, `.session-diff`, `.session-config`); extend, don't rename `.session-feed`; stories for new atoms.
- `unknown` + manual checks at I/O boundaries; injectable spawn/clock — tests never spawn real `claude` or wait real time.
- Package budget: **320KB** (raised from 280 — ratified 2026-07-09).
- Tests mirror `src/`; root `npm test` after every task; real-browser + live-CLI E2E before merge (Task 8).

**Sequencing:** Task 1 (spike) gates Tasks 2–4 details; 2→7 in order, each `npm test`-green, each its own commit; Task 8 is the E2E gate. Single-file test commands run from `packages/the-forge/`.

---

### Task 1 — spike: pin the wire shapes on the real CLI (no product code)

**Files:**
- Create: `packages/the-forge/tests/server/session/fixtures/claude-chat-ndjson.ts` (recorded string constants)
- Modify: `docs/specs/2026-07-09-chat-surface-design.md` (§6 → record findings; fill the effort vocabulary in §2.4)

**Probes** (piped-turn one-shots from the project root, like the 2026-07-09 lazy-boot probes; each output saved then distilled into fixture constants):

- [ ] **Step 1: delta shapes** — `echo '<user turn json>' | claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` → record the `stream_event` lines for a short text reply: the exact envelope (`{"type":"stream_event","event":{...}}`), which inner events carry text deltas (`content_block_delta`/`text_delta`), and confirm the final complete `assistant` message still arrives.
- [ ] **Step 2: config control requests** — start a held-open session, write `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"set_model","model":"claude-haiku-4-5-20251001"}}` and the `set_permission_mode` equivalent; record ack shapes (`control_response`) and whether a subsequent turn reflects the change.
- [ ] **Step 3: effort mechanism** — check `claude --help` / control-request vocabulary for effort (e.g. `set_effort` subtype or a spawn flag); record the level names the CLI accepts. Decision rule: control request exists → pickers use it; respawn-only → `setEffort` respawns with `--resume` + flag (Task 3 has both branches specced).
- [ ] **Step 4: mid-turn second turn** — during a slow turn, write a second user message; record whether the CLI queues it as the next turn (clean) or interleaves/errors. Either way the manager FIFO stays (flush-on-turn-complete); this only decides whether an already-written race is HARMLESS (documentation) or must never happen (guard comment).
- [ ] **Step 5: commit** — fixtures + spec §6 findings: `docs(spike): pin stream-delta/config/effort wire shapes (live CLI)`

---

### Task 2 — adapter: deltas, edit payloads, config controls

**Files:**
- Modify: `packages/the-forge/src/server/session/adapter.ts`, `packages/the-forge/src/server/session/claude.ts`
- Test: `packages/the-forge/tests/server/session/claude.test.ts` (extend, using Task 1 fixtures)

**Interfaces produced:**

```ts
// adapter.ts — SessionEvent union gains:
| { kind: 'user-text'; text: string; element?: { source: string; tag: string } }  // manager-produced
| { kind: 'assistant-delta'; text: string }             // subscriber-only, never ringed
| { kind: 'config-changed'; model?: string; permissionMode?: string; effort?: string }
// tool-started gains an optional field:
| { kind: 'tool-started'; toolId: string; name: string; detail: string;
    edit?: { file: string; before: string; after: string } }

// SessionAdapter gains:
setModel(model: string): void
setPermissionMode(mode: string): void
setEffort(level: string): void   // no-op body allowed only if spike proved respawn-only (manager owns respawn)

// claude.ts
export const EDIT_PAYLOAD_CAP = 1_500   // chars per side, truncated with '…'
```

**Contract:**
- `--include-partial-messages` joins `CLAUDE_ARGS` (constants test updated).
- `stream_event` with a text delta (exact path per Task 1 fixtures) → `assistant-delta {text}`; all other `stream_event`s → `activity` (as today). Final `assistant` message events unchanged.
- `tool_use` named `Edit`/`MultiEdit` → `edit: {file: input.file_path, before: input.old_string, after: input.new_string}`; `Write` → `{file, before: '', after: input.content}`; each side truncated to `EDIT_PAYLOAD_CAP`. Absent/malformed inputs → no `edit` field (never throw).
- `setModel`/`setPermissionMode` write the Task-1-recorded control-request lines + newline; `setEffort` per spike outcome.

- [ ] **Step 1: failing tests** — `maps stream_event text delta → assistant-delta (fixture)`, `non-delta stream_event → activity`, `Edit tool_use → edit payload with truncation at EDIT_PAYLOAD_CAP`, `Write → before empty`, `missing old_string → no edit field`, `setModel/setPermissionMode write exact stdin lines (fixture)`, `CLAUDE_ARGS contains --include-partial-messages`.
- [ ] **Step 2: verify failure** — `npx vitest run tests/server/session/claude.test.ts` → FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4–5: verify + root gate** (`npm test`).
- [ ] **Step 6: commit** — `feat(server): adapter deltas, edit payloads, config control-requests`

---

### Task 3 — manager: say(), chat FIFO, in-flight recovery, config

**Files:**
- Modify: `packages/the-forge/src/server/session/manager.ts`
- Test: `packages/the-forge/tests/server/session/manager.test.ts` (extend)

**Interfaces produced:**

```ts
export const CHAT_QUEUE_CAP = 20
export type SayResult = { ok: true } | { ok: false; reason: 'queue-full' }
export interface ElementRef { source: string; tag: string }   // pre-validated by the endpoint

// SessionManager gains:
say(text: string, element?: ElementRef): SayResult
setConfig(cfg: { model?: string; permissionMode?: string; effort?: string }): void
```

**Contract:**
- `say()` composes the turn: `text` + (element ? `\n\n[Selected element: ${source} <${tag}>]` : ''). Pushes `{kind:'user-text', text, element}` to the RING immediately (the message appears in every panel now, whatever the state). Then: `ready` → `_sendTurnText(composed)` (busy + watchdog); `busy`/`starting` → push composed text to `_chatQueue` (≥ CHAT_QUEUE_CAP → return `{ok:false,reason:'queue-full'}` and pop the just-pushed `user-text`? NO — reject BEFORE ringing: cap check first, then ring); `idle`/`failed` → `_start()` + send immediately (lazy-boot send-at-spawn, same as the pull path).
- `_sendTurn()` generalizes to `_sendTurnText(text)`; the pull path calls it with `PULL_TURN_TEXT`. The manager records `_inflightTurn: string` on every send.
- Turn-complete (no error) flush order: parked pull nudge FIRST, then `_chatQueue.shift()` — one turn per completion, as today.
- **Recovery re-sends `_inflightTurn`** (watchdog fire + ended-while-busy respawn) instead of always `PULL_TURN_TEXT`. `_chatQueue` survives respawn (plain field). Stale-resume retry (`_start(true)`) also re-sends `_inflightTurn`.
- `assistant-delta` events: fan to subscribers as `{seq: 0, at, event}` — **never pushed to the ring** (seq 0 marks ephemeral; clients must not regress `lastSeq` on it). `activity` stays fully internal (no fan-out) as today.
- `setConfig()` calls the adapter methods for the provided keys, then pushes `{kind:'config-changed', ...cfg}` to the ring. If the spike proved effort is respawn-only: effort changes when NOT busy → `_discardAdapter()?.stop()` + `_start()` with the effort flag threaded through a `_spawnEffort` field consumed by `makeAdapter` — concretely: `SessionManagerOpts.makeAdapter` becomes `(opts?: { effort?: string }) => SessionAdapter` and `ClaudeAdapter` appends the spike-named flag; effort changes while busy → reject (endpoint 409) rather than killing a live turn.
- `stop()` clears `_chatQueue` and `_inflightTurn` (dev-server close).

- [ ] **Step 1: failing tests** — `say when ready sends composed turn with element line`, `say when idle auto-starts and sends immediately`, `say when busy queues; queue-full returns {ok:false} and rings nothing`, `two queued says flush in FIFO order after nudge`, `nudge flushes before chat queue`, `user-text lands in ring/replay; assistant-delta fans with seq 0 and never lands in ring`, `watchdog respawn re-sends the in-flight CHAT turn (not PULL_TURN_TEXT)`, `chat queue survives respawn`, `setConfig calls adapter + rings config-changed`, `stop clears chat queue`.
- [ ] **Step 2: verify failure.**
- [ ] **Step 3: implement.**
- [ ] **Step 4–5: verify + root gate.**
- [ ] **Step 6: commit** — `feat(server): manager say()/chat FIFO/in-flight recovery/config`

---

### Task 4 — endpoints: /session/say, /session/config, status.sessionEnabled

**Files:**
- Modify: `packages/the-forge/src/server/endpoints.ts`
- Test: `packages/the-forge/tests/server/endpoints.test.ts` (extend)

**Contract:**
- `POST /__the-forge/session/say` (MUTATING_PATHS): body `{text, element?}`. Validation order: `text` is a non-empty string ≤ 4,000 chars (else 400); if `element` present, `source` matches `/^[\w./-]+:\d+:\d+$/` AND `tag` matches `/^[a-z][a-z0-9-]*$/` (else 400 — never forwarded partially). `manager.say(...)` → `{ok:true}` 200 | queue-full → 429 `{error:'chat queue full'}`. No session wired → 404 (same text as the other session endpoints).
- `POST /__the-forge/session/config` (MUTATING_PATHS): `{model?, permissionMode?, effort?}` — `model` a non-empty string ≤ 100 chars; `permissionMode ∈ {'default','acceptEdits','plan'}` (else 400, with `bypassPermissions` explicitly in the negative tests); `effort ∈` the spike-pinned set. At least one key required. Busy-effort-respawn rejection (Task 3) → 409 `{error:'session is busy'}`.
- `GET /__the-forge/status` gains `sessionEnabled: dispatchConfig.embedded !== false` beside the existing `session` field.

- [ ] **Step 1: failing tests** — secret enforcement on both new POSTs; say happy path calls manager with parsed element; each validation negative (long text, empty text, bad source `../../etc:1:1` — dots fine but spaces/colons-wrong-count rejected, uppercase tag, `<script>` tag); queue-full → 429; config allowlists incl. `bypassPermissions → 400`; status carries `sessionEnabled` false when `embedded:false` config.
- [ ] **Step 2: verify failure.**
- [ ] **Step 3: implement.**
- [ ] **Step 4–5: verify + root gate.**
- [ ] **Step 6: commit** — `feat(server): /session/say + /session/config endpoints, status.sessionEnabled`

---

### Task 5 — client: chat rendering (bubbles, deltas, diffs)

**Files:**
- Modify: `packages/the-forge/src/client/session-feed.ts`, `packages/the-forge/src/client/overlay.ts` (CSS)
- Modify: `packages/the-forge/stories/session-feed.stories.ts` (chat states)
- Test: `packages/the-forge/tests/client/session-feed.test.ts` (extend), `tests/client/overlay.test.ts` (CSS hooks)

**Contract:**
- Stream line handling gains: `user-text` → `.chat-msg.chat-user` bubble (element chip echo rendered as a small `.chat-msg-ref` line when present); `assistant-text` → `.chat-msg.chat-assistant` (replaces the current snippet row rendering for text); `assistant-delta` (seq 0) → create-or-append the single `.chat-msg.chat-assistant.chat-streaming` bubble; the next final `assistant-text` REPLACES it (drop `.chat-streaming`, set full text). `lastSeq` never updated from seq-0 lines.
- `tool-started` with `edit` → the tool row gains a collapsed `.session-diff` disclosure (`<details>`): summary = file basename, body = two `<pre>` blocks `.diff-before`/`.diff-after` (hand-rolled, no diff lib).
- `config-changed` → one `.session-row .session-config` line (`model → x` / `permissions → y` / `effort → z`, only provided keys).
- MAX_ROWS cap applies to bubbles like any row.

- [ ] **Step 1: failing tests** (scripted-stream harness from milestone A): `user-text renders a user bubble with ref line`, `deltas accumulate in one streaming bubble`, `final assistant-text replaces the streaming bubble (no duplicate)`, `reconnect mid-stream (no deltas) still renders the final text`, `edit payload renders collapsed diff with before/after`, `config-changed renders a config row`, `seq-0 lines do not advance the reconnect cursor (next connect uses prior since)`.
- [ ] **Step 2: verify failure.**
- [ ] **Step 3: implement + CSS + stories** (streaming / diff-open / config states).
- [ ] **Step 4–5: verify (Storybook spot-check) + root gate.**
- [ ] **Step 6: commit** — `feat(client): chat bubbles, delta streaming, diff rows`

---

### Task 6 — client: input cluster, element chip, pickers, disabled states; PromptBox retired

**Files:**
- Modify: `packages/the-forge/src/client/session-feed.ts`, `packages/the-forge/src/client/index.ts`, `packages/the-forge/src/client/overlay.ts`, `packages/the-forge/src/client/watch.ts` (`sessionEnabled` parse)
- Delete: `packages/the-forge/src/client/prompt.ts`, `packages/the-forge/tests/client/prompt.test.ts`
- Test: `tests/client/session-feed.test.ts`, `tests/client/design-mode.test.ts`, `tests/client/watch.test.ts` (extend)

**Interfaces produced (SessionFeed additions):**

```ts
onSay: (text: string, element?: { source: string; tag: string }) => void  // host wires to POST /say
onConfig: (cfg: { model?: string; permissionMode?: string; effort?: string }) => void
setChip(el: { source: string; tag: string; label: string } | null): void  // Prompt button / host
setAvailability(a: { enabled: boolean; reason?: string }): void           // disabled input + reason
```

**Contract:**
- Input cluster (`.chat-input`: textarea + Send via `createButton`, Cmd/Ctrl-Enter sends, trims, clears on send) pinned at the feed section bottom; `.chat-chip` above it with a `×` clear; chip cleared on send.
- Header `.session-config-bar`: model select + effort select + permission select via `createSelect`, seeded from `started` (model) and `config-changed` rows; change → `onConfig` with the one changed key.
- `setAvailability(false, reason)` disables textarea+Send and shows `.chat-disabled-reason`. Host derives: `/status.sessionEnabled === false` → config copy; manager state `failed` → last `session-error` text already in the feed; otherwise enabled (typing when idle is fine — say auto-starts).
- `index.ts`: Prompt button now `feed.setChip({...selected element…})` + focus the chat textarea (PromptBox path deleted, including its overlay CSS block and the `kind:'prompt'` queue POST); `onSay` → POST `/session/say` with secret headers, 429 → transient row `chat queue full — wait for the current turn`; `onConfig` → POST `/session/config`.
- `watch.ts`: parse `sessionEnabled` from `/status` (untyped-JSON guards), expose `sessionEnabled(): boolean | undefined` for the host.

- [ ] **Step 1: failing tests** — `send fires onSay with trimmed text + chip element and clears both`, `Cmd-Enter sends`, `empty text never fires`, `chip renders label and × clears`, `pickers seed from started/config-changed and fire onConfig with single key`, `setAvailability disables input with reason`, design-mode: `Prompt button sets chip + focuses chat input (no .prompt-box in DOM)`, `say POSTs /session/say with secret`, `429 renders queue-full row`, watch: `sessionEnabled parsed with unknown-shape tolerance`.
- [ ] **Step 2: verify failure.**
- [ ] **Step 3: implement; delete prompt.ts + tests + CSS; grep `prompt-box`/`PromptBox` → zero hits outside git history.**
- [ ] **Step 4–5: verify + root gate.**
- [ ] **Step 6: commit** — `feat(client): chat input + element chip + pickers; retire PromptBox`

---

### Task 7 — fake-claude chat scenario, E2E script, docs, budget gate

**Files:**
- Modify: `scripts/fake-bin/claude` (chat scenario: deltas + Edit-with-payload + config acks, still lazy-boot), `scripts/e2e-embedded-feed.sh` (say → stream → reply → diff assertions), `scripts/check-prod-clean.sh` (`MAX_UNPACKED_KB=320` + comment), `CLAUDE.md`, `AGENTS.md`
- Test: none new (script-level)

- [ ] **Step 1: fake-claude** — on user turn in scenario `chat`: emit 3 `stream_event` text deltas (Task 1 fixture shapes), the final assistant message, an Edit `tool_use` carrying `old_string`/`new_string`, `tool_result`, `result`. Ack `set_model`/`set_permission_mode` control requests with the recorded ack shape.
- [ ] **Step 2: e2e script** — new section: POST `/session/say` (with secret) → assert stream shows `user-text`, ≥1 seq-0 delta line, final assistant text, diff-bearing tool row; POST `/session/config {model}` → assert `config-changed` on stream + ack in fake log.
- [ ] **Step 3: docs** — CLAUDE.md + AGENTS.md byte-identical where shared: module table rows (prompt.ts removed, session-feed.ts description → chat surface), architecture-loop mention of `/session/say`, budget 320 in the commands comment, gotcha: "assistant-delta lines carry seq 0 — ephemeral, never in the ring; don't advance reconnect cursors on them".
- [ ] **Step 4: run** `./scripts/e2e-embedded-feed.sh` → ALL CHECKS PASSED (kill stale 5173 first; rm -rf `fixtures/next-demo/.next` if a dev run preceded) and `./scripts/check-prod-clean.sh` → PASS at ≤320KB.
- [ ] **Step 5: root gate + commit** — `feat: fake-claude chat scenario, E2E coverage, docs, 320KB budget`

---

### Task 8 — E2E gates (real browser + live CLI)

**Files:** none (verification only; fix-forward commits).

- [ ] **Step 1: build + fresh server** — `npm run build`; kill stale dev servers (`lsof -iTCP:5173`); start demo app. (Bundle-cache rule: restart mandatory.)
- [ ] **Step 2: live chat loop** — design mode on → select element → Prompt → chip attached → send "make this heading bolder and explain what you changed" → feed streams deltas live → agent edits → diff row shows the change → verifier untouched (no lifecycle row for chat — by design). Then a design-edit Send mid-chat-turn → nudge-before-FIFO order observable in the feed.
- [ ] **Step 3: pickers live** — switch model + effort + permission mode; `config-changed` rows appear; next turn reflects them (init/ack evidence in `.the-forge`-discovered transcript or feed).
- [ ] **Step 4: degraded states** — `embedded: false` config → input disabled with config reason; kill the child mid-chat-turn → recovery re-sends the CHAT turn (message answered after respawn, not lost).
- [ ] **Step 5: Next smoke** — chat round-trip through the sidecar proxy (say + streamed reply latency check, same curl probe as milestone A's 23ms measurement).
- [ ] **Step 6: gates** — `./scripts/check-prod-clean.sh` + final `npm test` → green. Hand the branch to the user for the merge decision.

---

## Self-review notes

- Spec §2.1→Task 4, §2.2→Task 3, §2.3→Task 2, §2.4→Tasks 2/3/4, §2.5→Tasks 4/6, §3→Tasks 5/6, §4→Task 4 (validation) + global constraints, §5→Task 3 (recovery/FIFO), §6→Task 1, §7→every task's Step 1 + Tasks 7/8, §8 exclusions honored (no queue changes; prompt.ts deleted, `kind:'prompt'` server handling untouched).
- Effort's both-branches contract lives in Task 3 (control request vs respawn-with-`--resume`), gated by Task 1 Step 3 — no TBDs left in task bodies.
- Type-consistency check: `SayResult`/`ElementRef` (Task 3) consumed by Task 4; `onSay`/`setChip`/`setAvailability` (Task 6) consumed by Task 6's own index.ts wiring; `edit` payload shape (Task 2) consumed by Task 5; seq-0 ephemeral rule stated identically in Tasks 3/5/7.
- Idle-zero audited: chat adds no timers; input cluster is inert DOM until design mode on; FIFO/queue are plain fields.
