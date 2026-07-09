# Embedded session — milestone A: engine + activity feed (Claude Code) (2026-07-09)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: [docs/specs/2026-07-09-embedded-sessions-design.md](../specs/2026-07-09-embedded-sessions-design.md). Research: [docs/research/2026-07-09-embedded-sessions.md](../research/2026-07-09-embedded-sessions.md).

**Goal:** Send auto-starts an embedded Claude Code session (spawned by the dev-server runtime at the project root) when none is running, delivers change requests to it as the new top dispatch rung, and streams its activity — including Allow/Deny approval prompts — into a feed in the overlay. No free-form chat input (milestone B).

**Architecture:** New `src/server/session/` (adapter types, Claude stream-json adapter, manager, approvals registry) owned by `ForgeRuntime`; four new HTTP endpoints; a new `approve` MCP tool riding the existing bin; an `'embedded'` dispatch rung; client `SessionFeed` consuming an authenticated NDJSON stream. Queue / `pull_design_edits` / `mark_applied` / verifier are untouched — the embedded agent is a normal MCP consumer.

**Tech stack:** TypeScript, node:child_process + node:http (server), vanilla DOM in the shadow overlay, vitest + jsdom. Zero new dependencies.

## Global constraints (from spec + CLAUDE.md)

- Zero new runtime dependencies; zero production footprint (`apply: 'serve'` unchanged); zero idle overhead — nothing spawns and no stream/timer exists until design mode is on AND a Send (or explicit start) happens.
- Official CLI binary only (`claude`), never `--bare` (skips auth + harness — smoke-tested), never the Agent SDK or API keys.
- Turn text sent to the child is CONSTANT (same rule as dispatch.ts's AppleScript scripts and protocol.ts's canned texts) — request content never travels through the turn; the agent pulls via MCP.
- Permission posture (user-ratified): edit-tier tools + our MCP tools statically allowed; everything else routes to the overlay via `--permission-prompt-tool mcp__the-forge__approve`. Unanswered approvals time out to deny.
- All new mutating endpoints secret-gated; the events stream requires the secret too (it carries file paths/commands).
- New buttons through `src/client/ui/` factories; new CSS class names are test hooks (`.session-feed`, `.session-row`, `.session-approval`, `.session-stop`); stories for new atoms.
- `unknown` + manual checks at I/O boundaries; injectable spawn/clock/exec everywhere — tests never spawn a real `claude` or wait real time.
- Tests mirror `src/`; root `npm test` is the gate after every task; real-browser E2E before merge. **Live-CLI E2E blocked until the user's weekly limit resets (Jul 12)** — Task 9 is split accordingly.

**Sequencing:** Tasks 1→8 in order (each `npm test`-green, each its own commit), Task 9 is the E2E gate. Run single-file test commands from `packages/the-forge/`.

---

### Task 1 — adapter contract + Claude stream-json adapter

**Files:**
- Create: `packages/the-forge/src/server/session/adapter.ts`
- Create: `packages/the-forge/src/server/session/claude.ts`
- Test: `packages/the-forge/tests/server/session/claude.test.ts`
- Fixtures: `packages/the-forge/tests/server/session/fixtures/claude-ndjson.ts` (string constants from the 2026-07-09 live smoke-test transcripts: init, assistant text, assistant tool_use, user tool_result, result success, result `is_error:true` rate-limit variant, result auth-failure variant)

**Interfaces produced (everything later tasks rely on):**

```ts
// adapter.ts — harness-agnostic; Codex/Cursor implement this later (spec §3.2)
export type SessionEvent =
  | { kind: 'started'; sessionId: string; model: string; mcpLoaded: boolean }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-started'; toolId: string; name: string; detail: string }
  | { kind: 'tool-finished'; toolId: string }
  | { kind: 'turn-complete'; isError: boolean; errorText?: string; costUsd?: number }
  | { kind: 'session-error'; text: string }   // spawn failure, stderr, unparseable protocol state
  | { kind: 'ended' }                          // child exited (any reason)

export interface SessionAdapter {
  start(opts: { cwd: string; resumeId?: string }): void
  sendTurn(text: string): void
  interrupt(): void
  stop(): void
  onEvent: (e: SessionEvent) => void
}

// claude.ts
export interface SpawnedChild {
  stdin: { write(s: string): void; end(): void }
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  kill(signal?: string): void
  on(ev: 'exit' | 'error', fn: (...a: unknown[]) => void): void
}
export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string }) => SpawnedChild
export const CLAUDE_ARGS: string[]        // the exact flag set (below) minus --resume
export const EDIT_TIER_ALLOW: string[]    // static allow rules
export class ClaudeAdapter implements SessionAdapter { constructor(spawnFn?: SpawnFn) {...} }
```

