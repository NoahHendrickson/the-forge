# Forge Studio — O0 (seams) + O1 (hub + multi-project chat) design

**Date:** 2026-07-22
**Status:** Draft for Noah's review — direction and structural decisions ratified 2026-07-22; this spec covers the first two milestones only.
**Research:** [docs/research/2026-07-22-orchestrator-pivot.md](../research/2026-07-22-orchestrator-pivot.md) (landscape, harness surfaces, embedding precedents, portability audit, ratified constraints §8b and decisions §9)

## 1. Overview

The studio is a **companion** to the plugin, not its replacement: `npx forge-mode studio` starts a local hub that serves a workspace shell at a localhost port — left sidebar of projects, center chat with each project's embedded agent session, (later) right design panel over an embedded preview. The plugin's in-app overlay stays a first-class standalone mode forever.

Unchanged hard constraints: subscription CLIs only (never Agent SDK / API keys), deterministic token-first change requests, zero production footprint, zero new runtime dependencies, zero idle overhead *in the user's app* (the studio itself is user-launched). Ratified studio constraints: trivial spin-up (one command, zero config), no responsiveness regression (hot paths stay in-frame), iframe perf first-class with measured gates per milestone.

Ratified structural decisions this spec implements:

1. **Hub owns sessions (T2).** The hub hosts each registered project's `SessionManager`; dev servers keep only the design-mode runtime. Sessions survive dev-server restarts (including agent-caused config-edit restarts) and chat works with no dev server running.
2. **One session per project** in v1, on the live working tree. Worktrees are a later per-session environment option.
3. **Companion identity** — no README repositioning beyond an optional-studio section.
4. Auto-start of dev servers is ratified but **lands in O2** with the preview embed; chat under T2 doesn't need it.

Out of scope for O0/O1: the preview iframe, satellite RPC implementation, the design panel in the shell, dev-server lifecycle management, worktrees, multi-frame canvas. The Codex adapter (C2) rides alongside O1 but has its own spec ([2026-07-11-codex-adapter-design.md](2026-07-11-codex-adapter-design.md)) — this spec only requires that nothing in the hub is harness-count-dependent.

## 2. Primary user story (O1)

Noah runs `npx forge-mode studio` once, anywhere. A browser tab opens on `localhost:4610`: the sidebar lists his forge-enabled projects (auto-discovered) with session-state dots. He clicks *portfolio*, types "tighten the hero spacing and commit" into the composer, and a Claude Code session spawns at that project's root — activity streaming into the center column exactly like today's overlay feed, approvals included. He switches to *stat-builder* and starts a second, independent session there while the first keeps running. Later he opens portfolio's dev server in a normal tab, toggles the in-app overlay, and its chat shows **the same session** the studio owns — one conversation, two views.

## 3. O0 — seams (no behavior change)

Pure refactor + one paper artifact. Everything here is prerequisite work the audit identified, valuable even if the studio stalls.

### 3.1 Transport seam

New `src/client/transport.ts`: `ForgeTransport` — `{ base: string; secretHeaders(): Record<string,string>; postJson(path, body); fetchStream(path, opts) }`. Today's behavior (relative URLs + `globalThis.__THE_FORGE__` secret) becomes the default instance; `verifier.ts`, `watch.ts`, and `index.ts` take it injected instead of calling relative `fetch` directly. `session-feed.ts` already takes injectable `fetchFn`/`headers` — it adopts the same type, no behavior change.

### 3.2 index.ts split

`src/client/index.ts` (1031 lines) splits along the audited boundary:

| Module | Responsibility |
| --- | --- |
| `index.ts` (stays) | `DesignMode` orchestrator: toggle, host-DOM selection wiring, drafts/ripple/verifier plumbing, overlay mount |
| `chat-wiring.ts` (new) | builds the chat cluster — `SessionFeed` + `ComposerSend` + `ChangeList` + config/approval/interrupt hookup — given a `ForgeTransport` and a small `ChatHostHooks` interface (the ~15 host callbacks the audit counted: outline-on-hover, select-by-source, drafts accessors, …) |

