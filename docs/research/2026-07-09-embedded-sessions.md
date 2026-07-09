# Embedded agent sessions — research findings (2026-07-09)

**Question:** what would it look like to revisit the original pre-pivot idea — The Forge owning its own agent sessions, spawning the Claude Code / Codex / Cursor harness itself and hosting a chat surface inside the overlay — instead of only dispatching to the user's already-running session?

**Status:** research + brainstorm input. The "complementary, never a chat surface" constraint is user-set, so relaxing it is the user's call.

**Decision (user, 2026-07-09):** Claude Code is the first adapter — Codex and Cursor follow later. The "Claude Code adapter — concrete design" section below supersedes the generic phasing question of which harness goes first.

## Where this idea already lives in our history

- The original design doc (§7, 2026-07-03) shipped with exactly this as **"Quick-apply mode"**: *"companion spawns `claude -p --resume <session>` (or `cursor-agent`/`codex exec`) itself and streams progress into a minimal activity feed in the toolbar. Same CLIs, same subscription."* Deliberately demoted to optional/off-by-default at the time.
- §8's hard constraint was never "no spawning" — it was **official CLI binaries only, never the Agent SDK or API keys**. An embedded session built on the CLIs is inside the original constraint's letter; what it relaxes is the *product* constraint ("never a replacement, never a new chat surface").
- The stagewise cautionary tale (see 2026-07-05-chrome-extension-pivot.md §3): they dropped bring-your-own-agent to sell their own agent and vacated our slot. The mitigating difference here: we'd be *hosting the user's own harness on their own subscription*, not replacing it with our agent — the user's config (CLAUDE.md, skills, MCP, rules) still loads because the child process runs at the project root.

## Per-harness embedding surface (state of mid-2026)

### Codex — `codex app-server --stdio` (best-in-class)

Purpose-built for exactly this use ("the interface Codex uses to power rich clients", e.g. the VS Code extension). Since CLI v0.136 (June 2026), `--stdio` gives newline-delimited JSON-RPC 2.0 over stdin/stdout — no socket, no port.

- **Lifecycle:** `initialize`/`initialized` handshake → `thread/start` / `thread/resume` / `thread/fork` → `turn/start` per user message; `turn/steer` to redirect mid-turn.
- **Streaming:** `item/started`, `item/agentMessage/delta`, `item/completed` (authoritative final state), `turn/started`/completed — everything a chat UI needs.
- **Approvals are first-class:** server-initiated JSON-RPC requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) that the client answers with a decision — a native fit for an approval UI in the overlay. `approvalPolicy` per thread/turn.
- **Auth/usage introspection:** `account/read` (ChatGPT-managed OAuth, `planType`), `account/rateLimits/read` + `account/rateLimits/updated` — we could render plan usage in the panel.
- Threads persist in `CODEX_HOME`; resumable across restarts; `thread/list` can even show the user's terminal-started sessions.

### Claude Code — `claude -p` with bidirectional stream-json (workable, rougher)

```
claude -p --input-format stream-json --output-format stream-json \
  --verbose --include-partial-messages [--resume <session_id>]
```

