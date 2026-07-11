# Codex adapter + harness generalization — milestone C1 (2026-07-11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: [docs/specs/2026-07-11-codex-adapter-design.md](../specs/2026-07-11-codex-adapter-design.md). Prior research: [docs/research/2026-07-09-embedded-sessions.md](../research/2026-07-09-embedded-sessions.md).

**Goal:** The embedded-session engine gains a second harness — `codex app-server` — behind the existing `SessionAdapter` seam, plus everything harness-plural the Cursor adapter (C2) will ride: per-harness vocab in `chat-constants.ts`, per-harness `session.json` slots, an adapter factory keyed by a persisted harness selection, and a harness picker in the composer.

**Architecture:** One new adapter file (`src/server/session/codex.ts`, hand-rolled JSON-RPC over stdio — same zero-dependency posture as `src/mcp/protocol.ts`); `SessionManager` owns harness selection and persists it in `session.json`; approvals arrive as server→client JSON-RPC requests bridged to the existing `ApprovalRegistry` in `runtime.ts` (the `approve` MCP tool stays Claude-only); the overlay composer gains a `.session-harness` select that re-seeds the effort/permission pickers from the vocab tables.

**Tech stack:** TypeScript, node:child_process (server), vanilla DOM in the shadow overlay, vitest + jsdom. Zero new dependencies.

## Global constraints (from spec + CLAUDE.md)

- Zero new runtime dependencies; zero production footprint; zero idle overhead (nothing spawns until Send/say; picker changes alone spawn nothing).
- Official CLI binaries only (`codex`, `claude`); subscription auth (`codex login` state); never `CODEX_API_KEY`, never the Agent SDK.
- Codex MCP wiring via spawn-time `-c mcp_servers` overrides ONLY — no writes to `~/.codex/` or project `.codex/` (ratified decision 3).
- Turn text stays constant/user-typed — request content never travels through turn text; the agent pulls via MCP (unchanged).
- Permission posture (ratified): project file edits auto-apply, commands prompt in the overlay; unanswered approvals time out to deny.
- `src/shared/chat-constants.ts` stays pure data with NO imports, forever.
- New buttons/selects through `src/client/ui/` factories; CSS class names are test hooks — extend, don't rename; stories for new atoms.
- `unknown` + manual checks at I/O boundaries; injectable spawn/clock everywhere — tests never spawn a real `codex` or wait real time.
- Tests mirror `src/`; root `npm test` is the gate after every task; single-file runs from `packages/the-forge/`.
- Why-comments are load-bearing — preserve verbatim when moving code.

**Sequencing:** Task 1 (spike) is the protocol ground truth — Tasks 3–4 consume its fixtures; where a recorded shape contradicts a value written in this plan, **the fixture wins** (update the constant, note it in the fixture header). Tasks 2→7 each end `npm test`-green with their own commit; Task 8 is the E2E gate.

---

### Task 1 — live spike: `codex app-server` driven by hand; recorded fixtures

**Files:**
- Create: `packages/the-forge/tests/server/session/fixtures/codex-appserver-jsonrpc.ts` (string constants of REAL recorded lines + a findings header)
- Scratch (not committed): a throwaway driver script in the session scratchpad, plus a scratch git repo with a `dist/mcp.js`-reachable dev server for the MCP round-trip

**Precondition:** `codex` on PATH and logged in (`codex login` state present). If the binary or login is missing, STOP and report — the whole milestone is blocked on this, per the spec's spike-first convention.

**What to drive and record** (each answer lands as a fixture constant + one line in the findings header):

