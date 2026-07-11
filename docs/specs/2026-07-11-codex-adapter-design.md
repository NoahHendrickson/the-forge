# Codex adapter + harness generalization (milestone C1) — design doc

**Date:** 2026-07-11
**Status:** Ratified (2026-07-11, brainstorm with user) — implementation not started. Cursor adapter is C2, a follow-up on the seam this milestone generalizes.
**Research:** [docs/research/2026-07-09-embedded-sessions.md](../research/2026-07-09-embedded-sessions.md) (original harness survey) + fresh verification 2026-07-11 (§2 below — protocol shapes re-checked against live docs and `openai/codex` HEAD).

## 1. Overview

Milestone C extends embedded sessions beyond Claude Code. This slice (C1) ships the **Codex adapter** over `codex app-server` plus all the harness-generalization work the second adapter will ride: adapter selection in the runtime, per-harness config vocabulary, per-harness session persistence, and the overlay harness picker. C2 (Cursor over `agent acp`) then lands as one adapter file on an already-generalized seam.

### Ratified decisions (2026-07-11)

1. **Codex first, own PR.** Matches the spec-ratified adapter order; each adapter gets its own live-CLI spike and review.
2. **Overlay harness picker, plugin config as default.** A harness select joins the composer's config cluster; it defaults to the `theForge({ agent })` option; switching stops the live embedded session and the next Send auto-starts the chosen harness. The choice persists server-side in `.the-forge/` (survives reloads).
3. **Codex MCP wiring via spawn-time `-c` overrides only.** The embedded child gets `-c mcp_servers.the-forge.…` flags at spawn — zero config-file writes. Terminal-side Codex sessions (watch/keystroke fallback rungs) stay unwired for now; auto-writing user-global `~/.codex/config.toml` was rejected as a heavier install side-effect than anything we write today (all current writes are project-scoped).

Unchanged constraints: subscription-only via official CLI binaries, zero new runtime dependencies (hand-rolled JSON-RPC, same posture as `src/mcp/protocol.ts`), zero idle overhead, deterministic token-first change requests. Notably the Anthropic billing/policy gray zone (embedded-sessions spec §5) has **no Codex equivalent**: `app-server` is OpenAI's *supported* embedding surface ("the interface Codex uses to power rich clients"), ChatGPT-subscription auth included.

## 2. Verified harness research (2026-07-11)

Re-verified against developers.openai.com/codex (app-server, noninteractive, MCP, config-reference, auth) and `openai/codex` HEAD (`codex-rs/cli/src/main.rs`, `exec_events.rs`, `config_override.rs`); Cursor against cursor.com/docs/cli (parameters, output-format, headless, ACP, permissions) and the Zed ACP integration page.

### Codex — `codex app-server` (this milestone)

- `codex proto` is **gone** (confirmed at HEAD); `app-server` is the long-lived bidirectional surface: JSON-RPC 2.0, newline-delimited, over stdio.
- **Lifecycle:** `initialize`/`initialized` handshake → `thread/start` or `thread/resume <threadId>` → `turn/start {threadId, input:[{type:'text',text}]}` per user message → `turn/interrupt` to stop a turn. (`turn/steer` — append input mid-turn — exists; not used in C1.)
- **Streaming:** `item/agentMessage/delta {itemId, delta}` token deltas; `item/started`/`item/completed` for items of type `agentMessage`, `reasoning`, `commandExecution` (`{command, exit_code, status}`), `fileChange` (`{changes:[{path,kind}], status}`), `mcpToolCall` (`{server, tool, status}`), `webSearch`, `todoList`; `turn/completed {status, usage}` / `turn/failed {error}`.
- **Approvals are server→client JSON-RPC requests** (with ids): `item/commandExecution/requestApproval {itemId, threadId, turnId, command?, cwd?, reason?}` and `item/fileChange/requestApproval {…, grantRoot?}`; the client responds `"accept" | "acceptForSession" | "decline" | "cancel"`. Declined items complete with `status:"declined"`.
- **Per-turn config:** `turn/start` accepts `model`, `effort` (`minimal|low|medium|high|xhigh`), `approvalPolicy`, `permissions` — no respawn needed for any config change. `model/list` returns model ids + `supportedReasoningEfforts` + defaults.
- **MCP:** `mcp_servers.<name>` config table; per-invocation override via `-c mcp_servers.the-forge.command=node -c 'mcp_servers.the-forge.args=["/abs/dist/mcp.js"]'` (verified: `CliConfigOverrides` flattens `-c` on every subcommand, value parsed as TOML with raw-string fallback, split on first `=`).
- **Auth:** `codex login` (ChatGPT subscription) caches to `~/.codex/auth.json`; headless children reuse and auto-refresh it. We never set `CODEX_API_KEY`.
- **Exec is not an alternative:** `codex exec --json` is one-shot per process, has **no token deltas** (whole `agent_message` at `item.completed`) and **no approval channel** — strictly worse than app-server for this use.

