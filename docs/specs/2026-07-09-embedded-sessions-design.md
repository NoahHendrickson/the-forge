# Embedded agent sessions — design doc

**Date:** 2026-07-09
**Status:** Draft for review
**Research:** [docs/research/2026-07-09-embedded-sessions.md](../research/2026-07-09-embedded-sessions.md) (harness survey, wire formats, live smoke test, user-ratified decisions)

## 1. Overview

The Forge spawns and owns an agent session itself — the user's own harness (Claude Code first), on the user's own subscription, running as a child process of the dev server at the project root — and streams its activity into the overlay. Send delivers change requests to this embedded session with 100% certainty instead of hoping a terminal session is watching.

This **revises two hard product constraints** by explicit user decision (2026-07-09):

- *"Never a new chat surface"* → relaxed. The overlay gains an activity feed (milestone A) and later a chat surface (milestone B).
- Dispatch-to-your-terminal-session was the primary path → **the embedded session is the new primary path**; the keystroke ladder and linked-session watch remain as fallbacks, not co-equal modes.

Unchanged constraints: subscription-only via **official CLI binaries** (never the Agent SDK, never API keys), deterministic token-first change requests, zero production footprint, zero idle overhead, zero new runtime dependencies.

### Ratified decisions (2026-07-09)

1. **Claude Code first**; Codex (`app-server --stdio`) and Cursor (`agent acp`) are later adapters behind the same interface.
2. **Embedded session is the primary path** — "one or the other," not parallel modes.
3. **Activity feed first**: milestone A has no free-form chat input; streamed progress + approvals only.
4. **Permissions: auto-allow project file edits; prompt in the overlay for Bash and everything else.**

## 2. Primary user story

A designer toggles design mode, edits padding on a card, hits **Send**. The Forge (with no terminal session running anywhere) spawns `claude` headless at the project root, feeds it the change request, and the overlay's activity feed shows the agent reading the file, making the edit, and marking it applied. HMR fires, the verifier confirms computed styles, the row flips to **Implemented**. If the agent wants to run a shell command, an Allow/Deny prompt appears in the overlay. The designer never opened a terminal.

## 3. Architecture

```
browser overlay ── POST /__the-forge/session/* ──────┐   (X-Forge-Secret)
  activity feed + approval prompts + Stop            │
  GET /__the-forge/session/events (fetch stream)     ▼
                                    dev-server runtime (Vite plugin / Next sidecar)
                                      src/server/session/          ← NEW
                                        manager.ts  spawn/kill/watchdog/resume, event ring buffer
                                        claude.ts   stream-json adapter → normalized events
                                        approvals.ts pending-approval registry (long-poll, like WatcherHub)
                                              │ child_process.spawn, cwd = resolveProjectRoot()
                                              ▼
                                    claude -p --input-format stream-json --output-format stream-json
                                              │ loads full harness incl. our .mcp.json
                                              ├──→ pull_design_edits / mark_applied  (loop unchanged)
                                              └──→ approve (NEW MCP tool) ──HTTP──→ approvals.ts ──SSE──→ overlay
```

### 3.1 Session manager (`src/server/session/manager.ts`)

- Lives in `ForgeRuntime` (`src/server/runtime.ts`) beside `queue`/`hub` — both frameworks get it for free. **Nothing spawns until the first Send (or explicit start)**: zero idle overhead holds.
- One session per project (process-singleton, same posture as `ensureSidecar`). State machine: `idle → starting → ready → busy(turn) → ready … → stopped/failed`.
- Spawn (exact flags, validated by live smoke test on CLI 2.1.201):

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  [--resume <session_id>] \
  --permission-prompt-tool mcp__the-forge__approve \
  --allowedTools <edit-tier allow rules>
```

  Never `--bare` (it skips auth *and* the harness — smoke-tested). No `--model` in v1 (user's default).
- **Watchdog:** no stdout event for `WATCHDOG_MS` while `busy` → kill → respawn with `--resume` → re-send the turn (open CLI hang bug #53584). Crash/EOF mid-turn takes the same path. Feed shows a "session recovered" row.
- **Persistence:** `session_id` (from the `init` event) saved to `.the-forge/session.json`; dev-server restart resumes the same conversation. Kill the child on dev-server close (both frameworks' close hooks already manage endpoint-file lifecycle — same place).
- **Errors are in-band** (smoke-tested): rate-limit and auth failures arrive as normal `result` events with `is_error: true` + readable text, exit code 0. The manager surfaces them as feed rows (e.g. "Weekly limit reached, resets Jul 12") and parks the session; it does not retry-loop.

### 3.2 Adapter interface (harness-agnostic from day one)

```ts
interface SessionAdapter {
  start(opts: { cwd: string; resumeId?: string }): void
  sendTurn(text: string): void
  interrupt(): void
  stop(): void
  onEvent: (e: SessionEvent) => void  // manager-assigned
}
type SessionEvent =
  | { kind: 'started'; sessionId: string; model: string; mcpLoaded: boolean }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-started'; toolId: string; name: string; detail: string }  // path or command
  | { kind: 'tool-finished'; toolId: string }
  | { kind: 'turn-complete'; isError: boolean; errorText?: string; costUsd?: number }
  | { kind: 'session-error'; text: string }
  | { kind: 'ended' }
