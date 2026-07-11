# Second-harness adapter + harness generalization (milestone C1) — design doc

**Date:** 2026-07-11
**Status:** Ratified (2026-07-11, brainstorm with user) — **REVISED same day: C1 pivoted from Codex-first to Cursor-first** (user has no Codex subscription, so the Codex live spike — the plan's protocol ground truth — cannot run; the user has a Cursor subscription). The Codex adapter is now C2, gated on a subscription existing; all its verified research below stands. Implementation started (Task 2 of the plan landed pre-pivot and was amended).
**Research:** [docs/research/2026-07-09-embedded-sessions.md](../research/2026-07-09-embedded-sessions.md) (original harness survey) + fresh verification 2026-07-11 (§2 below — protocol shapes re-checked against live docs, `openai/codex` HEAD, and cursor.com/docs/cli).

## 1. Overview

Milestone C extends embedded sessions beyond Claude Code. This slice (C1) ships the **Cursor adapter** over `cursor-agent acp` plus all the harness-generalization work the next adapter will ride: adapter selection in the runtime, per-harness config vocabulary, per-harness session persistence, and the overlay harness picker. C2 (Codex over `codex app-server`) then lands as one adapter file on an already-generalized seam, when a Codex subscription exists to spike against.

### Ratified decisions (2026-07-11)

1. **One adapter first, own PR.** Originally "Codex first" by the spec-ratified order; **pivoted same day to Cursor first** — the live spike is non-negotiable (fixture-first convention) and requires a subscription the user doesn't have for Codex. Codex's slot in this design is taken over by Cursor wholesale; each adapter still gets its own live-CLI spike and review.
2. **Overlay harness picker, plugin config as default.** A harness select joins the composer's config cluster; it defaults to the `theForge({ agent })` option; switching stops the live embedded session and the next Send auto-starts the chosen harness. The choice persists server-side in `.the-forge/` (survives reloads).
3. **MCP wiring at spawn time only — zero config-file writes.** For Cursor: the `mcpServers` array on ACP `session/new`/`session/load`. (For Codex/C2: `-c mcp_servers.…` spawn overrides.) Auto-writing user-global config (`~/.codex/config.toml`) was rejected as a heavier install side-effect than anything we write today. The existing `.cursor/mcp.json` write for `agent: 'cursor'` projects stays — it serves *terminal-side* Cursor sessions and predates this milestone.
4. **Ratified permission posture is enforced adapter-side for Cursor** (edits auto, commands prompt): ACP `session/request_permission` requests are answered by tool-call kind — edit-kind requests auto-allow, everything else routes to the overlay Allow/Deny. No `.cursor/cli.json` permission writes.

Unchanged constraints: subscription-only via official CLI binaries, zero new runtime dependencies (hand-rolled JSON-RPC, same posture as `src/mcp/protocol.ts`), zero idle overhead, deterministic token-first change requests. ACP is Cursor's *supported* embedding surface (it's how Cursor runs inside Zed/JetBrains) — no billing/policy gray zone.

## 2. Verified harness research (2026-07-11)

Cursor verified against cursor.com/docs/cli (parameters, output-format, headless, ACP, permissions, authentication) and the Zed ACP integration page; Codex against developers.openai.com/codex (app-server, noninteractive, MCP, config-reference, auth) and `openai/codex` HEAD.

### Cursor — `cursor-agent acp` (this milestone)