### Cursor — `agent acp` (C2 context, recorded here so the seam anticipates it)

- Print mode (`agent -p --output-format stream-json`) is one-shot per process — no stdin turn injection; multi-turn means respawn with `--resume <chatId>`. The long-lived surface is **ACP**: `initialize` → `session/new {cwd, mcpServers}` → `session/prompt` per turn → `session/update` notifications (`agent_message_chunk` deltas, tool-call updates) → `session/cancel` to interrupt → `session/load` to resume.
- **Approvals:** blocking `session/request_permission` server→client requests (`allow-once`/`allow-always`/`reject-once`). Unanswered requests hang the agent — timeout-to-deny is mandatory.
- **MCP:** reads the `.cursor/mcp.json` we already write for `agent:'cursor'`; ACP `session/new` also takes an `mcpServers` array.
- **Caveats for C2:** no effort knob at all (picker hides effort); model selection in ACP mode unverified (spike item); failures can surface as stderr text + non-zero exit rather than in-band events — the **inverse** of the Claude in-band-error gotcha; no usage/cost fields.

## 3. Architecture

### 3.1 `CodexAdapter` (`src/server/session/codex.ts`)

One new file implementing the existing `SessionAdapter` interface. Spawn, at `resolveProjectRoot()`:

```
codex app-server \
  -c mcp_servers.the-forge.command=node \
  -c 'mcp_servers.the-forge.args=["<abs path to dist/mcp.js>"]'
```