The shell (O1) calls `chat-wiring.ts` with a hub transport and no-op host hooks; the overlay calls it exactly as today. Class names, CSS hooks, and test files are unchanged — `tests/client/` suites keep passing without edits beyond import paths.

### 3.3 Satellite RPC message set (paper only)

A `## Satellite RPC v0` appendix in this spec's O2 successor is drafted now as a design sketch (shell→satellite: `select`, `outline`, `apply-draft`, `clear-drafts`; satellite→shell: `selection`, `element-snapshot`, `draft-state`, `verified`, `error`; versioned envelope, exact-origin checks both directions). Non-normative until O2; exists so O0's seam placement can be sanity-checked against it.

### 3.4 Sequencing note

PRs #42/#43 (chat-styles extraction, `chat-styles.ts`) are still unmerged; landing them **before** O1 is preferred — the shell reuses the chat CSS, and a shared `chat-styles.ts` module is the clean vehicle. If they don't land, O1 extracts the equivalent subset itself and #42/#43 rebase over it.

### 3.5 O0 gates

Full `npm test` green with no test-content changes; `check-prod-clean.sh` unchanged budgets; real-browser E2E smoke (toggle → select → scrub → send) shows byte-identical overlay behavior.

## 4. O1 — hub + multi-project chat

### 4.1 New modules

| Module | Responsibility |
| --- | --- |
| `src/cli/index.ts` (extend) | `forge-mode studio [--port]` subcommand — still the only file touching argv/exit; delegates to `src/studio/hub.ts` |
| `src/studio/hub.ts` | hand-rolled Node HTTP server (zero deps, same posture as the MCP server): serves the shell, mounts per-project runtime routes, owns the hub secret + bootstrap injection |
| `src/studio/registry.ts` | `~/.the-forge/studio.json` (0700/0600) read/write: `{ projects: [{ id, root, name, devCommand? }] }`; auto-discovery of forge-enabled roots (live `.the-forge/` endpoint files) + add/remove by path; dev-command sniffing reuses `src/cli/detect.ts`/`pm.ts` |
| `src/studio/projects.ts` | `Map<projectRoot, ForgeRuntime>` lifecycle — instantiates `createForgeRuntime` per registered project (audit-confirmed N-instance-safe), writes each project's hub endpoint + presence files, tears down on exit |
| `src/studio/presence.ts` | hub presence protocol (§4.4): per-project `.the-forge/hub-<pid>.json` write/refresh, and the liveness check the dev-server runtime uses |
| `src/studio-client/` | the shell bundle (`dist/studio.js` + static HTML): sidebar (registry + per-project session-state), center chat = `chat-wiring.ts` per project with a hub `ForgeTransport`; built from `ui/*` factories, chat styles, overlay design tokens |
| `src/server/handoff.ts` | dev-server-side: when a live hub is present, proxy queue/dispatch/session/approval endpoints to it (§4.4); otherwise byte-identical current behavior |

### 4.2 Routes & auth

Hub listens on `localhost:4610` (default; `--port` to override; fail-fast with a clear message on EADDRINUSE). Routes:

- `GET /` — shell HTML; `GET /studio.js` — shell bundle with `globalThis.__THE_FORGE_STUDIO__ = {secret}` bootstrap prepended (same mechanism as `client.js` today).
- `GET /studio/projects` — registry + per-project summary (session state, harness, last activity). Secret-gated.
- `/p/<id>/__the-forge/*` — dispatched **in-process** to that project's `ForgeRuntime` handlers (no HTTP hop; the runtimes live in the hub). Same handler code as `createForgeMiddleware`, mounted per project under the prefix.

Auth reuses the existing model wholesale: hub-wide random secret per start, `X-Forge-Secret` on mutating routes + event streams, `isAllowedHost` DNS-rebinding gate, Origin-vs-Host check (trivially satisfied — the shell is same-origin with the hub). **No CORS is introduced anywhere.**