- Print mode (`cursor-agent -p --output-format stream-json`) is **one-shot per process** — no stdin turn injection; multi-turn means respawn with `--resume <chatId>`. The long-lived surface is **ACP**: JSON-RPC 2.0, newline-delimited, over stdio (protocol on stdout/stdin, logs on stderr). Install puts both `agent` (primary since Jan 2026) and `cursor-agent` (back-compat alias) on PATH — we spawn **`cursor-agent`** (unambiguous name; `agent` is too generic to trust on PATH).
- **Lifecycle:** `initialize` → (`authenticate {methodId:"cursor_login"}` if needed) → `session/new {cwd, mcpServers}` → repeated `session/prompt {sessionId, prompt:[{type:'text',text}]}` — the prompt **response** arrives at turn end with `{stopReason}` → `session/cancel` to interrupt (the in-flight prompt resolves with a cancelled stopReason) → `session/load {sessionId}` to resume a prior conversation.
- **Streaming:** `session/update` notifications — `agent_message_chunk` (text deltas), `tool_call` / `tool_call_update` (id, title, kind ∈ read/edit/execute/…, status, content), plus Cursor extensions (`cursor/update_todos`, `cursor/create_plan`, …).
- **Approvals:** blocking server→client `session/request_permission` requests carrying the tool call + an options list (allow-once / allow-always / reject-once style). Unanswered requests hang the agent — timeout-to-deny is mandatory. We never answer allow-always.
- **MCP:** ACP `session/new` takes an `mcpServers` array (spawn-time wiring, no file writes — decision 3); the CLI also honors project `.cursor/mcp.json`.
- **Auth:** `agent login` (browser OAuth on the Cursor subscription); login-sourced auth is a first-class headless path. We never set `CURSOR_API_KEY` (usage-billed — the forbidden category).
- **Caveats (spike checkpoints):** no effort knob at all; model selection in ACP mode unverified; `session/load` streams the conversation history back as `session/update` notifications (the adapter must not re-ring replayed history); failures can surface as stderr + non-zero exit rather than in-band events — the **inverse** of the Claude in-band-error gotcha; no usage/cost fields.

### Codex — `codex app-server` (C2, verified and parked)

- `codex proto` is gone; `app-server` is the supported embedding surface. JSON-RPC over stdio: `initialize`/`initialized` → `thread/start`/`thread/resume` → `turn/start {threadId, input}` per message; `turn/interrupt`; `turn/steer` exists.
- Streaming: `item/agentMessage/delta`, `item/started`/`item/completed` for `commandExecution`/`fileChange`/`mcpToolCall` items, `turn/completed {usage}` / `turn/failed`.
- Approvals: server→client `item/commandExecution/requestApproval` + `item/fileChange/requestApproval`, answered `accept`/`decline`. Posture maps to workspace-write sandbox + prompting approval policy (enum spelling needs the spike: `"unlessTrusted"` vs `"untrusted"`).
- Per-turn `model` + `effort` (`minimal…xhigh`) params — no respawn for config changes; `model/list` enumerates models.
- MCP via `-c mcp_servers.the-forge.…` spawn overrides (verified in `CliConfigOverrides` at HEAD). Auth: `codex login` ChatGPT-subscription tokens work headless.
- `codex exec` is not an alternative (one-shot, no deltas, no approval channel).

## 3. Architecture

### 3.1 `CursorAdapter` (`src/server/session/cursor.ts`)

One new file implementing the existing `SessionAdapter` interface. Spawn, at `resolveProjectRoot()`: `cursor-agent acp` (no other flags; config rides the protocol).

