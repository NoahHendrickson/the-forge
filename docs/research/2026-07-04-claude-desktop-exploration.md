# Claude Desktop app support — exploration (2026-07-04)

**Status: exploration / brainstorm input. Not a plan.** The question: the loop works great
against a terminal Claude Code session — what would it take to let users run the agent side
in the Claude desktop app instead, without changing the current UX?

Verdict up front: **feasible, and most of the loop carries over unchanged.** The queue, the
MCP tools, the change-request format, the verifier, and the entire panel UX are already
agent-agnostic. What does NOT carry over is the zero-keystroke nudge — there is no way to
type into a running desktop-app conversation the way tmux/AppleScript type `/forge-design`
into a terminal. The desktop-app equivalent is a **deeplink that opens a session with the
instruction pre-filled; the user presses Enter** — exactly the interaction we already ship
for Cursor, and already ratified by the spec's hard floor ("dispatch never submits on the
user's behalf").

## Two different things "Claude desktop app" can mean

The desktop app hosts two distinct session types, and they differ hugely in how much of our
existing machinery they pick up:

| | **A. Claude Code session in the desktop app** | **B. Cowork session (desktop agentic workspace)** |
| --- | --- | --- |
| What it is | The same Claude Code product, running in the desktop app instead of a terminal | The desktop app's own local-folder agent (writing/analysis-oriented, but can read/edit files) |
| Loads `.mcp.json` at git root | ✅ yes — it's Claude Code | ❌ no — only global `claude_desktop_config.json` (app restart to pick up changes) |
| Loads `.claude/commands/forge-design.md` | ✅ yes | ❌ no — no slash-command concept at all |
| Can edit project files | ✅ full | ✅ within an explicitly granted folder |
| Can be nudged while running | ❌ no tmux pane, no AppleScript dictionary | ❌ same |
| Can be *opened* pre-filled | ✅ `claude://code/new?q=<text>&folder=<root>` | ✅ `claude://cowork/new?q=<text>&folder=<root>` |
| Plan availability | Claude Code (all paid plans) | Pro/Max/Team/Enterprise |