- One long-lived process per conversation with JSONL in/out; `session_id` from the init/result events; `--resume` continues across restarts (session lookup is scoped to the project dir — matches our resolveProjectRoot cwd). `--fork-session`, `--session-id` exist.
- Full harness loads by default in `-p` mode (CLAUDE.md, skills, MCP — including *our own* `.mcp.json` entry; `--bare` exists to skip, we would NOT pass it).
- **Approvals are the weak spot:** the control-protocol `can_use_tool` request exists but has an open bug where the CLI never emits it (#34046); the documented alternative is `--permission-prompt-tool` pointing at an MCP tool (clunky) or coarse `--permission-mode` (`acceptEdits` is a plausible default for design edits: auto-approves file edits in cwd, still gates arbitrary bash).
- **Known instability:** headless stream-json has an open indefinite-hang issue (#53584 — no client read timeout); an embedded runner needs its own inactivity watchdog + respawn-with-`--resume` recovery.

### Cursor — `agent acp` (rich) or `cursor-agent -p` (simple)

- **ACP mode (`agent acp`):** official; JSON-RPC over stdio; `session/update` streaming notifications, `session/request_permission` for approvals, plus `cursor/*` extension methods (todos, plans). This is Cursor's supported embedding path — it's how Cursor runs inside Zed/JetBrains/Neovim.
- **Headless mode (`cursor-agent -p --output-format stream-json --stream-partial-output --resume <thread>`):** NDJSON similar to Claude's; but **no approval loop** — non-interactive mode has full write access (`--force` semantics), or read-only `--mode plan`. Fine for an activity feed, wrong for a supervised chat.
- Parsing quirk: `assistant` events arrive in duplicate buffered forms; keep only deltas with `timestamp_ms` and no `model_call_id`; the terminal `result` event is canonical.

### The unifying-protocol question (ACP everywhere?)

ACP has become the cross-vendor standard (Zed, JetBrains, MS Intelligent Terminal, registry). Cursor speaks it natively; Codex via a `codex-acp` adapter; Claude Code only via adapters that wrap the **Agent SDK** (`claude-code-acp`) — which our constraint forbids embedding, and which would also break the zero-runtime-dependency rule. **Conclusion: don't standardize on ACP.** Write three thin native adapters (Codex app-server JSON-RPC, Claude stream-json, Cursor ACP) normalized to one internal event model — the same hand-rolled-protocol posture as `src/mcp/protocol.ts`.

Normalized internal event model (sketch): `session-started {sessionId}` · `text-delta {text}` · `tool-started {kind, path?, command?}` · `tool-finished {…}` · `approval-request {id, kind, detail}` → answered via endpoint · `turn-complete {usage?}` · `error {…}` · `session-ended`.

## Billing & policy (the load-bearing risk, Claude specifically)

- Anthropic announced (then **paused on June 15, 2026**) moving `claude -p` / Agent SDK / third-party-app usage off subscription limits onto a separate metered monthly credit (~$20 Pro / $100 Max 5x / $200 Max 20x, API rates, no rollover). Currently *nothing has changed* — `claude -p` still draws subscription — but the direction is clear: **headless usage is being separated from interactive usage.** An embedded Forge session may land on the credit pool when the change un-pauses.
- Anthropic's legal page: OAuth login is for "ordinary use of Claude Code and other native Anthropic applications"; third-party developers must not "offer Claude.ai login or route requests through Free/Pro/Max plan credentials **on behalf of their users**." A local dev tool spawning the user's own logged-in CLI on their own machine is the same category as Zed's Claude integration and every CI harness — widely done, but it is a gray zone Anthropic explicitly reserves the right to enforce. This is the strongest argument for keeping the dispatch-to-your-own-session path as the default and the embedded session as an opt-in mode.
- Codex and Cursor have no equivalent tension today: `app-server` and `agent acp` are the vendors' *supported* embedding surfaces, ChatGPT/Cursor subscription auth included.

## What it would look like in our architecture

The key structural insight: **the embedded session is just another "already-running session" — one we fully control.** Because the child process runs at `resolveProjectRoot()`, it loads the project's `.mcp.json` and therefore has our own `pull_design_edits`/`mark_applied` tools. The entire existing queue → pull → apply → mark → verify loop works unchanged; dispatch simply gains a rung with 100% delivery certainty.

```
browser overlay ── POST /__the-forge/session/* ──┐        (X-Forge-Secret, same-origin)
  chat/activity surface + approval prompts       │
  GET /__the-forge/session/events (SSE)          ▼
                                     dev-server runtime (Vite plugin / Next sidecar)
                                       src/server/session/   ← NEW
                                         manager: spawn/kill/respawn, one session per project
                                         adapters: codex-appserver | claude-streamjson | cursor-acp
                                         normalized event log (ring buffer → SSE)
                                                 │ child_process (project root cwd)
                                                 ▼
                                     claude -p … | codex app-server --stdio | agent acp
                                                 │ loads user's harness config incl. our .mcp.json
                                                 └──→ pull_design_edits / mark_applied (loop unchanged)
```

- **Server:** new `src/server/session/` inside the existing runtime — the dev server / sidecar is already the long-running project-root process with same-origin HTTP + the auth secret. Endpoints: `POST /session/start|prompt|approve|stop` (secret-gated), `GET /session/events` (SSE). Process lifecycle mirrors the sidecar singleton lessons: one session per project, kill on dev-server exit, orphan detection via pid.
- **Dispatch:** new top rung `'embedded'` beside `'watcher'` — if an embedded session is live, Send feeds it a turn (the `/forge-design` prompt, or the markdown directly) and skips the keystroke ladder.
- **Verification:** unchanged — `mark_applied` still flips lifecycle rows; the verifier still checks computed styles post-HMR. Turn-complete events give the chat surface its own "done" signal for free-form prompts.
- **Client:** the chat/activity surface in the shadow-DOM overlay. This is the big cost center: message list, streamed text, tool-call rows, diff previews, approval prompt UI — all through `src/client/ui/` factories with stories. Existing `PromptBox` (element-anchored prompts) is the natural entry point that grows into it.
- **Constraints check:** zero prod footprint (serve-only, unchanged) ✓ · zero idle overhead (nothing spawns until the user starts a session) ✓ · zero runtime deps (child_process + hand-rolled JSON-RPC/NDJSON) ✓ · deterministic token-first requests (unchanged — same queue items) ✓ · subscription-only via official CLI binaries ✓ · **"never a new chat surface" — explicitly relaxed; this is the decision.**

## Risks

1. **Anthropic policy/billing volatility** (above) — build so the embedded mode degrades gracefully to the existing dispatch path.
2. **Claude headless instability** — hang bug requires a watchdog + respawn-with-resume; approvals path is buggy, so v1 likely ships `--permission-mode acceptEdits` rather than per-tool prompts for Claude.
3. **Security surface** — a browser-triggered process with write access to the repo. Mitigations already in place (X-Forge-Secret on mutating endpoints, Origin/Host checks) extend to the new endpoints; approval UI defaults to on; never auto-grant bash.
4. **UI scope creep** — a chat surface is the single largest client feature to date and the exact slope stagewise slid down. Scoping it as "activity feed first, chat second" contains it.
5. **Session confusion** — an embedded session and a terminal session on the same project are separate conversations (Claude `--resume` and Codex `thread/list` can *see* each other's sessions, but concurrent two-frontend use of one session isn't supported). The watch indicator UX needs to disambiguate "linked terminal session" vs "embedded session".

## Claude Code adapter — concrete design (Claude-first, ratified 2026-07-09)

### Process shape

One long-lived child process per conversation, spawned at `resolveProjectRoot()`:

```
claude -p --input-format stream-json --output-format stream-json \
  --verbose --include-partial-messages \
  [--resume <session_id>]          # restart/recovery path
  [--permission-prompt-tool mcp__the-forge__approve]   # see Approvals
```

Both directions are NDJSON, one JSON object per line. No `--bare` — we *want* the full harness (CLAUDE.md, skills, hooks, and crucially the project's `.mcp.json`, which loads our own MCP server into the embedded session).

### Wire format (verified event shapes)

Output events (stdout), keyed by top-level `type`:

- `{"type":"system","subtype":"init","session_id","tools":[…],"mcp_servers":[{name,status}],"cwd","model","permissionMode"}` — capture `session_id` here for resume; `mcp_servers` status tells us whether our own MCP entry loaded.
- `{"type":"assistant","session_id","message":{content:[{type:"text"|"tool_use",…}],usage}}` — full message per assistant step; `tool_use` blocks carry `{id,name,input}` (file paths for Edit/Write, commands for Bash) — everything the activity feed needs.
- `{"type":"stream_event",…}` — token-level deltas when `--include-partial-messages` is on (for live-typing rendering; optional to consume in v1).
- `{"type":"user","message":{content:[{type:"tool_result","tool_use_id",content}]}}` — tool results echoed back; pairs with `tool_use` by id for start/finish rows.
- `{"type":"result","subtype":"success","session_id","result","num_turns","total_cost_usd","usage","is_error","permission_denials"}` — turn complete; our `turn-complete` event.
- `{"type":"control_request"/"control_response",…}` — bidirectional control channel.

Input (stdin):

- User turn: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`.
- Interrupt (the chat surface's Stop button): `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt"}}`.
- Also available client→server: `set_permission_mode`, `set_model` — a permission-mode toggle and model picker in the overlay are nearly free.

### Approvals — route through our own MCP server (key finding)

The buggy path we ruled out is the SDK-style `can_use_tool` control request (#34046, CLI never emits it). But `--permission-prompt-tool mcp__<server>__<tool>` is a separate, working mechanism — and **we already ship the MCP server the session loads.** Add an `approve` tool to `src/mcp/`:

1. CLI hits a tool call not covered by static rules → calls `mcp__the-forge__approve` with `{tool_use_id, tool_name, input}`.
2. Our MCP bin already talks HTTP to the dev server — it POSTs the pending approval; the runtime pushes an `approval-request` event over SSE to the overlay; the overlay renders Allow/Deny; the decision long-polls back (same shape as the `/wait` channel).
3. The tool returns `{"behavior":"allow","updatedInput":{…original input…}}` or `{"behavior":"deny","message":"…"}` (deny may set `interrupt: true` to abort the turn). Note: `updatedInput` must echo the original input — an empty object means "use original" only by fallback.
4. Static rules still short-circuit: `--allowedTools`/settings allow-rules never reach the prompt tool, so a default posture like "Edit/Write in cwd auto-allowed, Bash prompts" is expressible as allow rules + prompt-tool for the rest.

This makes the approval UI buildable *today* without the control-protocol bug, using infrastructure we already own. (Known wart: an open issue where the CLI's path sandbox can still block `.claude/**` writes after an allow — irrelevant to design edits in `src/`.)

### Reliability

- **Hang watchdog:** open issue #53584 — headless stream-json can hang indefinitely (no client read timeout). The session manager needs an inactivity timer (no stdout events for N seconds mid-turn) → kill → respawn with `--resume <session_id>`. Session state survives; the turn is re-prompted.
- **Crash/exit:** non-zero exit or stdout EOF mid-turn → same respawn-with-resume path; surface a "session recovered" row in the feed.
- **Restart of the dev server:** persist `session_id` in `.the-forge/` so the embedded conversation survives dev-server restarts (Claude session lookup is scoped to the project dir — matches our cwd).

### Live smoke test (2026-07-09, CLI 2.1.201, this machine)

One stream-json turn piped into `claude -p --input-format stream-json --output-format stream-json --verbose` from the project root confirmed:

- Event shapes match the research exactly — `system/init` (with `session_id`, `tools`, `mcp_servers`, `model`, `permissionMode`, plus `slash_commands`/`skills`/`plugins` inventories), `assistant`, `result`.
- **Errors are surfaced in-band, not as process failures:** a rate-limited turn exits 0 and emits a normal `assistant` message + `result` with `is_error: true`, `api_error_status: 429`, and the human-readable text ("You've hit your weekly limit · resets …"), with `error: "rate_limit"` on the assistant event. Auth failure looks the same with `error: "authentication_failed"`. The adapter's error handling is therefore mostly *reading the result event*, not exit-code plumbing.
- **`--bare` also skips auth loading** ("Not logged in · Please run /login" despite a logged-in CLI) — confirming we must never pass it (we already wanted the full harness for CLAUDE.md/MCP loading).

### Claude-specific scope for milestone A

Adapter interface stays harness-agnostic (the normalized event model above); only `claude-streamjson.ts` is implemented. The `'embedded'` dispatch rung, session endpoints, SSE channel, and activity feed are all adapter-independent — Codex/Cursor later means one new file each plus the approve-tool equivalents they natively provide.

## Suggested phasing (if pursued)

1. **Spike (throwaway):** drive `claude -p` stream-json by hand from a script at the project root; confirm turn flow, our MCP tools loading in the child session, `--permission-prompt-tool` round-trip through our MCP bin, resume, and reproduce/handle the hang with a watchdog.
2. **M-next A — "quick-apply, resurrected":** session manager + Claude adapter + minimal *activity feed* in the overlay (no free-form chat yet); `'embedded'` dispatch rung. Independently useful: Send now has a zero-setup, 100%-delivery path.
3. **M-next B — chat surface:** free-form input, message history, approval prompts, session resume across dev-server restarts.
4. **M-next C — remaining adapters:** Codex (`app-server --stdio`), then Cursor (`agent acp`).

## Decisions (user-ratified 2026-07-09)

- **Claude Code first**; Codex (`app-server --stdio`) and Cursor (`agent acp`) follow later.
- **Embedded session is the new primary path** — "one or the other", not two parallel modes. The keystroke ladder / dispatch-to-terminal-session remains as the fallback when no embedded session is live, not as a co-equal mode.
- **Activity feed first**: milestone A ships streamed progress + approval prompts, no free-form chat input; the chat surface is the following milestone.
- **Permission posture: auto-allow file edits in the project, prompt in the overlay for Bash and everything else** (static allow-rules + `--permission-prompt-tool` for the rest).
