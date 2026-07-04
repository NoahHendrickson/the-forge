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

## What can't be done (on purpose, theirs not ours)

No mechanism exists to inject a message into a **running** desktop-app conversation: no
AppleScript dictionary, no local API, no CLI, and MCP servers can't push turns. The desktop
app's security model is user-initiates, always. So the desktop story's floor is "one click
+ Enter", not "zero keystrokes". That's the honest trade to present: same loop, same
guarantees, one extra Enter.

## Proposed shape (if we do it) — for a later plan doc

1. `mcp/index.ts` — `--root`/env override for discovery root (S).
2. `protocol.ts` — `prompts` capability with the one `forge-design` prompt (S).
3. `agent.ts` / client copy / plugin option — add `'claude-desktop'` to `AgentName`, display
   name "Claude Desktop", manual-rung copy without the `/forge-design` phrasing (S).
4. `dispatch.ts` — `claude://` deeplink rung(s); `open` on macOS, `start`-equivalent on
   Windows (the Cursor rung is currently macOS-shaped too — fix both or scope to macOS) (M).
5. Setup story per decision below (S–L depending on choice).
6. Docs: README + CLAUDE.md MCP-contract section; new gotcha ("desktop app spawns the bin
   with arbitrary cwd — root must be explicit") (S).

Nothing touches the panel, drafts, request builder, queue, or verifier. Current terminal UX
is unchanged by construction — this is a new agent target plus one additive rung.

## Open design decisions (user call)

1. **Which path first?** A (Claude Code desktop rung — smallest change, current UX intact) or
   B (Cowork — new audience, new setup story), or A-then-B.
2. **Repeat-Send behavior:** always fire the deeplink (new window each Send) vs. deeplink on
   first Send then manual/prompt copy ("press + → forge-design in your Claude session") vs.
   a panel toggle.
3. **Setup UX for B:** printed instructions / npx setup command / `.mcpb` bundle.
4. **Global discovery mode** (one registration, all projects) vs. per-project entries.

## Verify live before planning (jsdom-rule equivalent: docs ≠ reality)

- `claude://code/new?q=%2Fforge-design&folder=…` — does a pre-filled `/forge-design`
  actually execute as a command when sent?
- Cowork + our stdio bin from global config: does `pull_design_edits` appear and work?
- Do Cowork's file edits trigger HMR normally (no atomic-write/watcher surprises)?
- Prompt surfacing: where exactly does a `forge-design` MCP prompt show up in the composer?
- Windows deeplink open command.

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
