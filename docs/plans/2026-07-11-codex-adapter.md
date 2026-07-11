# Cursor adapter + harness generalization — milestone C1 (2026-07-11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **PIVOT (2026-07-11):** this plan was authored Codex-first and revised same-day to **Cursor-first** — the user has no Codex subscription, so the Codex live spike (the protocol ground truth) cannot run; Codex is now C2. Task 2 landed pre-pivot with Codex vocab and is amended by Task 2b. The filename keeps the original slug (committed history references it).

Spec: [docs/specs/2026-07-11-codex-adapter-design.md](../specs/2026-07-11-codex-adapter-design.md) (revised for the pivot). Prior research: [docs/research/2026-07-09-embedded-sessions.md](../research/2026-07-09-embedded-sessions.md).

**Goal:** The embedded-session engine gains a second harness — `cursor-agent acp` — behind the existing `SessionAdapter` seam, plus everything harness-plural the Codex adapter (C2) will ride: per-harness vocab in `chat-constants.ts`, per-harness `session.json` slots, an adapter factory keyed by a persisted harness selection, and a harness picker in the composer.

**Architecture:** One new adapter file (`src/server/session/cursor.ts`, hand-rolled ACP JSON-RPC over stdio — same zero-dependency posture as `src/mcp/protocol.ts`); `SessionManager` owns harness selection persisted in `session.json`; ACP `session/request_permission` requests split by tool-call kind — edit-kind auto-allows (ratified posture, adapter-side), everything else bridges to the existing `ApprovalRegistry` in `runtime.ts` (the `approve` MCP tool stays Claude-only); the overlay composer gains a `.session-harness` select that re-seeds the effort/permission pickers from the vocab tables (both hidden for Cursor — empty vocab).

**Tech stack:** TypeScript, node:child_process (server), vanilla DOM in the shadow overlay, vitest + jsdom. Zero new dependencies.

## Global constraints (from spec + CLAUDE.md)

- Zero new runtime dependencies; zero production footprint; zero idle overhead (nothing spawns until Send/say; picker changes alone spawn nothing).
- Official CLI binaries only (`cursor-agent`, `claude`); subscription auth (`agent login` state); never `CURSOR_API_KEY`, never the Agent SDK.
- Cursor MCP wiring via the `mcpServers` array on ACP `session/new`/`session/load` ONLY — no writes to `.cursor/cli.json` or any other config (the pre-existing `.cursor/mcp.json` write in setup.ts serves terminal-side sessions and is untouched).
- Turn text stays constant/user-typed — request content never travels through turn text; the agent pulls via MCP (unchanged).
- Permission posture (ratified, adapter-side for Cursor): edit-kind permission requests auto-allow; everything else prompts in the overlay; never allow-always; unanswered approvals time out to deny.
- `src/shared/chat-constants.ts` stays pure data with NO imports, forever.
- New buttons/selects through `src/client/ui/` factories; CSS class names are test hooks — extend, don't rename; stories for new atoms.
- `unknown` + manual checks at I/O boundaries; injectable spawn/clock everywhere — tests never spawn a real `cursor-agent` or wait real time.
- Tests mirror `src/`; root `npm test` is the gate after every task; single-file runs from `packages/the-forge/`.
- Why-comments are load-bearing — preserve verbatim when moving code.

**Sequencing:** Task 1 (spike) is the protocol ground truth — Tasks 3–4 consume its fixtures; where a recorded shape contradicts a value written in this plan, **the fixture wins** (update the constant, note it in the fixture header). Tasks 2→7 each end `npm test`-green with their own commit; Task 8 is the E2E gate.

---

### Task 1 — live spike: `cursor-agent acp` driven by hand; recorded fixtures

**Files:**
- Create: `packages/the-forge/tests/server/session/fixtures/cursor-acp-jsonrpc.ts` (string constants of REAL recorded lines + a findings header)
- Scratch (not committed): a throwaway driver script in the session scratchpad, plus a scratch git repo with a running dev server + built `dist/mcp.js` for the MCP round-trip

**Precondition:** `cursor-agent` on PATH and logged in (`cursor-agent status`). If missing, STOP and report — the milestone is blocked on this.