- **Hand-rolled JSON-RPC framing** (NDJSON lines; request-id bookkeeping for our outgoing requests AND the server→client permission requests we must answer) — same zero-dependency posture as `src/mcp/protocol.ts`. Unknown methods/notifications map to the `activity` heartbeat.
- **Boot:** `initialize` → `session/new {cwd, mcpServers: [the-forge stdio entry pointing at dist/mcp.js]}` (or `session/load {sessionId: resumeId, …}`) → emit `started {sessionId, model: <if discoverable, else ''>, mcpLoaded: true}` (the MCP entry is structural — passed in the request; spike finding is the proof it takes effect). Auth-required at any boot step → `session-error` with a constant "cursor-agent is not logged in — run `agent login`" text, then the normal failed-start path.
- **Turn buffering replaces Claude's lazy-boot stdin buffering:** the manager writes the first turn at spawn (its contract); the adapter queues `sendTurn` payloads until `session/new`/`session/load` resolves, then flushes in order.
- **Turns:** `sendTurn` → `session/prompt`; the response resolving IS the turn boundary — `{stopReason: 'cancelled'-equivalent}` → `turn-complete {isError:false}` (mirrors Claude interrupts), error response → `turn-complete {isError:true, errorText}`, other stopReasons → `turn-complete {isError:false}`. Exact stopReason vocabulary is fixture-pinned.
- **Event mapping:** `agent_message_chunk` → `assistant-delta`, accumulated per segment and flushed as one authoritative `assistant-text` at the next tool call or turn end (ACP has no separate final-text message — the adapter owns segmenting); `tool_call` → `tool-started {toolId, name: <kind>, detail: title/path, edit payload from diff-type content when present, EDIT_PAYLOAD_CAP applies}`; terminal `tool_call_update` → `tool-finished`; `session/load` replay updates are swallowed until the load response resolves (resume must not re-ring history); everything else → `activity`. Child exit/spawn error → `ended`/`session-error` with the same stderr tail pattern as claude.ts.
- **Config:** Cursor exposes no effort knob and no verified ACP model/permission-mode control — `setModel`/`setEffort`/`setPermissionMode` are documented no-ops in v1 (the vocab tables hide the corresponding pickers; see §3.3). `interrupt()` → `session/cancel`.

### 3.2 Approvals — native, registry unchanged, posture adapter-side

`session/request_permission` requests are split by the tool call's kind (decision 4):

- **edit-kind** → answered allow immediately, no overlay round-trip (the ratified "project file edits auto" posture — Claude expresses it as `--allowedTools`, Cursor as kind-based auto-allow).
- **everything else** (execute/fetch/unknown) → parked in the existing `ApprovalRegistry` (same overlay Allow/Deny UI, same `APPROVAL_HOLD_MS` timeout-to-deny, same watchdog suspension). The adapter answers with the allow-once / reject-once option when the registry resolves; never allow-always.

The `approve` MCP tool and `--permission-prompt-tool` remain **Claude-only**.

### 3.3 Harness selection & persistence