1. Handshake: send `{"method":"initialize","id":0,"params":{"clientInfo":{"name":"the-forge","title":"The Forge","version":"0.0.0"},"capabilities":{}}}` then `{"method":"initialized","params":{}}`. Record the initialize response.
2. `thread/start` (params `{cwd: <project root>}`) — record the response; note whether it carries a `model`, and the exact thread-id field name.
3. `turn/start` with `input:[{type:'text',text:'Reply with the single word ping.'}]` — record `turn/started`, at least one `item/agentMessage/delta`, the completed `agentMessage` item, and `turn/completed` (note the `usage` shape).
4. **MCP override proof:** spawn with `-c mcp_servers.the-forge.command=node -c 'mcp_servers.the-forge.args=["<abs dist/mcp.js>"]'` in a scratch project whose dev server is running; send a turn asking the agent to call `pull_design_edits`. Record the `mcpToolCall` item lifecycle. This proves ratified decision 3 works at all — if `-c` does not reach app-server threads, STOP and surface to the user (fallback options change the design).
5. **Approval round-trip:** start a turn with `approvalPolicy` set to the prompting value and ask the agent to run `touch /tmp/forge-spike-probe` (outside the workspace). Record the exact `item/commandExecution/requestApproval` request (field names, id placement) and answer `"decline"`; record the declined `item/completed`. Pin the ACCEPTED enum spelling for the policy param (docs disagree: `"unlessTrusted"` vs `"untrusted"`) and for the response values.
6. **File-edit-no-prompt proof:** with the same policy + workspace-write permissions, ask for a one-line edit to a scratch file — confirm NO `fileChange` approval request fires (the ratified posture), and record the `fileChange` item shape (its `changes` array is what feeds the overlay's edit payload).
7. `turn/interrupt` mid-turn — record the interrupted `turn/completed` (note `status`).
8. `thread/resume` with the real thread id (works) and with a fabricated id (record the failure shape — JSON-RPC error vs `turn/failed`; this drives the stale-resume mapping).
9. Effort + model: `turn/start` with `model` + `effort` params — record acceptance; note rejected-value error shape.
10. Boot behavior: note whether ANY line arrives on stdout before the initialize response (watchdog/liveness interplay), and roughly how long handshake→thread-ready takes.

**Fixture file shape** (mirrors `claude-chat-ndjson.ts`): exported `const` strings, one per recorded line, named by scenario (`INIT_RESPONSE`, `THREAD_START_RESPONSE`, `TURN_STARTED`, `AGENT_DELTA`, `AGENT_MESSAGE_COMPLETED`, `TURN_COMPLETED`, `MCP_TOOL_CALL_STARTED/_COMPLETED`, `CMD_APPROVAL_REQUEST`, `CMD_ITEM_DECLINED`, `FILE_CHANGE_COMPLETED`, `TURN_COMPLETED_INTERRUPTED`, `RESUME_STALE_ERROR`, `TURN_FAILED` if observed). Header comment: CLI version (`codex --version`), date, the pinned enum spellings, and answers to 4/6/8/10.

- [ ] **Step 1:** verify `codex --version` + login state; write the throwaway driver (spawn via `node`, line-buffered stdout logging, stdin writer).
- [ ] **Step 2:** run scenarios 1–10, capturing raw lines.
- [ ] **Step 3:** distill into the fixture file with the findings header.
- [ ] **Step 4:** root gate (`npm test` — fixtures compile, nothing else changed).
- [ ] **Step 5:** commit — `test(server): recorded codex app-server fixtures from live spike (CLI <version>)`

---

### Task 2 — per-harness vocab + per-harness session.json + manager harness selection

**Files:**
- Modify: `packages/the-forge/src/shared/chat-constants.ts`
- Modify: `packages/the-forge/src/server/session/manager.ts`
- Modify: `packages/the-forge/src/server/session/adapter.ts` (config-changed event gains `harness?`)
- Test: `packages/the-forge/tests/server/session/manager.test.ts` (extend), `tests/shared/chat-constants.test.ts` (extend or create)

**Interfaces produced:**

```ts
// chat-constants.ts — REPLACES the flat EFFORT_LEVELS/PERMISSION_MODES exports.
// (Their only consumers are endpoints.ts and session-feed.ts, both rewritten in Tasks 4/5;
// migrate any test imports in this task.) Pure data, no imports — unchanged rule.
export type HarnessId = 'claude-code' | 'codex'
export const EMBEDDED_HARNESSES = ['claude-code', 'codex'] as const
export interface HarnessVocab {
  efforts: readonly string[]           // [] would mean unsupported → picker hidden (C2/Cursor)
  liveEffort: boolean                  // true: effort applies to the live session, no respawn
  permissionModes: readonly string[]   // OUR mode ids; adapters own the wire spelling
}
export const HARNESS_VOCAB: Record<HarnessId, HarnessVocab> = {
  'claude-code': {
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],          // spike-pinned 2026-07-09, verbatim
    liveEffort: false,                                            // spawn-flag-only (no set_effort)
    permissionModes: ['default', 'acceptEdits', 'plan'],          // bypassPermissions deliberately absent
  },
  codex: {
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],       // Task 1 fixture-pinned
    liveEffort: true,                                             // per-turn param on turn/start
    permissionModes: ['untrusted', 'on-request'],                 // our ids; danger tiers deliberately absent
  },
}
export const CHAT_TEXT_MAX = 4000                                 // unchanged

// manager.ts additions
export interface SessionManagerOpts {
  makeAdapter: (opts: { harness: HarnessId; effort?: string }) => SessionAdapter  // harness now REQUIRED
  defaultHarness?: HarnessId            // from the plugin `agent` option; 'claude-code' when absent
  // …existing fields unchanged
}
export class SessionManager {
  harness(): HarnessId                  // current selection (persisted > defaultHarness)
  setConfig(cfg: { model?; permissionMode?; effort?; harness?: HarnessId }): SetConfigResult
  // …existing API unchanged
}
```

**session.json new shape** (read/write helpers in manager.ts):

```json
{ "selected": "codex", "sessions": { "claude-code": { "sessionId": "…", "updatedAt": "…" }, "codex": { "sessionId": "thr_…", "updatedAt": "…" } } }
```

Legacy `{sessionId, updatedAt}` files are read as the `claude-code` slot with no `selected` (one-release read-compat; first write migrates the shape). Corrupt/missing → fresh, never throw — unchanged posture. `clearSessionFile` becomes per-slot (stale-resume retry must not wipe the OTHER harness's resume id). Same 0700/0600 perms.

**Behavior contract:**

- `harness()` resolves once at construction: `session.json.selected` if valid, else `opts.defaultHarness`, else `'claude-code'`. Unknown persisted values (future harness read by an old build) fall back to the default — never throw.
- `setConfig({harness})`: busy → `{ok:false, reason:'busy'}` (mirrors effort — a switch must not kill a live turn). Otherwise: stop + discard the live adapter (state → idle), record + persist `selected`, push `config-changed {harness}`. The next Send/say auto-starts the new harness through the unchanged send-at-spawn path, resuming from ITS OWN slot.
- `setConfig({effort})` becomes capability-aware via `HARNESS_VOCAB[this.harness()].liveEffort`: live-effort harnesses get `_spawnEffort = effort` + `this._adapter?.setEffort(effort)` with NO stop and NO busy rejection (safe mid-turn — applies on the next turn); the existing stop-and-respawn branch runs only for `liveEffort: false`. The `_spawnEffort` record is kept in BOTH branches so respawns re-apply it.
- Every `_start()`/`_respawn()` passes `{harness: this.harness(), effort: this._spawnEffort}` to `makeAdapter` and reads/writes the per-harness slot for `resumeId`/`started` persistence.
- `stop()` (dev-server close) does NOT clear the persisted selection — a restart keeps the user's harness, same as it keeps resume ids.

- [ ] **Step 1: failing tests** — sketch:
  - `harness() defaults to claude-code; respects defaultHarness; respects persisted selected`
  - `unknown persisted selected falls back to defaultHarness`
  - `setConfig({harness}) while busy → {ok:false,'busy'}; while ready → stops adapter, persists selected, pushes config-changed {harness}`
  - `after a harness switch the next say() spawns via makeAdapter with the new harness and that harness's own resumeId`
  - `started under codex writes the codex slot without touching the claude-code slot`
  - `stale-resume retry clears only the current harness's slot`
  - `legacy single-id session.json reads as the claude-code slot`
  - `setConfig({effort}) on a liveEffort harness: no stop, allowed while busy, adapter.setEffort called, respawn still passes effort`
  - `setConfig({effort}) on claude-code keeps the existing stop/reject-while-busy behavior` (existing tests keep passing)
  - chat-constants: `HARNESS_VOCAB claude-code arrays are verbatim the previous EFFORT_LEVELS/PERMISSION_MODES values` (regression pin), `chat-constants has zero imports` (extend the existing boundary test if one covers this; create if not)
- [ ] **Step 2:** run → FAIL. — `npx vitest run tests/server/session/manager.test.ts`
- [ ] **Step 3:** implement (constants first, then manager). Migrate any `EFFORT_LEVELS`/`PERMISSION_MODES` imports in tests to the vocab table. Preserve every existing why-comment being moved (session-file helpers, effort respawn rationale — the ClaudeAdapter-specific parts now note they're the `liveEffort: false` path).
- [ ] **Step 4–5:** task tests PASS + root gate (`npm test`) — endpoints.ts/session-feed.ts still import the old names, so this task ALSO adds temporary re-export aliases `EFFORT_LEVELS = HARNESS_VOCAB['claude-code'].efforts` / `PERMISSION_MODES = …permissionModes` (deleted in Tasks 4/5 when the consumers move to vocab lookups).
- [ ] **Step 6:** commit — `feat(server): per-harness vocab tables, session.json slots, manager harness selection`

---

### Task 3 — `CodexAdapter`

**Files:**
- Create: `packages/the-forge/src/server/session/codex.ts`
- Test: `packages/the-forge/tests/server/session/codex.test.ts` (drives the Task 1 fixtures through a fake `SpawnFn`)

**Interfaces produced:**

```ts
// codex.ts — reuses SpawnedChild/SpawnFn from './claude' (same fake-spawn test seam)
export const CODEX_ARGS: string[]   // ['app-server', '-c', 'mcp_servers.the-forge.command=node', '-c', <args override>]
                                    // the mcp.js path segment is built at spawn time from mcpBinPath (below)
export class CodexAdapter implements SessionAdapter {
  constructor(spawnFn?: SpawnFn, opts?: { effort?: string; mcpBinPath?: string })
  /** Server→client approval requests bridged here; runtime.ts wires it to ApprovalRegistry.
   * Unset (default) → auto-decline: fail closed, never hang the child. */
  onApproval: (toolName: string, detail: string) => Promise<{ behavior: 'allow' } | { behavior: 'deny' }>
}
```

**Spawn contract** (Task-1-verified): `codex app-server -c mcp_servers.the-forge.command=node -c mcp_servers.the-forge.args=["<mcpBinPath>"]` (the args value is JSON-in-TOML — build it with `JSON.stringify([mcpBinPath])`; `-c` splits on the FIRST `=` only, so the value may contain `=`). `mcpBinPath` defaults to `path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp.js')` — codex.ts is bundled into `dist/vite.js`/`dist/next.js` beside `dist/mcp.js`, the same derivation vite.ts/sidecar.ts already use; injectable for tests. No `--model` flag (user's default; model rides `turn/start`).

**Protocol engine** (hand-rolled, ~the size of the NDJSON splitter in claude.ts):
- Line-buffered stdout → `JSON.parse` per line; unparseable/unknown → `activity` (forward-compat, same default arm as ClaudeAdapter).
- Outgoing requests carry incrementing integer ids; a `pending` map matches responses.
- Boot sequence on `start()`: write `initialize` → on its response write `initialized` → write `thread/resume {threadId: resumeId}` when `opts.resumeId` given, else `thread/start {cwd}` → on the thread response emit `started {sessionId: <thread id>, model: <from response or ''>, mcpLoaded: true}` (mcpLoaded is deterministic — the `-c` override is structural; Task 1 finding 4 is the proof) and flush the turn queue.
- **Turn queue replaces Claude's lazy-boot stdin buffering:** `sendTurn()` before thread-ready pushes onto an internal FIFO; flushed in order on thread-ready. After ready, `sendTurn` writes `turn/start {threadId, input:[{type:'text',text}], …liveConfig}` where `liveConfig` = the stored model/effort/permission params (only fields that were set). Record the turn id from the `turn/start` response for interrupt.
- **Event mapping** (fixture-pinned; exact field names from Task 1):
  - `item/agentMessage/delta` → `assistant-delta`
  - `item/completed` agentMessage → `assistant-text`
  - `item/started` commandExecution / mcpToolCall / fileChange → `tool-started {toolId: <item id>, name: <'Bash'-equivalent kept as the codex type string, e.g. 'commandExecution'>, detail: command ?? first changed path ?? `${server}.${tool}`, sliced to 120}`; fileChange items with usable before/after content (per the Task 1 shape) build the `edit` payload through the same `EDIT_PAYLOAD_CAP` truncation rule as claude.ts (import `EDIT_PAYLOAD_CAP`; extract-don't-duplicate `truncateEditSide` if reused)
  - `item/completed` (those types) → `tool-finished {toolId}`
  - `turn/completed` → `turn-complete {isError: status === 'failed'}` (`interrupted` is NOT an error — mirrors Claude's interrupt behavior); `turn/failed` → `turn-complete {isError: true, errorText: error.message}`
  - reasoning items, `turn/diff/updated`, `thread/status/changed`, every other notification → `activity`
  - child `exit` → `ended` once; child `error` → `session-error` (with trailing stderr, same 500-char ring as claude.ts) then `ended`
  - a JSON-RPC **error response** to `thread/resume` → emit `turn-complete {isError: true, errorText}` *before* `started` ever fires — this is exactly the shape the manager's stale-resume branch keys on (`!sawStarted && resumeId !== undefined` → clear slot, retry fresh once). Fixture `RESUME_STALE_ERROR` pins it.
- **Approvals:** an incoming server→client REQUEST (`item/commandExecution/requestApproval` / `item/fileChange/requestApproval`) calls `this.onApproval(<'commandExecution'|'fileChange'>, <command ?? reason ?? path, sliced to 120>)` and answers the JSON-RPC id with the Task-1-pinned accept/decline value when the promise resolves. Never `acceptForSession` (every gated call goes through the overlay — ratified posture). Unset handler → immediate decline (fail closed).
- **Config:** `setModel`/`setEffort` store fields for the next `turn/start`. `setPermissionMode` maps OUR mode ids → the Task-1-pinned wire values (`untrusted` → <pinned spelling>, `on-request` → <pinned spelling>) stored likewise; unknown ids ignored (endpoint validates upstream). `interrupt()` → `turn/interrupt {threadId, turnId}` (no-op when no live turn). `stop()` → closed-guard + SIGTERM, same as claude.ts.

- [ ] **Step 1: failing tests** — fake SpawnFn + fixture lines; sketch:
  - `spawns codex app-server with the -c MCP overrides (JSON args value) and cwd`
  - `boot: initialize → initialized → thread/start; started {sessionId, mcpLoaded:true} on thread response`
  - `resumeId → thread/resume; stale-resume error → turn-complete isError before any started`
  - `sendTurn before thread-ready queues; flushes in order on ready; after ready writes turn/start with stored model/effort/permission params`
  - `delta → assistant-delta; completed agentMessage → assistant-text`
  - `commandExecution item lifecycle → tool-started(command detail)/tool-finished by item id`
  - `fileChange completed → tool-started with capped edit payload`
  - `mcpToolCall → tool-started with server.tool detail`
  - `requestApproval → onApproval(name, detail); allow answers accept; deny answers decline; unset handler auto-declines` (assert the exact response line incl. matching JSON-RPC id)
  - `turn/completed interrupted → turn-complete {isError:false}; turn/failed → {isError:true, errorText}`
  - `interrupt writes turn/interrupt with the live turn id; no-op when idle`
  - `NDJSON split across chunk boundaries; unknown notifications → no rendered event (activity only)`
  - `child exit → ended once; spawn error → session-error then ended`
- [ ] **Step 2:** run → FAIL. — `npx vitest run tests/server/session/codex.test.ts`
- [ ] **Step 3:** implement per the contract; where a fixture contradicts a plan constant, fixture wins + note in its header.
- [ ] **Step 4–5:** task tests PASS + root gate.
- [ ] **Step 6:** commit — `feat(server): CodexAdapter — app-server JSON-RPC, native approvals, live config`

---

### Task 4 — runtime factory, approval bridge, endpoints (config.harness, dispatch gate, status)

**Files:**
- Modify: `packages/the-forge/src/server/runtime.ts`, `packages/the-forge/src/server/endpoints.ts`, `packages/the-forge/src/vite.ts`, `packages/the-forge/src/next/sidecar.ts`
- Test: `tests/server/runtime.test.ts`, `tests/server/endpoints.test.ts` (extend both)

**Contract:**

- `createForgeRuntime(resolvedRoot, viteRoot?, opts?: { defaultAgent?: 'claude-code' | 'cursor' | 'codex' })` — vite.ts passes its resolved `agent`, sidecar.ts passes its equivalent if `withForge` has one (omit otherwise). `defaultHarness` for the manager = `defaultAgent` when it's in `EMBEDDED_HARNESSES`, else `'claude-code'` (a cursor-configured project still chats via Claude, today's behavior).
- The factory becomes harness-keyed, and the Codex branch bridges approvals to the registry (composition root — same placement rationale as the existing watchdog wiring why-comment, which must be preserved):

```ts
makeAdapter: (opts) => {
  if (opts.harness === 'codex') {
    const a = new CodexAdapter(undefined, { effort: opts.effort })
    // Native in-protocol approvals: same registry, same overlay UI, same timeout-to-deny —
    // the approve MCP tool + --permission-prompt-tool remain Claude-only. Registry decisions
    // are {behavior:'allow'|'deny'} — exactly the shape the adapter answers with.
    a.onApproval = (toolName, detail) => approvals.request(toolName, detail).promise
    return a
  }
  return new ClaudeAdapter(undefined, { effort: opts.effort })
},
```

- `/__the-forge/session/config` accepts optional `harness`: must be a member of `EMBEDDED_HARNESSES` (400 otherwise, error text `harness must be one of claude-code, codex`). Validation of `effort`/`permissionMode` moves from the flat sets to `HARNESS_VOCAB[targetHarness]` where `targetHarness = harness ?? session.manager.harness()` — a combined `{harness:'codex', effort:'minimal'}` POST validates against the NEW harness. Error texts derive from the vocab arrays (`.join(', ')`). 409-on-busy behavior unchanged (now also produced by harness switches). Delete the Task-2 temporary aliases from chat-constants once nothing imports them.
- Dispatch embedded rung ([endpoints.ts:435](../../packages/the-forge/src/server/endpoints.ts)): `resolvedAgent === 'claude-code'` → `EMBEDDED_AGENT_SET.has(resolvedAgent)` (a `Set(EMBEDDED_HARNESSES)`); update the adjacent why-comment (cursor still skips — C2). Delivery goes to whatever harness the manager has selected; the rung answer copy is unchanged.
- `GET /__the-forge/status` response gains `harness: session ? session.manager.harness() : undefined` beside the existing `session` state field — the picker's reload seed.

- [ ] **Step 1: failing tests** — sketch:
  - runtime: `makeAdapter codex → CodexAdapter with onApproval wired to the registry (request → decide allow resolves the adapter's promise)`, `defaultAgent codex → manager.harness() codex`, `defaultAgent cursor → claude-code`
  - endpoints: `config {harness:'codex'} → manager.setConfig receives it; 200`, `config {harness:'cursor'} → 400`, `config {harness:'codex', effort:'minimal'} → 200 (validated against codex vocab)`, `config {effort:'minimal'} with claude selected → 400`, `config {permissionMode:'untrusted'} with codex selected → 200; with claude → 400`, `busy harness switch → 409`, `dispatch with resolvedAgent codex → embedded rung (notify called)`, `dispatch cursor still skips to ladder`, `status carries harness`
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement + wire both frameworks (vite.ts/sidecar.ts pass `defaultAgent`; close hooks unchanged).
- [ ] **Step 4–5:** task tests PASS + root gate.
- [ ] **Step 6:** commit — `feat(server): harness-keyed adapter factory, codex approval bridge, config/dispatch/status plumbing`

---

### Task 5 — client: harness picker + vocab-driven pickers + status seed

**Files:**
- Modify: `packages/the-forge/src/client/session-feed.ts`, `packages/the-forge/src/client/watch.ts`, `packages/the-forge/src/client/index.ts`, `packages/the-forge/src/client/overlay.ts` (CSS for `.session-harness` only if the shared select styling doesn't already cover it)
- Modify: `packages/the-forge/stories/session-feed.stories.ts` (picker states)
- Test: `tests/client/session-feed.test.ts`, `tests/client/watch.test.ts`, `tests/client/design-mode.test.ts` (extend)

**Contract:**

- `session-feed.ts` imports `HARNESS_VOCAB`, `EMBEDDED_HARNESSES`, `HarnessId` (chat-constants) and `AGENT_DISPLAY_NAME` (`./agent`). New `harnessSelect = createSelect({ className: 'session-harness', options: EMBEDDED_HARNESSES.map(h => ({value: h, label: AGENT_DISPLAY_NAME[h]})), value: 'claude-code', onChange: v => this.onConfig({harness: v}) })` — FIRST in `composerControls` (before `modelSelect`; observed insertion point in the `composerControls.append(...)` call). No placeholder option: harness always has a definite value, unlike the session-reported pickers.
- `onConfig` signature widens to `{ model?; permissionMode?; effort?; harness? }` — index.ts's existing POST-the-whole-object wiring forwards it unchanged.
- Effort/permission options become per-harness: `EFFORT_OPTIONS`/`PERMISSION_OPTIONS` constants are replaced by builders `effortOptionsFor(h)` / `permissionOptionsFor(h)` (placeholder first, then the vocab values — same `{value:'',label:'effort…'}` pattern; preserve the existing why-comments about placeholder no-ops). A `setHarness(h: HarnessId)` method sets the select value, rebuilds both dependent selects (values reset to the placeholder — the new session reports its own config), hides the effort select entirely when the vocab's `efforts` is empty (dead code today, live for Cursor/C2), and swaps the model-alias list: `MODEL_ALIASES` becomes per-harness (`claude-code: ['sonnet','opus','haiku']`, `codex: []` — no verified aliases; the select offers only session-reported models).
- Seeding: `config-changed` events carrying `harness` (new optional field on the local `SessionEvent` copy — untyped-JSON guards as usual) call `setHarness`. `watch.ts` parses the new `harness` field off `/status` (same guard style as `sessionState()`), exposes `harness(): string | undefined`; index.ts's existing status-poll callback calls `feed.setHarness(...)` when it reports a valid harness — the reload seed. Precedence: a user click wins over a stale poll (skip the poll-seed while a config POST is in flight — reuse the same in-flight pattern the config handlers already use, or simply skip when the value already matches).
- `config-changed {harness}` feed row renders via the existing config-row path (assert the label shows the display name, not the id).

- [ ] **Step 1: failing tests** — sketch:
  - `harness select renders first in composer controls with Claude Code/Codex options`
  - `changing harness fires onConfig({harness:'codex'})`
  - `setHarness('codex') rebuilds effort options to the codex vocab and resets value to placeholder`
  - `setHarness with empty efforts hides the effort select` (synthetic vocab entry via the builder, or skip if builders take the array — test through a stubbed vocab)
  - `codex hides model aliases (options = current only)`
  - `config-changed {harness} event seeds the picker + renders a config row`
  - watch: `/status harness field parsed; missing/garbage → undefined`
  - design-mode: `status-poll harness seeds the feed picker; user-selected value not clobbered by a matching poll`
- [ ] **Step 2:** run → FAIL. — `npx vitest run tests/client/session-feed.test.ts`
- [ ] **Step 3:** implement + story variant (composer with codex selected — effort list visibly different).
- [ ] **Step 4–5:** task tests PASS (+ Storybook spot-check) + root gate.
- [ ] **Step 6:** commit — `feat(client): harness picker + per-harness effort/permission vocab in the composer`

---

### Task 6 — fake `codex` bin + embedded-feed E2E scenario

**Files:**
- Create: `scripts/fake-bin/codex` (scripted app-server: answers initialize/thread/turn with canned JSON-RPC from the Task 1 fixtures, emits one commandExecution approval request, honors decline)
- Modify: `scripts/e2e-embedded-feed.sh` (a harness-switch scenario: `POST /session/config {harness:'codex'}` → dispatch → assert feed rows show the codex turn + approval round-trip → switch back to claude)
- Test: none beyond the script itself (it's a gate, run in Task 8)

The fake mirrors `scripts/fake-bin/claude`'s conventions (receipt log env var, scripted stdin-driven responses) so the script can assert "the interrupt/decline actually landed in the fake". Keep the fake's canned lines byte-copied from the Task 1 fixtures — the fake is the executable form of the same ground truth.

- [ ] **Step 1:** write the fake bin (read `scripts/fake-bin/claude` first; mirror its logging contract).
- [ ] **Step 2:** extend the E2E script with the codex scenario.
- [ ] **Step 3:** `npm run build && ./scripts/e2e-embedded-feed.sh` → green end-to-end (both scenarios).
- [ ] **Step 4:** root gate.
- [ ] **Step 5:** commit — `test(e2e): fake codex app-server bin + harness-switch feed scenario`

---

### Task 7 — docs

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md` (keep shared sections byte-identical)

(The spec's §3.6 rider correction — `buildPromptRequest` cleanup already shipped in PR #28 — was applied to the spec at planning time; nothing to do here.)

- [ ] **Step 1:** CLAUDE.md/AGENTS.md: `src/server/session` module table gains the `codex.ts` row ("CodexAdapter — app-server JSON-RPC spawn contract, native approval bridge; live per-turn model/effort") and `adapter.ts`/`manager.ts` row updates (harness selection, per-harness session.json); MCP-contract section notes the `approve` tool is Claude-only; architecture-loop sentence mentions the harness picker; `chat-constants` paragraph documents the vocab tables; gotchas gain: (a) "Codex effort/model/permission are per-turn `turn/start` params — no respawn; Claude's effort respawn is the `liveEffort: false` path", (b) the C2 forward-gotcha: "Cursor CLI errors arrive as stderr + non-zero exit, NOT in-band events — the inverse of the Claude gotcha", (c) "session.json is per-harness slots; never feed one harness's resume id to another".
- [ ] **Step 2:** root gate (docs-only, still run it).
- [ ] **Step 3:** commit — `docs: codex adapter + harness vocab module/gotcha updates`

---

### Task 8 — E2E + gates

**Files:** none (verification only; fix-forward commits).

- [ ] **Step 1:** `npm run build`; kill stale dev servers (`lsof -iTCP:5173` — often `[::1]`); fresh `npm run dev -w demo-app`.
- [ ] **Step 2:** fake-bin gate: `./scripts/e2e-embedded-feed.sh` green (claude + codex scenarios).
- [ ] **Step 3:** **live Codex E2E** (needs `codex login`; report and park if quota/login blocks): toggle design mode → pick **Codex** in the composer → edit padding → Send with no terminal session → feed streams the codex turn → agent pulls, edits, `mark_applied` → verifier flips the row to Implemented. Then: a command approval surfaces Allow/Deny in the overlay and both paths behave; ■ interrupts mid-turn; dev-server restart resumes the same thread; switch back to Claude Code and repeat one Send (regression — the claude path must be untouched); Next fixture smoke (`npm run dev -w next-demo`) for one codex Send through the sidecar.
- [ ] **Step 4:** prod gate — `./scripts/check-prod-clean.sh` (zero plugin traces + the 320KB budget; the picker adds client bytes — record the new number).
- [ ] **Step 5:** final root gate — `npm test` green. Hand the branch to the user for the merge decision (per HANDOFF: the merge decision is always the user's).

---

## Self-review notes

- Spec §3.1→Task 3, §3.2→Tasks 3+4, §3.3→Tasks 2+4+5, §3.4→Task 2, §3.5→Task 5, §3.6 rider→Task 7 (corrected: already shipped in PR #28), §6→Tasks 1/6/8. Out-of-scope list honored (no `~/.codex` writes, no reasoning rendering, no turn/steer, no Cursor).
- Fixture-wins rule stated up front — the plan's protocol constants are best-current-knowledge; Task 1 is the authority.
- Idle-zero audited: the picker itself only POSTs config; nothing spawns until Send/say (manager semantics unchanged).
- Token rules hold: turn text untouched; approval decline values are constants; no server data interpolated into agent-visible text.
- chat-constants keeps zero imports (vocab is pure data; adapters own wire-spelling maps).