### 4.3 Sessions under the hub

Each project's `ForgeRuntime` inside the hub spawns CLIs with `cwd` = that project's root, exactly as today — `SessionManager`, adapters, approvals, `session.json` slots all unchanged. The hub writes a standard `.the-forge/endpoint-<pid>.json` per project, so the MCP bin's newest-live-endpoint discovery naturally selects the hub as the queue/session authority; `pull_design_edits`/`mark_applied` work with no bin changes, dev server running or not.

### 4.4 The handoff rule (single-writer invariant)

The one new mechanism. Problem: with a hub and a dev server both alive on one project, two processes could own `queue.json`/`session.json` and spawn duplicate sessions.

- Hub presence: `projects.ts` writes `.the-forge/hub-<pid>.json` (`{port, pid, secret, startedAt}`, 0600) per registered project and refreshes its mtime periodically; removed on clean shutdown.
- Dev-server runtime (`handoff.ts`): on each mutating queue/dispatch/session/approval request — and on opening `GET /session/events` — check for a live hub (pid-alive + loopback, result cached ~2s). Live hub → **proxy the request to the hub** over loopback HTTP with the hub secret from the presence file (readable: same user), streaming responses through (the Next sidecar rewrites proxy already proves this pattern at 23ms). No live hub → serve locally, byte-identical to today.
- Net effect: single writer at all times; the overlay transparently shows the hub's session when the studio runs (the §2 "one conversation, two views" story); hub crash mid-flight degrades to local ownership on the next request. Stale presence files are ignored via pid-liveness, same rule as endpoint files.
- The hub never proxies *to* dev servers in O1 — design-mode traffic (overlay selection, drafts, status polling) stays entirely inside the dev server as today.

### 4.5 Budgets (proposed — confirm at plan time)

Package budget 320 → **380KB** (hub + shell ship in `dist/`); new gate: `dist/studio.js` ≤ **120KB** (it reuses the chat surface, not the panel/canvas). `check-prod-clean.sh` additionally asserts the studio leaves zero traces in consumer prod builds (it never touches them — the gate is a tripwire).

### 4.6 O1 gates

- Unit: registry round-trip + discovery; presence liveness (stale pid, refresh, clean removal); handoff proxy (local-vs-proxied selection, hub-death fallback, stream pass-through); hub multi-runtime isolation (two projects, interleaved events, no cross-talk); route auth parity with `endpoints.ts` tests.
- Full `npm test` green; budgets per §4.5.
- Real-browser E2E: two registered projects; spawn a session in each from the shell; interleaved chat turns stream correctly; then start one project's dev server, open the overlay, and verify it renders the same session the studio owns (handoff), including an approval round-trip through the overlay while the studio watches.

## 5. Risks & open items

- **Two processes, one disk state** is the sharpest edge: the handoff single-writer invariant must hold across hub crash, dev-server restart, and stale presence files. Mitigations: pid-liveness everywhere, per-request re-check, queue corruption already quarantines rather than discards. The handoff test family is the largest new suite for a reason.
- **Session ownership migration** (hub starts while a dev-server-owned session is mid-turn, or vice versa) is **explicitly out of scope for O1**: the running session finishes under its current owner; ownership is decided at spawn time. A "session already live under the other owner" state renders as an informative feed row, not a takeover.
- Port collisions / multiple hubs: one hub per user by convention; a second `studio` invocation detects the live hub and opens the existing URL instead of racing it.
- Windows remains untested (unchanged posture).
- C2 gating: the Codex adapter needs Noah's Codex subscription for live validation (per its own spec).

## 6. Testing approach

Mirrors house style: fixture-driven unit tests beside the code they cover (`tests/studio/`, `tests/server/handoff.test.ts`), fake-clock liveness tests, recorded-stream fixtures reused from the session suites for the shell's feed, and the real-browser E2E as the merge gate. jsdom cannot prove the shell's layout — the E2E rule from CLAUDE.md applies to the studio shell same as the overlay.