- **Vocabulary (`src/shared/chat-constants.ts`, pure data, no imports):** `HarnessId = 'claude-code' | 'cursor'`, `EMBEDDED_HARNESSES = ['claude-code', 'cursor']`, `HARNESS_VOCAB` per harness: efforts (`claude-code`: low…max; `cursor`: **[] — no effort knob, picker hidden**), permissionModes (`claude-code`: default/acceptEdits/plan; `cursor`: **[] — posture is adapter-enforced, picker hidden**), `liveEffort` capability flag (drives whether an effort change is a live write or the Claude respawn dance; moot for Cursor's empty list). `/session/say` + `/session/config` validate against the *selected* harness's tables — an empty table rejects every value.
- **Selection state:** persisted in `session.json`'s `selected` field, defaulting to the plugin `agent` option when it's embedded-capable, else `'claude-code'`. Changing harness stops the live session; the next Send/say auto-starts the new one through the normal send-at-spawn path.
- **`session.json` is per-harness slots:** `{ selected, sessions: { 'claude-code': {sessionId, updatedAt}, cursor: {…} } }` — a Cursor ACP sessionId is meaningless to `claude --resume` and vice versa. Legacy single-id files read as the claude-code slot (one-release compat).
- **Runtime factory ([runtime.ts](../../packages/the-forge/src/server/runtime.ts)):** `makeAdapter` keyed by the selected harness — `ClaudeAdapter` | `CursorAdapter`; the Cursor branch wires `onApproval` to the registry (composition root, beside the existing watchdog wiring).
- **Dispatch gate ([endpoints.ts](../../packages/the-forge/src/server/endpoints.ts), embedded rung):** membership in the embedded-capable set (`claude-code`, `cursor`); `codex` skips to the keystroke ladder until C2. Note this is a deliberate behavior change for `agent:'cursor'` projects: the embedded rung now fires for them (embedded is the primary path) instead of falling through to the deeplink ladder.

### 3.4 Manager changes (small, deliberate)

- `setConfig` gains `harness` (busy → 409, else stop + persist + `config-changed`) and capability-aware effort handling via `HARNESS_VOCAB[harness].liveEffort`; the stop-and-respawn effort path remains Claude-only behavior. Everything else (watchdog, ring, chat queue, stale-resume retry, recovery re-send) is adapter-agnostic and untouched — a rejected `session/load` maps to an error-before-`started`, the exact shape the stale-resume branch already handles.

### 3.5 Client — harness picker

- A harness select joins the composer's config cluster (through `src/client/ui/select.ts`; new hook `.session-harness`), options Claude Code + Cursor from `AGENT_DISPLAY_NAME`. Default from the plugin `agent` option; reload seed from a new `harness` field on `GET /status`; switching POSTs `/session/config {harness}`.
- Effort/permission pickers rebuild from the selected harness's vocab and hide entirely when the table is empty (both are, for Cursor). Model aliases are per-harness (`claude-code`: sonnet/opus/haiku; `cursor`: none — session-reported values only). A `config-changed {harness}` feed row records switches in the transcript.

### 3.6 Riders

- ~~Spec-noted milestone-C cleanup (delete `buildPromptRequest` + the legacy `seed.prompt` resend path)~~ — **already shipped in PR #28 (2026-07-10)**; only the deliberate `v.prompt` drop-guard in `lifecycle-store.ts` remains, and it stays. Correction recorded 2026-07-11 during planning.
- Docs: CLAUDE.md/AGENTS.md module tables (+`cursor.ts` row, adapter-selection notes), gotchas (the stderr/exit-code error gotcha; per-harness session.json).

### Out of scope for C1

Codex adapter (C2 — research verified and parked in §2); terminal-side Codex wiring; rendering ACP plan/todo extension notifications (map to `activity`); token-usage display; print-mode fallback rung for Cursor (ACP or nothing — YAGNI until a real ACP-unavailable case appears).

## 4. Milestones

- **C1 (this doc):** live `cursor-agent acp` spike → `cursor.ts` + fixtures → harness generalization (constants, session.json slots, factory, dispatch gate, manager capability flag) → overlay picker → live E2E gate.
- **C2:** `codex.ts` over `codex app-server` per §2's verified research (own spike + fixtures, `-c` MCP overrides, native requestApproval bridge, per-turn model/effort) — gated on a Codex subscription.

## 5. Risks & open questions

- **ACP surface is the newest of the three** — fixture-pin from the spike; tolerate unknown notifications as `activity`; version-sniff is unnecessary (we spawn it ourselves and read the initialize response).
- **Spike checkpoints:** binary name + `acp` subcommand spelling; `mcpServers` entry shape on `session/new` and proof our tools load; `request_permission` request/response shapes + option kinds (and whether edit-kind requests fire at all under default config); `session/load` replay semantics; stopReason vocabulary; whether model info is discoverable; auth-required error shape.
- **Session-limit/plan errors:** expected as JSON-RPC error responses or stderr+exit — the feed must render them as first-class states either way (the `session-error`/`turn-complete isError` paths both exist).

## 6. Testing approach

Fixture-driven adapter suite mirroring the Claude one (spike transcripts → `cursor-acp-jsonrpc.ts` fixtures): boot + session lifecycle, event mapping per §3.1, permission round-trip (edit auto-allow, execute → overlay allow/deny/timeout), cancel, turn buffering before session-ready, load-replay suppression. Manager tests: harness switching, per-harness resume slots, capability-aware effort. Constants boundary tests. Root `npm test` gate; fake-bin E2E (`scripts/fake-bin/cursor-agent`) + live E2E (Send → embedded Cursor applies → Implemented, approval round-trip, interrupt, resume) before merge.