Spawn contract (validated live 2026-07-09, CLI 2.1.201):

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --permission-prompt-tool mcp__the-forge__approve \
  --allowedTools <EDIT_TIER_ALLOW…> \
  [--resume <resumeId>]
```

`EDIT_TIER_ALLOW = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'mcp__the-forge__pull_design_edits', 'mcp__the-forge__mark_applied']` — the ratified "edits auto, Bash prompts" posture expressed as static rules (static rules short-circuit the prompt tool; everything else reaches `approve`). Never `--bare`, no `--model` (user's default).

Event mapping (fixture-pinned):
- `system/init` → `started` (`mcpLoaded`: `mcp_servers` contains a `the-forge` entry with healthy status).
- `assistant` with `text` blocks → one `assistant-text` per block; with `tool_use` blocks → `tool-started` (`detail`: `input.file_path ?? input.command ?? ''` truncated to 120 chars).
- `user` with `tool_result` blocks → `tool-finished` by `tool_use_id`.
- `result` → `turn-complete` (`isError` from `is_error`, `errorText` from `result` when error, `costUsd` from `total_cost_usd`). **In-band errors (rate-limit 429, auth) arrive here with exit 0** — smoke-tested; they must NOT map to `session-error`.
- Unknown `type` values → ignored (forward-compat, same posture as the client's untyped-JSON guards).
- `interrupt()` writes `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt"}}` + newline.
- `sendTurn(text)` writes `{"type":"user","message":{"role":"user","content":[{"type":"text","text":<text>}]}}` + newline.
- Partial stdout lines buffered until `\n` (NDJSON splitter); unparseable lines ignored.
- child `exit`/`error` → `ended` / `session-error` then `ended`.

- [x] **Step 1: failing tests** — `claude.test.ts` with a fake `SpawnFn` (in-memory PassThrough streams). Sketch:
  - `spawns claude with the exact contract args and cwd` (assert argv incl. `--permission-prompt-tool mcp__the-forge__approve`, no `--bare`; `--resume x` appended when `resumeId` given)
  - `maps init → started with mcpLoaded true/false` (two fixture variants)
  - `maps assistant text and tool_use → assistant-text / tool-started with path detail`
  - `pairs tool_result → tool-finished by id`
  - `maps result success → turn-complete {isError:false, costUsd}`
  - `maps in-band rate-limit result → turn-complete {isError:true, errorText contains "weekly limit"}` (fixture from smoke test)
  - `handles NDJSON split across chunk boundaries` (feed a fixture line in two writes)
  - `ignores unknown event types and unparseable lines`
  - `sendTurn/interrupt write exact stdin lines`
  - `child exit → ended; spawn error → session-error then ended`
- [x] **Step 2: run to verify failure** — `npx vitest run tests/server/session/claude.test.ts` → FAIL (module not found).
- [x] **Step 3: implement** `adapter.ts` + `claude.ts` per the contract above. `claude.ts` imports `spawn` from `node:child_process` at top (default `SpawnFn` wraps it); adapters never read `process.*` directly.
- [x] **Step 4: verify** — task tests PASS.
- [x] **Step 5: root gate** — `npm test` → green.
- [x] **Step 6: commit** — `feat(server): SessionAdapter contract + Claude stream-json adapter`

---

### Task 2 — SessionManager: lifecycle, watchdog, ring buffer, resume, delivery nudge

**Files:**
- Create: `packages/the-forge/src/server/session/manager.ts`
- Test: `packages/the-forge/tests/server/session/manager.test.ts`

**Interfaces produced:**

```ts
export type SessionState = 'idle' | 'starting' | 'ready' | 'busy' | 'failed'
export interface FeedEvent { seq: number; at: string; event: SessionEvent }
export const WATCHDOG_MS = 120_000       // no stdout event for this long while busy → recover
export const RING_CAPACITY = 200
export const PULL_TURN_TEXT: string       // the ONE constant turn ever sent in milestone A

export interface SessionManagerOpts {
  makeAdapter: () => SessionAdapter       // injectable — tests pass a fake
  forgeDir: string                        // session.json home
  cwd: string                             // resolveProjectRoot — child cwd
  now?: () => number
  watchdogMs?: number
}
export class SessionManager {
  state(): SessionState
  /** Auto-start + deliver: the /dispatch 'embedded' rung. Starts the child when idle/failed,
   * sends PULL_TURN_TEXT when ready, parks ONE pending nudge when busy/starting (single slot —
   * the pull claims every pending item, so N Sends need at most one follow-up turn). */
  notifyDesignEdits(): void
  interrupt(): void
  stop(): void                            // kill child, state → idle (dev-server close hook)
  eventsSince(seq: number): FeedEvent[]   // ring-buffer replay
  subscribe(fn: (e: FeedEvent) => void): () => void
}
```

