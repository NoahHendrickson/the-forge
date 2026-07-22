# Orchestrator pivot — exploration & research

**Date:** 2026-07-22
**Status:** Exploration — no decisions made. This doc is brainstorm input for Noah, not a ratified spec.
**Idea (Noah's framing):** pivot The Forge toward a fuller agentic-coding orchestration tool — left sidebar of projects, center chat, right design panel (click-to-preview, Cursor-design-mode-ish) — while still driving external harnesses (Claude Code / Codex / Cursor), never being a harness ourselves.

Four research streams feed this doc: (1) the orchestrator-UI landscape, (2) harness driving surfaces, (3) design-mode/preview-embedding precedents, (4) an audit of what our own codebase already gives us. Findings first, then approaches, then open questions.

---

## 1. What the pivot actually changes

Today The Forge is a **plugin that lives inside the user's app**: the overlay, panel, and chat all render in a shadow DOM injected into the running page; one project, one dev server, one embedded session. The pivot inverts the topology: **The Forge gets its own surface** (a workspace app), and the user's running app becomes content *inside* it.

This is the second relaxation of the original constraints, and it's bigger than the first:

- 2026-07-09 (embedded sessions): *"never a new chat surface"* → relaxed to an in-overlay chat.
- This pivot: *"complementary, never a replacement / never owns your workflow"* → a standalone workspace **is** a workflow surface. It still never replaces the harness (hard constraint intact: subscription CLIs only, no API keys, no Agent SDK) — but it competes with Conductor/Claude-desktop-class apps, not just with "paste into your terminal."

Everything else survives untouched: deterministic token-first change requests, zero production footprint, zero idle overhead, the MCP queue loop, the per-project dev-server plugin.

## 2. Landscape — who's doing this, who died doing it

Full survey with sources in the research agent output; the load-bearing facts:

**The shakeout (early 2026).** Terragon shut down (Jan), Omnara archived (Feb), Crystal deprecated (Feb, → Nimbalyst), Vibe Kanban shut down (Apr — thousands of daily users, no monetization). Meanwhile both vendors shipped first-party orchestrators: the rebuilt Claude Code desktop app (Apr 2026: project-grouped session sidebar, Local/Worktree/Cloud environment picker per session, Routines) and the OpenAI Codex desktop app (Feb 2026: parallel sandboxed agents, shared review queue). **The generic "sidebar of worktree sessions + chat" UI is now commoditized and owned by first parties.**

**Survivors differentiate on a moat:** Conductor (native Mac, venture-backed, review-path-as-first-class-object: every run ends diff → PR → merge → archive), Sculptor (Docker-container isolation + Pairing Mode), cmux (native terminal fidelity), Nimbalyst (visual editors — but for *artifacts*: mockups/diagrams/markdown, not the live app).

**The whitespace is exactly our loop.** Element-as-*context* is done (Vibe Kanban's "select element as context", stagewise, Cursor Design Mode's element capture). Visual *editing* exists as standalone tools (Onlook, v0 Design Mode, Lovable Visual Edits). But **no orchestrator has select → edit-with-live-preview → deterministic token-aware change request → agent applies → computed-style verification.** Cursor Design Mode routes *everything* through the agent (no deterministic path); v0/Lovable/Onlook have deterministic style paths but zero orchestration and (mostly) cloud-only apps. Orchestrator × true design mode on *your own* app is unoccupied.

**Cautionary lessons from the graveyard:**
- Omnara's post-mortem, verbatim reason for archiving: PTY-wrapping the Claude Code CLI "became unfeasible to maintain with Claude Code's constant updates." Structured protocol seams (stream-json, ACP, app-server) are the survivable interface — the bet our `SessionAdapter` layer already made.
- Free + BYO-subscription + no moat = dead. The design-mode surface is precisely the moat the graveyard lacked.
- Pure cloud orchestration got absorbed by first parties the moment they shipped.

## 3. Harness driving surfaces — what we'd build the chat column on

State as of mid-2026 (sources in agent output; all compatible with subscription-only):

- **Claude Code:** stream-json remains the surface, but there is now a full **in-band control protocol** on the same stream — `--permission-prompt-tool stdio` enables `can_use_tool` (approvals answered on stdin, no MCP round-trip), `interrupt`, and `set_permission_mode` mid-session. This could replace our `approve` MCP tool and give real mid-turn interrupt. Resume semantics are now documented (`--fork-session`, worktree-aware session lookup, explicit warning that double-resuming one session interleaves transcripts). A `--sdk-url` WebSocket mode exists but grew a hostname allowlist in May 2026 — don't build on it.
- **Codex:** **`codex app-server`** (JSON-RPC over stdio; thread/turn/item model; first-class approval requests; `turn/steer`, `turn/interrupt`, `thread/resume`/`fork`) is the clear C2 adapter target — it's what OpenAI's own IDE extension sits on, and its event model maps almost 1:1 onto our `SessionEvent` union. `codex proto` is gone from the CLI reference; `codex mcp-server` is too coarse for a live feed.
- **Cursor:** ACP now officially documented; our adapter's contract is unchanged, but Cursor added blocking extension methods (`cursor/ask_question`, `cursor/create_plan`) — an adapter that hard-fails on unknown methods will break.
- **ACP:** spun out of Zed into its own org; ~40 agents speak it natively (Gemini CLI, Copilot CLI, Goose, Cline…) — but **Claude Code and Codex are adapter-only**, and their first-party surfaces are richer than the community ACP adapters (Claude's ACP adapter rides the Agent SDK, which our constraint excludes). Verdict: keep native adapters per harness behind `SessionAdapter`, treat ACP as the shape we normalize *to*, revisit if Anthropic/OpenAI ship native ACP.
- **Concurrency:** every CLI converged on **git-worktree-per-concurrent-agent** as the isolation primitive; none offer real same-directory concurrent-write safety. Claude Code has the best story (per-session JSONL, worktree-aware resume); Codex CLI has no native worktree support (the app does).

## 4. What we already have — portability audit

Full module-by-module map in the audit output. The shape of it:

**Ports as-is (no host-page assumption, already N-instance-safe):**
- The entire session layer: `SessionManager`, `ClaudeAdapter`, `CursorAdapter`, `ApprovalRegistry`, `createForgeRuntime`. **No singletons, no module globals — one process can host a `Map<projectRoot, ForgeRuntime>` today with zero refactor.** This is the audit's biggest finding: the hub's hardest-looking layer already exists.
- `Queue`, `WatcherHub`, dispatch ladder, endpoint discovery (`mcp/discover.ts` is already multi-endpoint: enumerate live per-pid endpoint files, filter, pick — a hub can run it across N project dirs).
- `shared/chat-constants.ts`, `shared/guardrails.ts`, the `ui/*` factories, pure helpers.

**Re-hostable with small changes (self-contained DOM, needs mount + CSS + networking seam):**
- **The whole chat surface**: `session-feed.ts` (bubbles, streaming, tool/diff rows, approvals, composer) builds its own DOM, touches zero host elements, and already takes injectable `fetchFn`/`headers` — pointing it at an absolute/proxied URL is a one-line change. Plus `composer-config`, `composer-send`, `changelist` (widget), `colorpicker`, `tokenpicker`, `feed-anchor`, `feed-divider`, the `overlay.ts` CSS string + token block (portable stylesheet).

**Host-page-coupled (stays inside the running app, becomes the "satellite"):**
- Selection (`index.ts` capture-phase document listeners, `source.ts` tag walking), preview (`drafts.ts` inline-style mutation), measurement (`inspector.ts`, `ripple.ts`, `verifier.ts` element re-location), token reading (`tokens.ts` reads the app's stylesheets), canvas (`<body>` transform), dock margin push, the fixed-position outline layer in host-viewport coordinates.

**Missing (new build):** the hub process, a cross-origin story (see §5), secret brokering (secrets live in `0600` endpoint files a browser can't read — the hub, a local node process, can), a projects registry + dev-server lifecycle, the shell↔satellite RPC bridge, and re-projecting the design panel against an element that lives in an iframe.

**The two real blockers:**
1. **Same-origin is baked into the security model.** `endpoints.ts` hard-403s when `Origin !== Host` and never sets CORS headers (deliberately — security finding 4); the secret is only delivered by same-origin `client.js` bootstrap. A cross-origin shell is rejected before it can authenticate. Cleanest dissolution: the hub **reverse-proxies** each project runtime under the shell's own origin (`localhost:<hub>/p/<id>/__the-forge/*` → dev server), same trick as Next's sidecar rewrites — the middleware already honors `X-Forwarded-Host` for exactly this pattern.
2. **The edit/preview mechanism is direct host-DOM manipulation** and cannot reach across an iframe boundary. It doesn't need to — the satellite pattern (below) keeps it in-frame.

Also flagged: `src/client/index.ts` (1031 lines) currently fuses the re-hostable chat wiring and the host-coupled selection wiring in one class — the shell/satellite boundary would have to be threaded through it. That refactor is prerequisite work regardless of which approach wins.

## 5. Embedding the running app — how everyone solves it

The precedent research converges on one pattern, and we're unusually well-positioned for it:

- **Onlook** (the closest architectural cousin, open source): cross-origin preview iframe + a **preload script injected into the user's app** + Penpal (typed promise-RPC over postMessage). Selection/hover/DOM-mutation/mutation-observation live *inside* the frame; panel state, canvas, chat live in the parent shell. **Our injected client is already 80% of that preload script** — the pivot is "move the panel/chat UI to the parent, put a typed postMessage bridge where the shadow-DOM boundary is today."
- **Iframe the dev server's real origin; don't proxy the app.** HMR websockets just work when the iframe URL is the dev server's own origin; proxying the app through the shell's origin breaks WS/asset paths and is fragile. (Proxy the *runtime endpoints* through the hub, not the app itself.)
- **Serve the shell from localhost.** MightyMeld — a 2023-24 product with literally this architecture (cloud studio iframing `localhost:3000` via a local runtime package) — was broken by Chrome's third-party-cookie phaseout: cookies set by an iframed localhost app are third-party to a hosted shell domain. A localhost shell dodges the whole class. Auth-heavy apps and service workers still behave differently iframed vs tabbed (storage partitioning) — keep **"open in real tab"** as an escape hatch, where the current in-app overlay mode *is* the fallback.
- **Frame-blocking headers:** Vite/Next dev servers send no `X-Frame-Options`/`frame-ancestors` by default, and where a user's middleware adds them, we're *inside* the dev server and can strip them in dev — an advantage no external shell (Cursor, Figma Make) has.
- Cursor Design Mode and Figma Make both dodge browser restrictions with a desktop webview and route **all** edits through the agent. v0/Lovable/Onlook keep a deterministic non-LLM path for style edits. Our deterministic token-first pipeline puts us in the second camp — that stays the differentiator.
- Multi-preview canvases exist (Onlook: multiple iframes of one project across pages/devices/*branches*), but "several different projects' dev servers on one canvas" is genuinely unshipped space.

## 6. Approaches

### A — Local hub + browser workspace ("`forge studio`") — recommended

A new hub process (`npx forge-mode studio`, or a `studio` rung inside the existing bin) that:

1. **Owns a projects registry** (explicitly added roots + `discoverEndpoint` across them) and optionally starts/stops each project's dev server.
2. **Hosts per-project runtimes**: `Map<projectRoot, ForgeRuntime>` — the audit confirms this works today. Two sub-topologies, decidable later: hub *proxies to* the dev-server-embedded runtime when one is live (T1, cheapest, session dies with the dev server), or hub *owns* the session runtime itself so you can chat about a project whose dev server isn't running (T2, the real orchestrator feature, needs an ownership-handoff rule for `queue.json`/`session.json` between hub and dev-server runtime).
3. **Serves the workspace shell** at `localhost:<port>`: left = projects (status, harness, session state — cmux-style ambient status); center = chat (the re-hosted `SessionFeed` + composer, per-project); right = design panel; canvas area = iframe(s) of the selected project's dev server at its real origin.
4. **Reverse-proxies runtime endpoints** under its own origin (`/p/<id>/__the-forge/*`) so the shell stays same-origin with every runtime — no CORS relaxation of the existing security model; the hub reads secrets from the `0600` endpoint files server-side.
5. **Talks to the in-iframe satellite** (today's injected client, minus the panel/chat it no longer renders) over a typed postMessage RPC: selection events up, draft-apply/outline commands down. Selection, drafts, ripple, tokens, verifier, canvas-body-transform all stay in-frame where they already work.

Pros: multi-project from day one; keeps the plugin's standalone in-app mode intact (same satellite, two masters); every layer reuses audited code; localhost shell dodges the cookie trap; zero-new-runtime-deps holds (hand-rolled RPC, same posture as our hand-rolled MCP). Cons: it's a real second product surface — new bundle, new budget line, the `index.ts` split refactor, and a long tail of shell UX (project add/remove, dev-server lifecycle, error states).

### B — Grow the overlay in place (workspace mode inside the host app)

Keep everything in-page; canvas mode already owns the whole viewport, so add a projects rail + docked chat column *inside* the existing shadow DOM and call it a workspace. Pros: no new process, no origin work, smallest diff. Cons: **cannot do multi-project** — the overlay lives inside one app's page and one dev-server origin; "projects on the left" would be links that navigate away, losing all state. This is a dead end for the stated idea; its only role is as the escape-hatch mode A already keeps.

### C — Desktop app (Electron/Tauri)

What Conductor/Cursor/Figma Make do: a webview dodges every browser restriction, and the shell can spawn CLIs directly. Pros: strongest embedding story, native feel, the genre's table stakes. Cons: new stack, distribution/update burden (Onlook's stated reason for *abandoning* Electron), duplicates what the hub gives us for free locally, and torches the lightweight `npx`-installable identity. Not now; note that approach A's hub+shell could later be *wrapped* by Tauri with the architecture unchanged.

**Recommendation: A**, staged so each milestone is independently shippable, with B's in-app overlay preserved as the satellite's standalone mode and C deferred as a possible future wrapper.

## 7. Sketch of a staged path (if A is chosen)

- **O0 — seams (no behavior change):** split `src/client/index.ts` into shell-side wiring vs host-side wiring; base-URL-aware fetch everywhere (`verifier.ts`, `watch.ts`, `index.ts`); define the satellite RPC message set on paper.
- **O1 — hub + chat column:** `forge studio` process, projects registry, per-project runtime hosting/proxying, shell with sidebar + re-hosted chat (no preview embed yet). Proves multi-project orchestration. Codex C2 adapter (`codex app-server`) lands here-ish — three harnesses makes the orchestrator story real.
- **O2 — embedded preview + selection:** iframe canvas, satellite RPC bridge, click-to-select streams element context into the shell composer (parity with the best of the dead competitors, on our own loop).
- **O3 — design panel in the shell:** inspector/drafts/verifier driven over RPC; the full deterministic loop, cross-frame. This is the moat milestone.
- **Later:** multi-frame canvas (pages × devices × branches, Onlook-style), worktree-per-session environments (the first-party genre standard; conflicts with "preview = live working tree", so likely an *option* per session, not the default), Claude Code in-band control protocol migration (replaces the `approve` MCP tool; independent of the pivot and valuable either way).

## 8. Tensions & risks to weigh

1. **Product identity.** README line one is "in your own browser, in your own app… never owns your workflow." A workspace app owns a workflow. The honest framing: the *plugin* stays complementary; the *studio* is an optional orchestration layer on top of it. That's still a real repositioning against first-party desktop apps — our wedge is the design loop they don't have, not the session sidebar they do.
2. **First-party absorption risk.** Cursor Design Mode is one release away from "good enough" for many users; Anthropic's desktop app could grow a preview pane. The deterministic/verified/token-aware loop and framework-native tagging are the defensible parts — speed matters.
3. **Maintenance treadmill.** Omnara died of CLI churn. We're on the structured seams (stream-json, ACP, app-server next), with recorded-fixture tests — the right posture, but three harnesses × a hub × a satellite protocol is real surface area for a solo project.
4. **Constraint accounting.** Zero runtime deps: holdable (hand-rolled RPC + static shell). Budgets: the 320KB package / 250KB client budgets don't fit a studio shell — needs an explicit new budget line, not silent growth. Zero idle overhead: applies to the satellite in the user's app, not the studio (user-launched).
5. **Session-vs-worktree model mismatch.** Design mode wants the live working tree (that's what the dev server renders); orchestration convention wants worktree isolation per parallel session. v1 should stay working-tree (one session per project, as today) and treat worktrees as a later per-session environment option — copying the Claude desktop picker, not fighting it.

## 9. Open questions for Noah

1. **Identity:** is the studio *the* product going forward, or an optional companion to the plugin? (Affects README, naming, where effort goes.)
2. **Runtime topology:** T1 (hub proxies to dev-server runtimes; chat requires a running dev server) first, evolving to T2 (hub owns sessions; chat works dev-server-down)? Or straight to T2?
3. **Scope of v1 chat:** one session per project (today's model), or parallel sessions/worktrees in scope early?
4. **Does the in-app overlay stay a first-class standalone mode forever** (my assumption above), or eventually satellite-only?
5. **Packaging:** `forge-mode studio` subcommand in the existing package vs a separate package (budget/marketing implications)?
6. **Sequencing vs C2:** Codex adapter before, during, or after O1?

---

*Research agent outputs (landscape, harness surfaces, embedding precedents, portability audit) were produced 2026-07-22; source URLs inline above where load-bearing. Unverified third-party claims are flagged in the agent outputs (e.g. Conductor's internal stack).*