- **Hand-rolled JSON-RPC framing** (NDJSON lines, request-id bookkeeping for the requests *we* send and the approval requests the *server* sends us) — same zero-dependency posture as `src/mcp/protocol.ts`. Unknown methods/notifications map to the `activity` heartbeat (forward-compat, same as ClaudeAdapter's default arm).
- **Turn buffering replaces Claude's lazy-boot stdin buffering.** The manager writes the first turn immediately at spawn (its ratified contract). ClaudeAdapter relies on the CLI buffering stdin during boot; a JSON-RPC server can't accept `turn/start` before the handshake and `thread/start`/`thread/resume` complete, so the adapter holds a small internal queue and flushes it once the thread is ready. Manager-visible behavior is identical.
- **Event mapping:**

| app-server | `SessionEvent` |
| --- | --- |
| `thread/start`/`thread/resume` result | `started {sessionId: threadId, model, mcpLoaded}` (`mcpLoaded` from `mcpServerStatus/list` or the first successful `mcpToolCall` — spike decides which is reliable) |
| `item/agentMessage/delta` | `assistant-delta` |
| `item/completed` (agentMessage) | `assistant-text` |
| `item/started` (commandExecution / fileChange / mcpToolCall) | `tool-started {toolId: itemId, name, detail}` — detail is the command or first changed path; fileChange patches feed the capped `edit` payload (`EDIT_PAYLOAD_CAP` applies) |
| `item/completed` (same types) | `tool-finished {toolId: itemId}` |
| `turn/completed` | `turn-complete {isError: status!=='completed' && status!=='interrupted'}` |
| `turn/failed` | `turn-complete {isError: true, errorText: error.message}` |
| `reasoning` items, `turn/diff/updated`, `thread/status/changed`, unknowns | `activity` |
| child exit / spawn error | `ended` / `session-error` (unchanged shape) |

- **Config is live, not respawn-based:** `setModel`/`setEffort`/`setPermissionMode` store adapter-internal state applied as params on the next `turn/start`. The effort-kill-and-respawn dance stays a Claude-only quirk (the manager's respawn branch still exists for ClaudeAdapter; for Codex the manager's `setConfig` effort path can simply not stop the adapter — see §3.4).
- **Interrupt** → `turn/interrupt {threadId, turnId}` (adapter tracks the live turnId from `turn/started`).

### 3.2 Approvals — native, registry unchanged

`item/commandExecution/requestApproval` and `item/fileChange/requestApproval` are parked in the existing `ApprovalRegistry` (same overlay Allow/Deny UI, same `APPROVAL_HOLD_MS` timeout-to-deny, same watchdog suspension via `onApprovalPending`). The adapter answers the JSON-RPC request with `accept`/`decline` when the registry resolves. The `approve` MCP tool and `--permission-prompt-tool` remain **Claude-only** — Codex never touches them.

**Posture mapping** (ratified "edits auto, Bash prompts"): workspace-write sandbox so project file edits apply without prompting, plus a prompting approval policy so commands surface in the overlay. The exact `approvalPolicy`/`permissions` spelling on `turn/start` is inconsistent between docs (`"unlessTrusted"`) and config reference (`"untrusted"`) — **spike checkpoint**, pinned in fixtures. Dangerous tiers (`danger-full-access`, `never`+full trust) are excluded from our vocabulary the same way `bypassPermissions` is excluded for Claude.

### 3.3 Harness selection & persistence

- **Vocabulary (`src/shared/chat-constants.ts`, stays pure data with no imports):** per-harness tables replace the flat constants — effort levels (`claude-code`: low…max; `codex`: minimal…xhigh), permission modes (`claude-code`: default/acceptEdits/plan; `codex`: the spike-pinned prompting subset), and which harnesses support the embedded rung. `/session/say` + `/session/config` validate against the *selected* harness's table.
- **Selection state:** server-side in `.the-forge/` (0600, same as everything there), defaulting to the plugin `agent` option when unset. Changing harness stops the live session; the next Send/say auto-starts the new one through the normal send-at-spawn path.
- **`session.json` becomes per-harness:** `{ [harness]: { sessionId, updatedAt } }` slots — a Codex `thread_id` is meaningless to `claude --resume` and vice versa; switching harnesses must not feed one CLI the other's resume id. Legacy single-id files are treated as the claude-code slot (read-compat, one release).
- **Runtime factory ([runtime.ts:82](../../packages/the-forge/src/server/runtime.ts)):** `makeAdapter` keyed by the selected harness — `ClaudeAdapter` | `CodexAdapter`.
- **Dispatch gate ([endpoints.ts](../../packages/the-forge/src/server/endpoints.ts), embedded rung):** `resolvedAgent === 'claude-code'` becomes membership in the embedded-capable set (`claude-code`, `codex`); `cursor` still skips to the keystroke ladder until C2.

### 3.4 Manager changes (small, deliberate)

- `setConfig` effort handling becomes adapter-capability-aware: for harnesses with live effort (`codex`) it's a plain `setEffort` write (no stop, no busy-rejection needed); the stop-and-respawn path remains for `claude-code`. Expressed as a capability flag on the vocab table, not `instanceof` checks.
- Everything else (watchdog, ring, chat queue, stale-resume retry, recovery re-send) is already adapter-agnostic and stays untouched. The stale-resume branch works as-is: a rejected `thread/resume` maps to an error before `started`, same shape Claude produces.

### 3.5 Client — harness picker

- A harness select joins the composer's config cluster (through `src/client/ui/select.ts`, like the existing pickers; class names are new test hooks, e.g. `.harness-select`). Options: Claude Code, Codex (from `AGENT_DISPLAY_NAME`); Cursor appears in C2.
- Model/effort/permission pickers re-seed from the per-harness vocab on harness change; effort hides entirely for harnesses without it (future-proofing for Cursor). The model select keeps its existing seeding pattern (started/config-changed-reported values first); Codex's `model/list` can enrich the options later — not required for C1.
- Switching harness renders a `config-changed`-style feed row so the transcript records which harness produced which turns.

### 3.6 Riders

- ~~Spec-noted milestone-C cleanup (delete `buildPromptRequest` + the legacy `seed.prompt` resend path)~~ — **already shipped in PR #28 (2026-07-10)**; only the deliberate `v.prompt` drop-guard in `lifecycle-store.ts` remains, and it stays (it drops retired persisted sends rather than resurrecting them). Correction recorded 2026-07-11 during planning.
- Docs: CLAUDE.md/AGENTS.md module tables (+`codex.ts` row, adapter-selection notes), gotchas (Cursor's inverse error-surfacing gotcha recorded now so C2 doesn't rediscover it).

### Out of scope for C1

Cursor adapter (C2); terminal-side Codex wiring (`~/.codex` config/prompt writes — deliberately not written); rendering Codex `reasoning` items in the feed (mapped to `activity`); token-usage/cost display; `turn/steer`.

## 4. Milestones

- **C1 (this doc):** live spike → `codex.ts` + fixtures → harness generalization (constants, session.json slots, factory, dispatch gate, manager capability flag) → overlay picker → riders → live E2E gate.
- **C2:** `cursor.ts` over `agent acp` (session/new + request_permission → registry; timeout-to-deny; stderr/exit-code error mapping), `.cursor/mcp.json` already in place, picker gains Cursor, effort hidden. Own spike + fixtures.

## 5. Risks & open questions

- **Protocol churn:** app-server is explicitly evolving (v2, `[experimental]` methods). Mitigation: pin known-good shapes in fixtures from the spike transcripts (`codex app-server generate-json-schema` exists for cross-checking); tolerate unknown methods as `activity`.
- **Spike checkpoints:** exact `approvalPolicy`/`permissions` enum spelling on `turn/start`; whether `-c mcp_servers` overrides reach app-server threads (verified for exec at HEAD, assumed shared config plumbing); the reliable `mcpLoaded` signal; whether `thread/resume` failures arrive as JSON-RPC errors or `turn/failed`.
- **Lazy-boot contract inversion:** if `thread/start` is slow, the adapter's internal queue (not the CLI's stdin buffer) is what holds the first turn — watchdog interplay covered by the existing `activity`-on-protocol-chatter heartbeat, but the spike should confirm boot chatter exists.
- **Session-limit/auth errors:** need the in-band-vs-exit-code answer for Codex (Claude gotcha: in-band with exit 0). Expected as `turn/failed` with readable text; spike confirms.

## 6. Testing approach

Fixture-driven adapter suite mirroring `tests/server/session/` for Claude (spike transcripts → `codex-appserver-jsonrpc.ts` fixtures): handshake + thread lifecycle, event mapping per §3.1's table, approval round-trip (allow, deny, timeout), interrupt, turn buffering before thread-ready, live config application on next turn. Manager tests: harness switching stops/re-spawns correctly, per-harness session.json slots, capability-aware effort path. Constants boundary tests (per-harness validation on `/session/config`). Root `npm test` is the gate; live E2E (Send → embedded Codex applies → Implemented, approval round-trip, kill/resume recovery) on the demo app before merge, same bar as milestone A.