Both deeplinks are **officially documented** (support.claude.com "Open Claude Desktop with a
link"; code.claude.com/docs/en/deep-links). `q` is URL-encoded, ~14,000-char limit — far more
than we need, since only the constant instruction text travels, never request content.

## Path A — Claude Code in the desktop app (low effort, near-full fidelity)

Everything already works except dispatch: the session auto-loads our `.mcp.json` entry and
the `/forge-design` command because it *is* Claude Code. The only gap is that the tmux and
AppleScript rungs can't see it (no pane, no terminal window). Today those rungs fall through
to `manual`, and the user types `/forge-design` themselves — so strictly, **Path A works
today** with a one-keystroke-plus-Enter cost.

To close the gap, add one rung to the claude-code ladder (after tmux/AppleScript fall
through, before manual):

- `open "claude://code/new?q=%2Fforge-design&folder=<projectRoot>"` — opens a Claude Code
  desktop session at the git root, `/forge-design` pre-filled; user presses Enter.

Caveat to verify live: each deeplink opens a **new** session, so on repeat Sends the user
accumulates sessions unless they ignore the new window and re-run `/forge-design` in the
one they have. That may argue for making this rung opt-in (see decisions below), or for
only firing it when no terminal session was found.

## Path B — Cowork (more work, reaches non-terminal users)

This is the "never opens a terminal at all" story. The pieces:

**1. MCP registration is global, not per-project.** Cowork bridges MCP servers from
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/…`, Windows:
`%APPDATA%\Claude\…`); it does not read our `.mcp.json`. Two consequences:

- The bin can no longer resolve `.the-forge/` from `process.cwd()` (the desktop app spawns
  it from an arbitrary cwd). Small fix: accept `--root <path>` argv / `THE_FORGE_ROOT` env,
  falling back to cwd. Worth doing regardless — it removes the "agent session must run at
  the git root" gotcha for every client.
- One global entry can only point at one project — unless the bin gets a **global discovery
  mode**: the plugin additionally registers each live dev server in
  `~/.the-forge/projects.json` (same per-pid liveness filtering as today's endpoint files),
  and a rootless bin serves the queues of *all* live dev servers. Then one registration
  works for every project forever. This is the elegant version; per-project entries
  (`the-forge-<name>`) are the dumb-but-shippable version.

**2. Setup UX.** Editing `claude_desktop_config.json` requires an app restart and is a
one-time, machine-global act. Options, in increasing invasiveness:
  - Print one-time setup instructions in the dev-server console (or a panel affordance).
  - A tiny `npx` setup command that writes the entry (additive merge, same care as our
    `.mcp.json` handling) and tells the user to restart the app.
  - Ship a `.mcpb` desktop-extension bundle (zip + manifest; one-click install in the app's
    Extensions settings). Nicest install, but a new build artifact + packaging pipeline.
  - Auto-write the global config from the plugin. **Recommend against:** every artifact we
    write today stays inside the repo; silently editing a global app config file crosses a
    line, and the restart requirement makes it half-useless anyway.

**3. No slash command — two replacements, use both:**
  - **Dispatch rung:** `claude://cowork/new?q=<instruction>&folder=<root>`. The `q` text is
    the full constant DESIGN_COMMAND body from `setup.ts` (~500 chars — the command file's
    pull → apply exactly → mark contract), since there's no `/forge-design` for Cowork to
    expand. Only constant text in the URL; request markdown never travels (stronger than
    the Cursor rung, which does carry content).
  - **MCP prompt:** expose `forge-design` via the `prompts` capability (`prompts/list` +
    `prompts/get` returning the same DESIGN_COMMAND text). The desktop app surfaces server
    prompts in the composer's `+` menu, so re-pulls in an *existing* session become
    click-click-Enter instead of a new window per Send. ~30 lines in our hand-rolled
    `protocol.ts`, zero new dependencies — the no-SDK constraint holds.

**4. File edits + HMR:** Cowork edits real files in the granted folder, Vite's watcher picks
them up, HMR fires, our verifier confirms computed styles — the back half of the loop needs
zero changes. The MCP bin runs as a host process spawned by the desktop app, so it reaches
`localhost:<port>` fine (Cowork's VM sandbox applies to its code execution, not to MCP
servers).

**5. Folder trust:** folders passed via deeplink arrive "untrusted" — Cowork asks the user
to grant access on first use. One-time friction per project; acceptable.

## Linked-session watch mode (user direction, 2026-07-04 — supersedes the deeplink options)

User decisions after reading the exploration: **Claude Code desktop app only — Cowork is
out of scope entirely.** And the repeat-sends dilemma (deeplink = new session per Send) is
not acceptable: once a user opts into the desktop app, *one* session should be where they
watch changes land. Terminal UX must remain byte-for-byte unchanged for everyone who never
opts in.

The proposed shape — the session volunteers instead of being typed at:

1. User opens a Claude Code desktop session at the project root and runs `/forge-watch`
   (a new plugin-installed command, sibling of `/forge-design`).
2. The command instructs the agent to call a new MCP tool `wait_for_design_edits` in a
   loop. The tool long-polls a new dev-server endpoint (e.g. `POST /__the-forge/wait`,
   secret-gated like the other mutating endpoints): the response is held open until a
   change request is queued or a timeout elapses.
3. Send in the panel → the parked wait returns instantly with the change request (claimed
   atomically, same queue semantics). The session applies, calls `mark_applied`, and
   resumes waiting. Zero keystrokes per Send — stronger than the tmux rung.
4. Dispatch gains a top rung: *linked session live → delivered, stop.* The long-poll IS the
   liveness signal (an in-flight wait, or one within the last ~35s, means linked). No
   watcher → fall through to tmux → AppleScript → manual, i.e. today's ladder untouched.
   This is the **channels stub made real** (`tryChannels` in dispatch.ts + backlog item 4)
   without waiting for the Claude Code Channels preview — the "companion channel" is just
   MCP long-poll.
5. Send-button/verifier copy for the linked rung: "delivered to your Claude Code session"
   (a true statement — delivery is confirmed by the wait response being consumed, unlike
   the fire-and-hope keystroke rungs).

Not desktop-specific, deliberately: a terminal session can run `/forge-watch` too and get
zero-keystroke sends without tmux. The desktop app is simply the surface where watch mode
is the only automated path.

**Change surface:** one long-poll endpoint (`endpoints.ts` — must hold a response open;
today's handlers are all request/response), watcher registry + `channels`-rung wiring in
`dispatch.ts` (the rung result type already exists), `wait_for_design_edits` in
`protocol.ts`/`mcp/index.ts` (zero-dep, fits the hand-rolled JSON-RPC), a `forge-watch.md`
command written by `setup.ts` (same additive/migration care), agent copy. Panel, drafts,
request builder, verifier: unchanged.

**Risks / verify live (in priority order):**

- **Loop endurance.** The agent must re-call the tool through idle stretches. MCP clients
  cap single-call block time (Claude Code: `MCP_TOOL_TIMEOUT`, default not under our
  control on user machines) — so each wait cycle must stay conservatively short (~25s),
  meaning an idle hour is 100+ cycles of context accretion, and the model may eventually
  conclude it's done and stop watching. Mitigations to test: standing re-arm instruction in
  every tool result; panel detects a dropped watcher (heartbeat gone) and surfaces "watch
  session disconnected — type /forge-watch again". A real soak test decides whether this
  ships; nothing else matters if the loop won't hold.
- **Token cost of the idle loop** (user-raised 2026-07-04). Parked waits cost nothing —
  tokens flow only at cycle boundaries, when the agent re-calls the tool. Each tick adds a
  tiny tool call + terse result (<100 fresh tokens), plus a transcript re-read that is
  almost entirely prompt-cache hits (25s ticks stay well inside the cache TTL). Envelope:
  an idle hour ≈ ~140 ticks, transcript grows to ~10–15k tokens, fresh spend on the order
  of a few tens of thousands of tokens — "a modest conversation gently idling". Cost
  scales with time watched, not edits sent; applying an edit costs the same on every
  dispatch path. The failure mode is the forgotten session (overnight watch = pure waste,
  with idle cost creeping up as context accretes). Design mitigations, to ratify in the
  plan: (a) **idle auto-stop** — after ~15–20 min with no edits the wait endpoint tells the
  agent to stop watching; panel shows "watch session idle — type /forge-watch to resume";
  bounds the worst case. (b) **End the watch when design mode toggles off** (a watch with
  no design session is useless by definition). (c) Longest safe wait window — the biggest
  lever; every doubling halves tick count (measure the real client timeout in the soak
  test). (d) Terse command text + terse tool results to minimize per-tick context growth
  and deliberation. Soak test must measure actuals: tick count, context growth, and
  usage-meter impact over an hour.
- **Tool-permission prompt**: first `wait_for_design_edits` call asks; user picks
  always-allow once. Document it in the command file's own text.
- **Occupied session**: while watching, that session can't be chatted with (Esc interrupts
  and ends the watch — which must degrade gracefully via the heartbeat, never error a Send).
- **Claim semantics**: a wait that times out returns nothing and re-arms; a wait that
  returns items claims them (existing claimed/stale-reclaim rules apply if the session dies
  mid-apply).

Deeplink rung (`claude://code/new`) is demoted to not-planned; kept in this doc only as
reference for what the platform offers.

## What can't be done (on purpose, theirs not ours)

No mechanism exists for an *outsider* to inject a message into a **running** desktop-app
conversation: no AppleScript dictionary, no local API, no CLI, and MCP servers can't push
turns. The desktop app's security model is user-initiates, always. Watch mode routes around
this cleanly rather than fighting it: the session isn't being pushed at from outside — it
*asked* (via a user-initiated command) to sit on a long-poll, and every "delivery" is
technically the response to a request the session itself made.

## Proposed shape — watch-mode milestone, for a later plan doc

1. `endpoints.ts`/`queue.ts` — long-poll `POST /__the-forge/wait` (secret-gated; holds the
   response until a queue item lands or ~25s elapses) + watcher-liveness registry (M).
2. `dispatch.ts` — make the channels rung real: linked-watcher-live → delivered (S; rung
   type, ladder position, and stub already exist).
3. `protocol.ts` + `mcp/index.ts` — `wait_for_design_edits` tool with a standing re-arm
   instruction in every result (S).
4. `setup.ts` — write `/forge-watch` command file (same additive/migration care as
   `/forge-design`) (S).
5. Client copy + watcher-state messaging (user-ratified 2026-07-04: the panel MUST tell the
   user when the watcher goes idle, so they know to wake it):
   - Persistent linked indicator in the panel while a watcher is live ("● Linked to
     Claude Code"). Ratifies former open decision #1 — required, since "watcher asleep"
     is only legible if linked state was visible in the first place.
   - The moment the watcher idles out or drops (heartbeat gone), the indicator flips:
     "Watcher asleep — type /forge-watch in Claude Code to wake it." Proactive, not
     discovered-at-next-Send.
   - Send with no watcher: flash + sent-status use the wake copy ("Sent — watcher asleep,
     type /forge-watch in Claude Code to apply") instead of the generic manual copy. The
     item is queued regardless; waking delivers everything pending — copy should convey
     nothing is lost.
   - Session-side mirror: the auto-stop tool result tells the agent to inform the user
     in-chat ("Watching paused after N idle minutes — run /forge-watch to resume") so
     panel and session agree on what happened.
   - Mechanism: watcher state rides the existing `/status` response (verifier already
     polls it); panel adds a light status poll while design mode is ON — compatible with
     the zero-idle-overhead constraint, which governs design-mode-off only. (M)
6. Docs: README, CLAUDE.md MCP contract, gotchas (S).

Nothing touches the panel, drafts, request builder, or queue semantics. Terminal UX without
a watcher is unchanged by construction — the new rung sees no watcher and falls through.

## Open design decisions (user call)

1. ~~Watch-session copy/framing~~ — RATIFIED 2026-07-04: persistent linked indicator +
   proactive "watcher asleep — wake it" messaging (see item 5 in the proposed shape).
   Exact wording still open for the plan/visual pass.
2. **Should `/forge-design` remain the documented manual path** in desktop sessions (it
   works there today — the session loads `.mcp.json`/commands normally), with
   `/forge-watch` as the recommended flow? (Proposed: yes, keep both.)

## Verify live before planning (jsdom-rule equivalent: docs ≠ reality)

- **Soak test the watch loop** in a real Claude Code desktop session: does the agent keep
  re-calling `wait_for_design_edits` across an idle hour? Where does it give up, and does
  the re-arm instruction hold? This decides whether the milestone ships at all.
- Actual MCP tool-call timeout behavior in Claude Code (default `MCP_TOOL_TIMEOUT`) — pick
  the wait window under it with margin.
- Esc-interrupt during a parked wait: confirm the server sees the disconnect and the
  heartbeat goes stale (no wedged claimed items; stale-reclaim covers a mid-apply death).
- Permission flow: exactly one always-allow prompt on first wait call.
- Desktop session at project root: confirm `.mcp.json` + `/forge-design`/`/forge-watch`
  load identically to the terminal (expected — it's Claude Code — but never proven live).

## Sources

- Deeplinks: support.claude.com "Open Claude Desktop with a link" (article 14729294);
  code.claude.com/docs/en/deep-links
- Desktop MCP config: support.claude.com "Getting started with local MCP servers" (10949351)
- Cowork: support.claude.com "Get started with Claude Cowork" (13345190), "Use Claude Cowork
  safely" (13364135); claude.com/docs/cowork/3p/local-access
- `.mcpb` desktop extensions: support.claude.com article 12922929;
  github.com/modelcontextprotocol/mcpb; anthropic.com/engineering/desktop-extensions
- MCP prompts capability: modelcontextprotocol.io spec (client-driven invocation; the desktop
  app lists server prompts in the composer `+` menu)