`PULL_TURN_TEXT` (terse — per-tick token-cost rule, zero interpolation): `"New design edits are queued. Call the the-forge MCP tool pull_design_edits, apply each request exactly as written, then call mark_applied. Do not run the app, take screenshots, or preview the result."`

Behavior contract:
- `notifyDesignEdits()` when `idle`/`failed` → `starting` (adapter.start with `resumeId` from `<forgeDir>/session.json` when the file holds one) and park the nudge; on `started` event → write `session.json` (`{sessionId, updatedAt}`), state `ready`, flush parked nudge → `sendTurn` → `busy`.
- `turn-complete` → `ready`; flush parked nudge if any. `turn-complete` with `isError:true` → `failed` (feed shows the in-band text; a later Send retries via auto-start — no retry loop).
- Watchdog: while `busy`, any adapter event re-arms the timer; expiry → `kill` → respawn with `resumeId` → re-send `PULL_TURN_TEXT` (the queue still holds unclaimed/stale-claim items — re-pulling is safe). Synthesize a `session-error {text:'session recovered after stall'}` feed row. Same path for `ended` while `busy`/`starting`.
- `ended` while `ready` (clean exit between turns) → `idle`, no respawn.
- Every adapter event lands in the ring buffer (seq monotonically increasing, capacity 200) and fans out to subscribers. Buffer exists only after first start — idle-zero.

- [x] **Step 1: failing tests** — fake adapter (records calls, exposes `emit(e)`), fake clock. Sketch:
  - `starts idle; notifyDesignEdits spawns, parks nudge, sends turn on started, writes session.json`
  - `resumes with the persisted session id on later starts`
  - `busy: second notifyDesignEdits parks exactly one nudge, flushed once on turn-complete`
  - `turn-complete isError → failed; next notifyDesignEdits restarts`
  - `watchdog fires only while busy, respawns with resume + re-sends turn, emits recovery row`
  - `adapter events re-arm the watchdog` (advance clock just under, emit, advance again)
  - `ended while ready → idle without respawn`
  - `ring buffer caps at RING_CAPACITY, eventsSince(seq) returns the tail, subscribe fans out`
  - `stop kills the child and unsubscribes nothing else` (close-hook semantics)
- [x] **Step 2: verify failure.**
- [x] **Step 3: implement `manager.ts`.** `session.json` read/write with `unknown` + manual checks (corrupt file → ignore, start fresh — never throw).
- [x] **Step 4–5: verify + root gate.**
- [x] **Step 6: commit** — `feat(server): SessionManager — lifecycle, watchdog-resume, event ring buffer`

---

### Task 3 — ApprovalRegistry + `approve` MCP tool

**Files:**
- Create: `packages/the-forge/src/server/session/approvals.ts`
- Modify: `packages/the-forge/src/mcp/protocol.ts` (TOOLS + callTool + ForgeBackend), `packages/the-forge/src/mcp/index.ts` (backend method)
- Test: `packages/the-forge/tests/server/session/approvals.test.ts`, `packages/the-forge/tests/mcp/protocol.test.ts` (extend)

**Interfaces produced:**

```ts
// approvals.ts — single-project pending-approval registry, WatcherHub test style
export const APPROVAL_HOLD_MS = 110_000   // under the bin's 120s client timeout with margin
export interface PendingApproval { id: string; toolName: string; detail: string }
export type ApprovalDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string }
export class ApprovalRegistry {
  /** Registers and parks until decide() or the hold expires (expiry → deny with the
   * timed-out message). Fans a pending-approval FeedEvent to the session subscribers. */
  request(toolName: string, detail: string): { id: string; promise: Promise<ApprovalDecision> }
  decide(id: string, allow: boolean): boolean   // false: unknown/expired id
  pending(): PendingApproval[]                   // replay for a late-connecting feed
}

// protocol.ts — ForgeBackend gains:
approve(toolName: string, input: unknown): Promise<ApprovalDecision>
```