**What to drive and record** (each answer lands as a fixture constant + one line in the findings header):

1. Binary/subcommand ground truth: `cursor-agent --version`; confirm `cursor-agent acp` starts an ACP server on stdio (protocol on stdout, logs on stderr).
2. Handshake: send `initialize` (record the minimal accepted params — protocolVersion/clientCapabilities shape) and record the response, including advertised auth methods and whether already-logged-in shows here.
3. `session/new {cwd, mcpServers: [<the-forge stdio entry: command node, args [abs dist/mcp.js]>]}` — record the exact accepted `mcpServers` entry shape and the response (sessionId field name). **MCP proof:** in the scratch project with a dev server running, prompt the agent to call `pull_design_edits`; record the tool-call updates proving our server loaded. If `mcpServers` on session/new does NOT take effect, STOP and surface — decision 3's mechanism changes.
4. A simple turn: `session/prompt {sessionId, prompt:[{type:'text',text:'Reply with the single word ping.'}]}` — record several `session/update` `agent_message_chunk` notifications and the prompt RESPONSE (stopReason vocabulary begins here).
5. Tool-call lifecycle: prompt a one-line file edit in the scratch repo — record `tool_call` / `tool_call_update` notifications (id + kind + title + status field names, and whatever diff/content shape edit calls carry — this feeds the overlay edit payload), and whether an **edit-kind `session/request_permission` fires at all** under default config (drives §3.2's auto-allow split).
6. Permission round-trip: prompt a shell command (e.g. `touch /tmp/forge-spike-probe`) — record the exact `session/request_permission` request (field names, the options array with ids/kinds) and answer the reject-once option; record how rejection surfaces in the turn. Pin the response envelope (`{outcome:{outcome:'selected',optionId}}` per docs — verify).
7. `session/cancel` mid-turn — record how the in-flight `session/prompt` resolves (stopReason value).
8. `session/load {sessionId}` — record whether history replays as `session/update` notifications before the response resolves (drives replay suppression), and the failure shape for a fabricated sessionId (drives the stale-resume mapping).
9. Model info: does initialize/session/new/any update carry a model name? Record what exists; note if nothing does.
10. Error shapes: kill auth (if cheap — e.g. `CURSOR_CONFIG_DIR` pointed at an empty dir) and record the auth-required error; note stderr-vs-in-band behavior and exit codes on failure. Note any pre-response stdout chatter (watchdog interplay) and handshake→session-ready latency.

**Fixture file shape** (mirrors `claude-chat-ndjson.ts`): exported `const` strings, one per recorded line, named by scenario (`INIT_RESPONSE`, `SESSION_NEW_RESPONSE`, `AGENT_CHUNK`, `PROMPT_RESPONSE_END_TURN`, `TOOL_CALL_STARTED`, `TOOL_CALL_COMPLETED`, `MCP_TOOL_CALL_*`, `PERMISSION_REQUEST_EXECUTE`, `PERMISSION_REQUEST_EDIT` (if observed), `PROMPT_RESPONSE_CANCELLED`, `LOAD_STALE_ERROR`, `AUTH_REQUIRED_ERROR` …). Header comment: CLI version, date, pinned option kinds/stopReasons, and answers to 3/5/8/9/10.

- [ ] **Step 1:** verify `cursor-agent --version` + `cursor-agent status`; write the throwaway driver (spawn, line-buffered stdout logging, stderr to a file, stdin writer).
- [ ] **Step 2:** run scenarios 1–10, capturing raw lines.
- [ ] **Step 3:** distill into the fixture file with the findings header.
- [ ] **Step 4:** root gate (`npm test` — fixtures compile, nothing else changed).
- [ ] **Step 5:** commit — `test(server): recorded cursor-agent ACP fixtures from live spike (CLI <version>)`

---

### Task 2 — per-harness vocab + per-harness session.json + manager harness selection

- [x] **LANDED pre-pivot** (commits `b0e63ac` + `75db5f0`, review pending): `HARNESS_VOCAB`/`EMBEDDED_HARNESSES`/`HarnessId` in chat-constants, per-harness `session.json` slots with legacy read-compat, `SessionManager.harness()`/`setConfig({harness})`/capability-aware effort, `makeAdapter({harness, effort})`, temporary `EFFORT_LEVELS`/`PERMISSION_MODES` aliases for not-yet-migrated consumers. Built with `codex` as the second harness id — amended by Task 2b.

### Task 2b — pivot amendment: `codex` → `cursor` in the vocab layer

**Files:**
- Modify: `packages/the-forge/src/shared/chat-constants.ts`, plus every Task-2 test/reference to the `codex` harness id
- Test: existing Task 2 suites, updated

**Contract:** `HarnessId = 'claude-code' | 'cursor'`; `EMBEDDED_HARNESSES = ['claude-code', 'cursor']`; the second vocab entry becomes:

```ts
cursor: {
  // Cursor has NO effort knob and no verified ACP permission-mode control — empty tables
  // hide both pickers (client) and reject every value (endpoint validation). The ratified
  // permission posture is enforced adapter-side instead (edit-kind auto-allow; see cursor.ts).
  efforts: [],
  liveEffort: true, // moot with an empty list; true = never trigger the Claude respawn dance
  permissionModes: [],
},
```

Manager/session.json code is already harness-id-agnostic (ids flow through); only the type union, the vocab table, and codex-named test cases change. Keep the Task 2 why-comments; update ones that name codex specifically.

- [ ] **Step 1:** update tests (rename codex-id cases to cursor; add `cursor efforts/permissionModes are empty` pin) → run → FAIL where the table still says codex.
- [ ] **Step 2:** apply the constants change; suites PASS; root gate.
- [ ] **Step 3:** commit — `refactor(shared): pivot second harness id codex → cursor (C1 pivot, no Codex sub)`

---

### Task 3 — `CursorAdapter`

**Files:**
- Create: `packages/the-forge/src/server/session/cursor.ts`
- Test: `packages/the-forge/tests/server/session/cursor.test.ts` (drives the Task 1 fixtures through a fake `SpawnFn`)

**Interfaces produced:**

```ts
// cursor.ts — reuses SpawnedChild/SpawnFn from './claude' (same fake-spawn test seam)
export const CURSOR_ARGS: string[]   // ['acp'] — binary 'cursor-agent'
export class CursorAdapter implements SessionAdapter {
  constructor(spawnFn?: SpawnFn, opts?: { effort?: string; mcpBinPath?: string })
  /** Non-edit permission requests bridged here; runtime.ts wires it to ApprovalRegistry.
   * Unset (default) → auto-deny: fail closed, never hang the child. */
  onApproval: (toolName: string, detail: string) => Promise<{ behavior: 'allow' } | { behavior: 'deny' }>
}
```

`mcpBinPath` defaults to `path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp.js')` — cursor.ts is bundled into `dist/vite.js`/`dist/next.js` beside `dist/mcp.js` (same derivation vite.ts/sidecar.ts use); injectable for tests. `opts.effort` is accepted-and-ignored (manager threads it unconditionally; Cursor has no effort — documented no-op).

**Protocol engine** (hand-rolled):
- Line-buffered stdout → `JSON.parse` per line; unparseable/unknown → `activity`. stderr → the same 500-char tail ring as claude.ts, included in spawn-error text.
- Outgoing requests carry incrementing integer ids; a `pending` map matches responses. Server→client requests (permission) are answered by writing a response with THEIR id.
- **Boot on `start()`:** write `initialize` (Task-1-pinned params) → on response write `session/new {cwd, mcpServers: [<fixture-pinned entry — REQUIRES `env: []` (array); `{command,args}` alone is rejected with invalid_union>]}`, or `session/load {sessionId: resumeId, cwd, mcpServers: […]}` when `opts.resumeId` given → on response emit `started {sessionId, model: <from the session/new|load response — fixture-pinned location>, mcpLoaded: true}` and flush the turn queue. An auth-required error at any boot step → `session-error` with the constant text `cursor-agent is not logged in — run: agent login` then the normal pre-started failure path. A `session/load` error → `turn-complete {isError:true, errorText}` before any `started` (the manager's stale-resume branch keys on exactly this).
- **Replay suppression:** between writing `session/load` and its response resolving, `session/update` notifications are swallowed (not ringed — resume must not duplicate history); they still count as `activity`.
- **Turn queue:** `sendTurn()` before session-ready pushes onto an internal FIFO, flushed in order on ready. After ready, `sendTurn` writes `session/prompt {sessionId, prompt:[{type:'text',text}]}`. One turn in flight at a time (the manager guarantees it).
- **Event mapping** (fixture-pinned field names):
  - `agent_message_chunk` → `assistant-delta {text}`, AND accumulated into a segment buffer
  - segment buffer flushes as one `assistant-text` when a `tool_call` arrives or the prompt response resolves (ACP has no separate authoritative final text — the adapter owns segmenting; empty buffer flushes nothing)
  - `tool_call` → `tool-started {toolId, name: <kind string>, detail: <title/path, sliced to 120>, edit? from diff-type content via EDIT_PAYLOAD_CAP truncation (import from './claude'; extract the truncate helper rather than duplicating)}`
  - terminal `tool_call_update` (completed/failed status) → `tool-finished {toolId}`; non-terminal updates → `activity`
  - prompt response → flush segment buffer, then `turn-complete {isError:false}` for end-turn AND cancelled stopReasons (mirrors Claude interrupts); JSON-RPC error response → `turn-complete {isError:true, errorText: error.message}`
  - `cursor/*` extension notifications and everything unrecognized → `activity`
  - child `exit` → `ended` once; child `error` → `session-error` (with stderr tail) then `ended`
- **Permissions (§3.2 posture, adapter-side; spike-corrected):** the live CLI auto-runs built-in read/edit tools with NO permission request — only shell/execute and MCP tool calls prompt (Task 1 finding). The adapter's auto-allow set is therefore: **edit-kind requests** (defensive — none observed live, but the posture demands auto-allow if a future CLI fires them) AND **the-forge's own MCP tools** (`pull_design_edits`/`mark_applied` — mirrors EDIT_TIER_ALLOW's static `mcp__the-forge__*` allows on Claude; without this every pull turn would park an approval). Everything else (shell/execute, other MCP tools) → `this.onApproval(<kind>, <command/title, sliced to 120>)`; allow → allow-once option, deny → reject-once option, unset handler → immediate reject-once (fail closed). Option selection is by the fixture-pinned `kind` field on the options array, NOT hardcoded option ids; never the allow-always option. Answer envelope: `{outcome:{outcome:'selected',optionId}}` (fixture-verified). NOTE (feed nuance, fixture-pinned): a rejected tool call still reports item status `completed` and stopReason `end_turn` — rejection is only visible to the agent in-band, not in the envelope; do not map rejection to `turn-complete {isError:true}`.
- **Config:** `setModel`/`setEffort`/`setPermissionMode` are no-ops with a shared why-comment (no verified ACP control surface; vocab tables hide the pickers — revisit at C2/an ACP version that exposes them). `interrupt()` → `session/cancel {sessionId}` (no-op before session-ready). `stop()` → closed-guard + SIGTERM, same as claude.ts.

- [ ] **Step 1: failing tests** — fake SpawnFn + fixture lines; sketch:
  - `spawns cursor-agent acp with cwd`
  - `boot: initialize → session/new with the mcpServers entry (mcpBinPath in args); started {sessionId, mcpLoaded:true} on response`
  - `resumeId → session/load; replayed updates before the response are not ringed; stale-load error → turn-complete isError before any started`
  - `auth-required error → session-error with the login instruction text`
  - `sendTurn before ready queues; flushes in order; after ready writes session/prompt`
  - `chunks → assistant-delta; segment flushes as assistant-text on tool_call and on prompt response`
  - `tool_call/tool_call_update lifecycle → tool-started/tool-finished by id; edit content → capped edit payload`
  - `execute-kind permission → onApproval; allow answers allow-once option; deny answers reject-once; unset handler auto-rejects` (assert exact response lines incl. matching JSON-RPC id)
  - `edit-kind permission auto-allows without calling onApproval`
  - `prompt response end-turn → turn-complete {isError:false}; cancelled → {isError:false}; error response → {isError:true, errorText}`
  - `interrupt writes session/cancel; no-op before ready`
  - `NDJSON split across chunk boundaries; unknown notifications → no rendered event`
  - `child exit → ended once; spawn error → session-error then ended`
- [ ] **Step 2:** run → FAIL. — `npx vitest run tests/server/session/cursor.test.ts`
- [ ] **Step 3:** implement per the contract; fixture wins over plan constants (note deviations in the fixture header).
- [ ] **Step 4–5:** task tests PASS + root gate.
- [ ] **Step 6:** commit — `feat(server): CursorAdapter — ACP JSON-RPC, kind-split native approvals, replay-safe resume`

---

### Task 4 — runtime factory, approval bridge, endpoints (config.harness, dispatch gate, status)

**Files:**
- Modify: `packages/the-forge/src/server/runtime.ts`, `packages/the-forge/src/server/endpoints.ts`, `packages/the-forge/src/vite.ts`, `packages/the-forge/src/next/sidecar.ts`
- Test: `tests/server/runtime.test.ts`, `tests/server/endpoints.test.ts` (extend both)

**Contract:**

- `createForgeRuntime(resolvedRoot, viteRoot?, opts?: { defaultAgent?: 'claude-code' | 'cursor' | 'codex' })` — vite.ts passes its resolved `agent`; sidecar.ts passes its equivalent if `withForge` exposes one (omit otherwise). Manager `defaultHarness` = `defaultAgent` when it's in `EMBEDDED_HARNESSES`, else `'claude-code'` (a codex-configured project chats via Claude until C2).
- Factory keyed by harness, Cursor branch bridging approvals (composition root — preserve the existing watchdog-wiring why-comment):

```ts
makeAdapter: (opts) => {
  if (opts.harness === 'cursor') {
    const a = new CursorAdapter(undefined, { effort: opts.effort })
    // Non-edit ACP permission requests: same registry, same overlay UI, same timeout-to-deny —
    // the approve MCP tool + --permission-prompt-tool remain Claude-only; edit-kind requests
    // never reach here (adapter-side auto-allow, the ratified posture).
    a.onApproval = (toolName, detail) => approvals.request(toolName, detail).promise
    return a
  }
  return new ClaudeAdapter(undefined, { effort: opts.effort })
},
```

- `/__the-forge/session/config` accepts optional `harness` ∈ `EMBEDDED_HARNESSES` (400 otherwise: `harness must be one of claude-code, cursor`). `effort`/`permissionMode` validate against `HARNESS_VOCAB[harness ?? session.manager.harness()]` — empty tables reject every value; error texts derive from the vocab arrays (`.join(', ')`, with a `not supported for this harness` variant when the table is empty). 409-on-busy unchanged. Delete the Task-2 temporary aliases from chat-constants once nothing imports them.
- Dispatch embedded rung: `resolvedAgent === 'claude-code'` → membership in `new Set(EMBEDDED_HARNESSES)`; update the adjacent why-comment (codex skips — C2; **cursor now takes the embedded rung instead of falling to the deeplink ladder — deliberate, embedded is the primary path**).
- `GET /__the-forge/status` gains `harness: session.manager.harness()` when session is wired — the picker's reload seed.

- [ ] **Step 1: failing tests** — sketch:
  - runtime: `makeAdapter cursor → CursorAdapter with onApproval wired (request → decide allow resolves the adapter's promise)`, `defaultAgent cursor → manager.harness() cursor`, `defaultAgent codex → claude-code`
  - endpoints: `config {harness:'cursor'} → 200, manager receives it`, `config {harness:'codex'} → 400`, `config {effort:'low'} with cursor selected → 400 (empty table)`, `config {permissionMode:'default'} with cursor selected → 400; with claude → 200`, `busy harness switch → 409`, `dispatch with resolvedAgent cursor → embedded rung (notify called)`, `dispatch codex still skips to ladder`, `status carries harness`
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement + wire both frameworks (vite.ts/sidecar.ts pass `defaultAgent`; close hooks unchanged).
- [ ] **Step 4–5:** task tests PASS + root gate.
- [ ] **Step 6:** commit — `feat(server): harness-keyed adapter factory, cursor approval bridge, config/dispatch/status plumbing`

---

### Task 5 — client: harness picker + vocab-driven pickers + status seed

**Files:**
- Modify: `packages/the-forge/src/client/session-feed.ts`, `packages/the-forge/src/client/watch.ts`, `packages/the-forge/src/client/index.ts`, `packages/the-forge/src/client/overlay.ts` (CSS for `.session-harness` only if the shared select styling doesn't already cover it)
- Modify: `packages/the-forge/stories/session-feed.stories.ts` (picker states)
- Test: `tests/client/session-feed.test.ts`, `tests/client/watch.test.ts`, `tests/client/design-mode.test.ts` (extend)

**Contract:**

- `session-feed.ts` imports `HARNESS_VOCAB`, `EMBEDDED_HARNESSES`, `HarnessId` (chat-constants) and `AGENT_DISPLAY_NAME` (`./agent`). New `harnessSelect = createSelect({ className: 'session-harness', options: EMBEDDED_HARNESSES.map(h => ({value: h, label: AGENT_DISPLAY_NAME[h]})), value: 'claude-code', onChange: v => this.onConfig({harness: v}) })` — FIRST in the `composerControls.append(...)` row. No placeholder option: harness always has a definite value.
- `onConfig` widens to `{ model?; permissionMode?; effort?; harness? }` — index.ts's POST-the-whole-object wiring forwards it unchanged.
- `EFFORT_OPTIONS`/`PERMISSION_OPTIONS` constants → builders `effortOptionsFor(h)` / `permissionOptionsFor(h)` over `HARNESS_VOCAB` (placeholder first; preserve the placeholder-no-op why-comments). `setHarness(h: HarnessId)`: sets the select value, rebuilds both dependent selects (values reset to placeholder — the new session reports its own config), hides a select entirely when its vocab array is empty (BOTH are empty for cursor), and swaps the model-alias list — `MODEL_ALIASES` becomes per-harness (`claude-code`: `['sonnet','opus','haiku']`; `cursor`: `[]` — session-reported values only).
- Seeding: `config-changed` events carrying `harness` (optional field on the local `SessionEvent` copy — untyped-JSON guards) call `setHarness`. `watch.ts` parses the new `/status` `harness` field (same guard style as `sessionState()`), exposes `harness(): string | undefined`; index.ts's status-poll callback seeds `feed.setHarness(...)` — skip when the value already matches (a user click must not be clobbered by a stale poll).
- `config-changed {harness}` renders via the existing config-row path (label shows the display name, not the id).

- [ ] **Step 1: failing tests** — sketch:
  - `harness select renders first in composer controls with Claude Code/Cursor options`
  - `changing harness fires onConfig({harness:'cursor'})`
  - `setHarness('cursor') hides the effort AND permission selects (empty vocab); back to claude-code shows them with claude options`
  - `cursor hides model aliases (options = current only)`
  - `config-changed {harness} event seeds the picker + renders a config row with the display name`
  - watch: `/status harness field parsed; missing/garbage → undefined`
  - design-mode: `status-poll harness seeds the feed picker; matching value is not re-applied`
- [ ] **Step 2:** run → FAIL. — `npx vitest run tests/client/session-feed.test.ts`
- [ ] **Step 3:** implement + story variant (composer with cursor selected — effort/permission absent).
- [ ] **Step 4–5:** task tests PASS (+ Storybook spot-check) + root gate.
- [ ] **Step 6:** commit — `feat(client): harness picker + per-harness vocab-driven composer controls`

---

### Task 6 — fake `cursor-agent` bin + embedded-feed E2E scenario

**Files:**
- Create: `scripts/fake-bin/cursor-agent` (scripted ACP: answers initialize/session-new/prompt with canned JSON-RPC built from the Task 1 fixtures; emits one execute-kind permission request; honors the reject answer)
- Modify: `scripts/e2e-embedded-feed.sh` (harness-switch scenario: `POST /session/config {harness:'cursor'}` → dispatch → assert feed rows show the cursor turn + approval round-trip → switch back to claude)

The fake mirrors `scripts/fake-bin/claude`'s conventions (receipt-log env var, scripted stdin-driven responses) so the script can assert the cancel/reject actually landed. Canned lines byte-copied from the Task 1 fixtures — the fake is the executable form of the same ground truth.

- [ ] **Step 1:** write the fake bin (read `scripts/fake-bin/claude` first; mirror its logging contract).
- [ ] **Step 2:** extend the E2E script with the cursor scenario.
- [ ] **Step 3:** `npm run build && ./scripts/e2e-embedded-feed.sh` → green end-to-end (both scenarios).
- [ ] **Step 4:** root gate.
- [ ] **Step 5:** commit — `test(e2e): fake cursor-agent ACP bin + harness-switch feed scenario`

---

### Task 7 — docs

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md` (keep shared sections byte-identical)

(The spec's §3.6 rider correction — `buildPromptRequest` cleanup already shipped in PR #28 — was applied to the spec at planning time; nothing to do here.)

- [ ] **Step 1:** CLAUDE.md/AGENTS.md: `src/server/session` module table gains the `cursor.ts` row ("CursorAdapter — ACP JSON-RPC spawn contract, kind-split native approvals, replay-safe resume") and `adapter.ts`/`manager.ts` row updates (harness selection, per-harness session.json); MCP-contract section notes the `approve` tool is Claude-only; architecture-loop sentence mentions the harness picker; `chat-constants` paragraph documents the vocab tables; gotchas gain: (a) "Cursor CLI errors can arrive as stderr + non-zero exit, NOT in-band events — the inverse of the Claude gotcha", (b) "session.json is per-harness slots; never feed one harness's resume id to another", (c) "ACP `session/load` replays history as session/update notifications — the adapter swallows them until the load response resolves; don't 'fix' the suppression", (d) "the embedded rung now fires for agent:'cursor' projects (primary path) — the deeplink ladder is its fallback, not its default".
- [ ] **Step 2:** root gate (docs-only, still run it).
- [ ] **Step 3:** commit — `docs: cursor adapter + harness vocab module/gotcha updates`

---

### Task 8 — E2E + gates

**Files:** none (verification only; fix-forward commits).

- [ ] **Step 1:** `npm run build`; kill stale dev servers (`lsof -iTCP:5173` — often `[::1]`); fresh `npm run dev -w demo-app`.
- [ ] **Step 2:** fake-bin gate: `./scripts/e2e-embedded-feed.sh` green (claude + cursor scenarios).
- [ ] **Step 3:** **live Cursor E2E** (needs `agent login`; report and park if quota/login blocks): toggle design mode → pick **Cursor** in the composer → edit padding → Send with no terminal session → feed streams the cursor turn → agent pulls, edits, `mark_applied` → verifier flips the row to Implemented. Then: a shell-command approval surfaces Allow/Deny in the overlay and both paths behave (file edits do NOT prompt); ■ interrupts mid-turn; dev-server restart resumes the same session without duplicated history rows; switch back to Claude Code and repeat one Send (regression); Next fixture smoke (`npm run dev -w next-demo`) for one cursor Send through the sidecar.
- [ ] **Step 4:** prod gate — `./scripts/check-prod-clean.sh` (zero plugin traces + the 320KB budget; record the new client-bundle number).
- [ ] **Step 5:** final root gate — `npm test` green. Hand the branch to the user for the merge decision (per HANDOFF: the merge decision is always the user's).

---

## Self-review notes

- Spec (revised) §3.1→Task 3, §3.2→Tasks 3+4, §3.3→Tasks 2/2b+4, §3.4→Task 2, §3.5→Task 5, §6→Tasks 1/6/8. Out-of-scope honored (no Codex adapter, no `.cursor/cli.json` writes, no print-mode fallback rung, extension notifications → activity).
- Fixture-wins rule up front — plan protocol constants are best-current-knowledge; Task 1 is the authority.
- Idle-zero audited: the picker only POSTs config; nothing spawns until Send/say.
- Token rules hold: turn text untouched; permission answers are protocol constants; the one new agent-visible constant text (login instruction) contains no interpolated data.
- chat-constants keeps zero imports (vocab is pure data; the adapter owns ACP wire shapes).