```

Milestone A implements only `claude.ts` (NDJSON line parser over the verified event shapes; `assistant`/`tool_use`/`tool_result` pairing by id; interrupt via `control_request`). Codex/Cursor are one new file each later.

### 3.3 Approvals (`approve` MCP tool + `approvals.ts`)

The working mechanism is `--permission-prompt-tool` (the SDK-style `can_use_tool` control request is broken — CLI bug #34046). We already ship the MCP server the child session loads:

1. New tool `approve` on the `the-forge` MCP server, `{tool_use_id, tool_name, input}`. The bin POSTs `/__the-forge/approval` and long-polls the decision (same hold pattern as `/wait`; generous timeout — a human is deciding).
2. Runtime pushes an `approval-request` over the session event stream; overlay renders tool name + detail (command text for Bash) with **Allow / Deny**.
3. Decision returns through the bin as `{"behavior":"allow","updatedInput":<original input>}` or `{"behavior":"deny","message":"denied from The Forge overlay"}`. `updatedInput` must echo the original input verbatim (empty object is only a fallback).
4. **Static rules short-circuit the prompt tool** — that's how the ratified posture is expressed: `--allowedTools "Edit" "Write" "MultiEdit" "Read" "Grep" "Glob"` (project-scoped edit tier auto-allowed), everything else (Bash, WebFetch, arbitrary MCP tools) hits `approve`.
5. Safety valve: an approval nobody answers within the hold resolves **deny** with a "timed out — re-send when ready" note; never leave the child blocked forever.

### 3.4 Dispatch integration — the new primary path

New rung `'embedded'` at the **top** of the ladder (above `'watcher'`):

- Embedded session `ready`/`busy` → deliver: `sendTurn()` with the same terse pull instruction the watch loop uses (constant text, no interpolated request content — the agent pulls via `pull_design_edits` as always; per-tick token-cost rule holds).
- Embedded session `idle` → **auto-start it** (primary-path semantics), then deliver. Feed shows "starting session…".
- Spawn fails (no `claude` binary, not logged in) → fall through to the existing ladder unchanged (`watcher` → tmux → AppleScript → deeplink → manual). The failure reason lands in the feed once, not on every Send.
- A live **external** watcher takes precedence over *auto-starting* a new embedded session (the user deliberately linked that terminal session; don't shadow it) — but never over an embedded session that is already running.

Queue, `mark_applied`, verifier: untouched. The embedded agent is a normal MCP consumer.

### 3.5 Client — activity feed (milestone A)

- Event stream via `fetch()` + ReadableStream on `GET /__the-forge/session/events` — **not `EventSource`** (it can't send the `X-Forge-Secret` header). Server keeps a ring buffer (last ~200 events) replayed on connect, so a reopened panel shows recent history. Connection exists only while design mode is on (zero idle).
- Feed UI lives with the Changes list (a section/tab in the docked panel): session status row (model, state, cost-to-date), per-turn activity rows (assistant text snippets, tool rows "Edit src/App.tsx", spinner → check), approval prompts inline, **Stop** button → `POST /session/interrupt`.
- All buttons through `src/client/ui/` factories; class names are new test hooks (`.session-feed`, `.session-row`, `.session-approval`, `.session-stop`); stories for the feed atoms.
- The watch indicator grows a third state: linked terminal session / **embedded session** / none.

### 3.6 Security

- All `/session/*` endpoints (including the event stream) require `X-Forge-Secret`; same Origin/Host + DNS-rebinding gates as every existing endpoint.
- The child process has write access to the repo — the approval gate is the control; Bash is never auto-allowed. Turn text sent to the child is constant (the pull instruction) or, later (milestone B), user-typed chat — never derived from request/DOM content.
- Interrupt/stop endpoints are mutating → secret-gated like the rest.

## 4. Milestones

- **A — embedded engine + activity feed (Claude):** `src/server/session/` (manager, claude adapter, approvals), `approve` MCP tool, `'embedded'` dispatch rung with auto-start, event-stream endpoint, activity feed UI, Stop, session resume, watchdog. No free-form input. E2E: full Send → embedded apply → Implemented loop on the demo app with zero terminal involvement.
- **B — chat surface:** free-form input into the same session (element-anchored via existing PromptBox entry point + a general input in the feed), message history rendering, richer turn display (diffs), `set_permission_mode`/model picker.
- **C — Codex adapter** (`codex app-server --stdio`: threads, native approvals), then **Cursor adapter** (`agent acp`).

## 5. Risks & open questions

- **Anthropic policy/billing** (research doc §Billing): headless-vs-interactive billing separation announced then paused; OAuth-for-native-apps legal language. Accepted with eyes open for the primary path; the ladder fallback keeps the product functional if the posture must flip back. Re-check before each release.
- **Weekly/session limits surface mid-flow** (observed live during the smoke test): the feed must render limit errors as first-class states, with "resume via terminal dispatch" as the suggested fallback.
- **CLI churn:** stream-json is stable-ish but underdocumented; pin known-good event shapes in adapter tests with recorded fixtures from the real CLI (the smoke-test transcripts are the first fixtures).
- Open (A): exact `WATCHDOG_MS`; whether the auto-started session announces itself in the feed with a permission-posture summary (leaning yes, one row).
- Open (B): does chat share the Send queue's lifecycle rows or stay purely in the feed?

## 6. Testing approach

- Unit: adapter parser against recorded NDJSON fixtures (init/assistant/tool_use/result, in-band error variants); manager state machine with a fake adapter + fake clock (watchdog, respawn-with-resume, auto-start); approvals registry (long-poll, timeout-deny) mirroring the WatcherHub test style; dispatch rung ordering with a fake session manager.
- MCP: `approve` tool round-trip against a stub HTTP server (existing bin test pattern).
- Client: feed rendering from synthetic event streams (jsdom); stream reconnect/replay.
- E2E (real browser + real `claude`, post Jul 12 limit reset): the milestone-A loop end-to-end; kill-the-child mid-turn recovery; approval prompt round-trip on a Bash-requiring prompt.