MCP tool (name `approve` — the CLI invokes it as `mcp__the-forge__approve`): inputSchema `{tool_use_id, tool_name, input}` (all optional-tolerant; `unknown` + manual checks). callTool returns the decision **as JSON text** — the CLI parses the text content: allow → `{"behavior":"allow","updatedInput":<the original input, echoed verbatim>}` (empty-object fallback is mobile-client behavior we don't rely on); deny → `{"behavior":"deny","message":"Denied from The Forge overlay"}` / `"…timed out — re-send from The Forge when ready"`. The bin's backend POSTs `/__the-forge/approval` `{toolName, detail}` with a 120s timeout (a human is deciding — hold is server-side); `detail` extracted bin-side from `input.command ?? input.file_path ?? ''`, truncated. Any transport failure → deny (never allow on error, never leave the CLI hanging).

- [x] **Step 1: failing tests.** Registry (fake clock): `parks until decide → allow`, `deny`, `hold expiry → deny with timeout message`, `decide on expired id returns false`, `pending() lists undecided`. Protocol: `approve tool listed with schema`, `allow decision echoes original input as updatedInput JSON`, `deny/timeout text shapes`, `backend transport failure → deny`.
- [x] **Step 2: verify failure.**
- [x] **Step 3: implement.** protocol.ts's approve texts are constants (no server data interpolated into agent-visible text — the decision JSON is machine-parsed by the CLI, not agent instructions, but keep `message` constant anyway).
- [x] **Step 4–5: verify + root gate.**
- [x] **Step 6: commit** — `feat(mcp): approve tool + ApprovalRegistry (overlay-gated permissions)`

---

### Task 4 — endpoints: events stream, interrupt, approval round-trip, status field

**Files:**
- Modify: `packages/the-forge/src/server/endpoints.ts`, `packages/the-forge/src/server/runtime.ts`
- Test: `packages/the-forge/tests/server/endpoints.test.ts` (extend), `tests/server/runtime.test.ts` (extend)

**Contract:**
- `ForgeRuntime` gains `session: SessionManager` + `approvals: ApprovalRegistry` (constructed in `createForgeRuntime` — adapter factory defaults to `ClaudeAdapter`; both idle-zero until used). `createForgeMiddleware` gains an optional `session?: { manager: SessionManager; approvals: ApprovalRegistry }` param (optional so existing callers/tests stand unchanged — same pattern as `hub`). Endpoints 404 `'embedded session unavailable'` when absent.
- `GET /__the-forge/session/events?since=<seq>` — **secret-gated despite being a GET** (events carry file paths/commands; document the deliberate asymmetry with `/status` beside MUTATING_PATHS). Chunked NDJSON: replay `eventsSince(since)` + `approvals.pending()` (as `approval-request` rows), then live `subscribe`; unsubscribe + end on `close`. Content-Type `application/x-ndjson`.
- `POST /__the-forge/session/interrupt` → `manager.interrupt()`, 200 `{state}`. Add to MUTATING_PATHS.
- `POST /__the-forge/approval` (the bin) → `approvals.request(...)`, respond with the decision JSON when it settles (long-poll; `res.on('close')` → decide-deny is NOT wired — expiry handles abandonment, same trust model as /wait's cancel). Add to MUTATING_PATHS.
- `POST /__the-forge/approval/decide` (the browser) `{id, allow}` → `approvals.decide()`, 200 `{ok}`. Add to MUTATING_PATHS.
- `GET /__the-forge/status` response gains `session: manager.state() | 'unavailable'` — the watch poller picks it up for free.

- [x] **Step 1: failing tests** (existing endpoint-test harness with fake req/res): secret enforcement on all four new paths (including the GET), events replay + live push + close-unsubscribes, approval long-poll resolves on decide, decide on unknown id → `{ok:false}`, status carries session state, absent-session 404s.
- [x] **Step 2: verify failure.**
- [x] **Step 3: implement.**
- [x] **Step 4–5: verify + root gate.**
- [x] **Step 6: commit** — `feat(server): session endpoints (events stream, interrupt, approval round-trip)`

---

### Task 5 — dispatch: the `'embedded'` rung + framework wiring

**Files:**
- Modify: `packages/the-forge/src/server/dispatch.ts` (Rung type only), `packages/the-forge/src/server/endpoints.ts` (dispatch handler), `packages/the-forge/src/vite.ts`, `packages/the-forge/src/next/sidecar.ts`
- Test: `tests/server/endpoints.test.ts` (extend), framework wiring pinned by existing vite/sidecar suites

**Contract** (spec §3.4 — embedded is the primary path):

```
in /dispatch, BEFORE the watcher short-circuit:
  if session wired AND resolvedAgent === 'claude-code':
    if manager.state() is ready|busy|starting:
      manager.notifyDesignEdits()
      return { rung: 'embedded', detail: 'delivered to the embedded session' }
    if manager.state() is idle|failed AND NOT watcherHub.isLive():
      manager.notifyDesignEdits()          // auto-start (primary-path semantics)
      return { rung: 'embedded', detail: 'starting embedded session' }
  … existing watcher short-circuit + ladder unchanged …
```

- A live **external** watcher wins over *auto-starting* (the user deliberately linked that terminal session) but never over an already-running embedded session.
- `resolvedAgent !== 'claude-code'` (cursor/codex — no adapter yet) skips the rung entirely.
- Spawn failure is asynchronous (inside the manager) — dispatch already answered `'embedded'`; the failure surfaces as `session-error`/`failed` in the feed and the NEXT Send falls through to the ladder (state `failed` + `watcherHub.isLive()` false → still auto-start-retries; state `failed` + live watcher → watcher rung). Test both.
- `Rung` union gains `'embedded'` with a doc comment mirroring `'watcher'`'s (produced by the endpoint short-circuit, never by the ladder).
- vite.ts / sidecar.ts: pass `{manager, approvals}` from the runtime into `createForgeMiddleware`; wire `manager.stop()` into the existing close hooks (beside `removeEndpointFile`).

- [x] **Step 1: failing tests** — dispatch handler with fake manager: `ready → embedded + notify`, `idle + no watcher → embedded (starting)`, `idle + live watcher → watcher rung, no auto-start`, `busy embedded beats live watcher`, `agent codex skips to ladder`, `failed + no watcher → auto-start retry`.
- [x] **Step 2: verify failure.**
- [x] **Step 3: implement + wire both frameworks.**
- [x] **Step 4–5: verify + root gate.**
- [x] **Step 6: commit** — `feat(server): 'embedded' dispatch rung with auto-start; framework wiring`

---

### Task 6 — client copy + state: rung, indicator, queued lines

**Files:**
- Modify: `packages/the-forge/src/client/watch.ts`
- Test: `packages/the-forge/tests/client/watch.test.ts` (extend)

**Contract:** `Rung` gains `'embedded'`; `sentLabelFor('embedded', …)` → `'Sent — applying in the embedded session'` (allowlisted explicitly — the unrecognized-value default stays manual). `WatchStatus` also parses the new `session` field from `/status` (same untyped-JSON guards) and exposes `sessionState()`; `watchIndicatorFor` gains the embedded state (session ready/busy/starting): `'● Embedded session active'`, live, unlinkable:false (Stop lives in the feed, not the strip). `queuedLineFor` with an active session → `'N queued — applying in the embedded session…'`. Precedence: active embedded session > watcher states (mirrors the dispatch rung order).

- [x] Steps: failing tests (copy matrix + precedence + poll parsing with unknown values degrading) → implement → verify → root gate → commit `feat(client): embedded-session copy + status plumbing`.

---

### Task 7 — client SessionFeed: stream consumer + feed UI + approvals + Stop

**Files:**
- Create: `packages/the-forge/src/client/session-feed.ts`
- Modify: `packages/the-forge/src/client/overlay.ts` (CSS + mount slot beside the Changes list)
- Create: `packages/the-forge/stories/session-feed.stories.ts`
- Test: `packages/the-forge/tests/client/session-feed.test.ts`, `tests/client/overlay.test.ts` (CSS hooks)

**Interfaces produced:**

```ts
export class SessionFeed {
  root: HTMLElement                        // .session-feed
  start(): void                            // opens the stream (design mode on)
  stop(): void                             // aborts fetch, clears timers — idle-zero
  onInterrupt: () => void                  // host wires to POST /session/interrupt
  onDecide: (id: string, allow: boolean) => void  // host wires to POST /approval/decide
}
```

- Stream: `fetch('/__the-forge/session/events?since=<lastSeq>', { headers: forgeSecretHeaders(), signal })` + ReadableStream NDJSON parse — **not EventSource** (can't send the secret header). Reconnect with capped backoff while design mode is on; `since` makes reconnects seamless. All timers/fetches die in `stop()`.
- Rendering: status row (state/model/limit-error text from `turn-complete isError` and `session-error`), per-event rows — `assistant-text` (snippet), `tool-started` spinner → `tool-finished` check by toolId, recovery rows; `approval-request` renders `.session-approval` with tool name + detail and Allow/Deny buttons (via `createButton`); Stop button (`.session-stop`) visible while busy.
- Feed lives in the docked panel as a section beside the Changes list (extend `changesSlot`-style mounting; do NOT touch ChangeList internals).

- [x] **Step 1: failing tests** — jsdom with a scripted async-iterable fetch stub: `renders rows from replayed + live events`, `pairs tool start/finish`, `approval row buttons fire onDecide with id`, `decided approval row collapses to a resolution line`, `stop() aborts and kills reconnect timers (idle-zero, spy pattern from prompt.test.ts)`, `reconnects with since=<lastSeq>`, `in-band error renders a limit row, not a crash`. Overlay: CSS hooks present.
- [x] **Step 2: verify failure.**
- [x] **Step 3: implement + story** (feed with canned event script: working / approval-pending / limit-hit states).
- [x] **Step 4–5: verify (incl. Storybook spot-check) + root gate.**
- [x] **Step 6: commit** — `feat(client): SessionFeed — activity stream, approvals UI, Stop`

---

### Task 8 — DesignMode wiring + docs

**Files:**
- Modify: `packages/the-forge/src/client/index.ts`, `CLAUDE.md`, `AGENTS.md`
- Test: `packages/the-forge/tests/client/design-mode.test.ts` (extend)

- [x] **Step 1: failing tests** — `feed starts on setActive(true) and stops on setActive(false)`, `Stop button POSTs /session/interrupt with secret`, `approval decide POSTs /approval/decide {id, allow}`, `send flash shows the embedded copy when /dispatch answers rung 'embedded'`.
- [x] **Step 2: verify failure.**
- [x] **Step 3: implement** — construct `SessionFeed`, mount via overlay, wire `onInterrupt`/`onDecide` to secret-header fetches, start/stop beside `this.watch.start()/stop()` in `setActive`.
- [x] **Step 4: docs** — CLAUDE.md + AGENTS.md (keep byte-identical): architecture-loop step for the embedded path, `src/server/session/` + `session-feed.ts` module-table rows, MCP contract now **four** tools (approve + its endpoint), new endpoints in the auth list, gotcha: "in-band CLI errors (rate limit/auth) arrive as result events with exit 0 — read the event, not the exit code".
- [x] **Step 5–6: verify + root gate.**
- [x] **Step 7: commit** — `feat(client): wire SessionFeed through DesignMode; docs`

---

### Task 9 — E2E + gates

**Files:** none (verification only; fix-forward commits).

- [x] **Step 1: build + fresh server** — `npm run build`; kill stale dev servers (`lsof -iTCP:5173`, often `[::1]`); `npm run dev -w demo-app`. (Restart mandatory — Vite caches the old client bundle.)
- [x] **Step 2: feed E2E without the live CLI** (works pre-Jul-12): a tiny fake-`claude` script (echoes scripted NDJSON, reads stdin) pointed at via the manager's injectable adapter factory in a dev-only knob — validates spawn plumbing, stream, feed rendering, Stop, approval round-trip (fake emits a Bash tool_use; MCP `approve` path exercised via the real bin against the dev server).
- [ ] **Step 3: live-CLI E2E (after Jul 12 limit reset):** toggle design mode → edit padding → Send with NO terminal session anywhere → feed shows "starting…" → agent pulls, edits, marks → verifier flips row to Implemented; approval prompt appears for a Bash-requiring prompt request and Allow/Deny both behave; kill the child mid-turn → recovery row + successful resume; dev-server restart resumes the same `session_id`; Next fixture smoke (`npm run dev -w next-demo`) — sidecar path identical.
- [x] **Step 4: prod gate** — `./scripts/check-prod-clean.sh` (session module must leave zero trace in prod output).
- [x] **Step 5: final root gate** — `npm test` → green. Hand the branch to the user for the merge decision.

---

## Self-review notes

- Spec §3.1–3.6 map to Tasks 2/1/3/5/7/4 respectively; §4-A scope only (no chat input anywhere).
- The one turn text is a constant; request content reaches the agent only via `pull_design_edits` — token-cost and no-interpolation rules hold.
- Idle-zero audited per task: manager (nothing until notify), feed (stream only while active), approvals (registry empty until the CLI asks).
- The live-CLI E2E is calendar-blocked (limit reset Jul 12) — Task 9 Step 2 exists so the milestone isn't blind until then.
