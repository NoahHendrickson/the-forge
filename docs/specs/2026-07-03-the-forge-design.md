# The Forge — Design Doc

**Date:** 2026-07-03
**Status:** Draft for review
**Working name:** `the-forge` (name TBD)

## 1. Overview

A designer-facing "design mode" that overlays any locally running web app with a Figma-style properties panel. Visual edits (spacing, size, radius, color, typography, …) preview live on the real DOM, then get packaged as structured, token-aware change requests and handed to the coding agent the user already runs — Claude Code, Cursor, or Codex — which applies them to real source code.

### Goals

- **Complementary, not a replacement.** The user keeps their existing agent, session, subscription, config (CLAUDE.md, skills, MCP servers, rules). The companion feeds it; it never owns the workflow. Uninstalling the companion breaks nothing.
- **Agent-agnostic.** One change-request format, per-agent dispatch adapters. Claude Code first; Cursor and Codex are fast-follows.
- **Subscription-safe.** All agent integration goes through the official CLI binaries or the user's already-running session — never embedded SDKs or raw API keys. `claude -p` headless, `cursor-agent`, and `codex` CLI all run on the user's existing plan auth.
- **Deterministic edits.** Change requests carry exact source locations and before→after deltas snapped to the project's design tokens (`p-2 → p-4`, not `8px → 16px`), so agent application is near-mechanical and verifiable.
- **Figma-parity aim** for the properties panel (see §6). Full parity is not required for v1, but the panel's information architecture should mirror Figma's right-side Design tab so it feels immediately familiar.

### Non-goals

- Not an IDE, not a browser, not an agent. (stagewise's pivot into an agentic IDE is the cautionary tale — we explicitly stay a companion.)
- No production/remote sites — localhost dev servers only.
- No design-file (Figma import/export) features.
- v1 does not attempt Vue/Svelte/Angular, webpack/Turbopack, or non-Tailwind styling systems (architecture leaves room; see §10).

## 2. Primary user story

A product designer runs `npm run dev` on a React + Vite + Tailwind project and starts the companion. A toolbar appears over the app. They click a button, and a properties panel shows its current values with source location (`Button.tsx:42`). They drag padding from 10 to 12, round the corners, bump the font size — every change previews instantly. They flip the before/after toggle to compare, then hit **Send**. In their already-open Claude Code terminal, the agent picks up the request and edits the real files; the dev server hot-reloads; the companion verifies the computed styles now match and marks the edits **Implemented**.

## 3. Architecture

Three pieces, installed with one command (`npx the-forge` from the project root):

```
┌─────────────────────────── browser (localhost) ───────────────────────────┐
│  user's app                                                               │
│  ├─ data-dc-source="src/Button.tsx:42:8"   ← injected by build plugin     │
│  └─ toolbar overlay (shadow DOM)                                          │
│      ├─ element selection + inspector                                     │
│      ├─ properties panel (Figma-style)                                    │
│      ├─ draft preview engine (inline styles)                              │
│      └─ WebSocket ──────────────┐                                         │
└─────────────────────────────────┼─────────────────────────────────────────┘
                                  │
┌──────────────── companion CLI (local process) ──────────────────┐
│  ├─ change-request queue (persisted to .the-forge/)      │
│  ├─ token mapper (reads Tailwind config / CSS vars)             │
│  ├─ screenshot capture                                          │
│  ├─ MCP server (stdio/HTTP) — tools: pull_design_edits,         │
│  │    mark_applied, get_element_context                         │
│  └─ dispatch adapters ──→ Claude Code / Cursor / Codex          │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 Build plugin (`@the-forge/vite`)

- Vite plugin, one line in `vite.config.ts`.
- Dev-mode only. Injects `data-dc-source="<relative-file>:<line>:<col>"` on every JSX element (Babel/SWC transform), plus the toolbar script into `index.html`.
- Rationale: build-time attribute injection is the only source-mapping approach that survived React 19's removal of `_debugSource` and is proven near-framework-agnostic (code-inspector-plugin model). Runtime fiber inspection is used only as enrichment (component display names, props) — never as the mapping spine.

### 3.2 Toolbar overlay

- Injected script; renders in a shadow root at max z-index so app CSS can't touch it (stagewise/VisBug pattern).
- **Select:** hover outlines + click to select (Figma-style; alt-click to drill into nested elements). Reads `data-dc-source`, computed styles, and Tailwind classes off the element.
- **Edit:** panel controls write inline styles to the element for instant preview. Nothing touches source at this stage.
- **Draft state machine per edit:** see §5.
- Talks to the companion CLI over WebSocket (edits out; status/verification in).

### 3.3 Companion CLI

- Node process started alongside the dev server; owns everything that needs filesystem or process access.
- **Token mapper:** loads the project's Tailwind config/theme and CSS custom properties; converts raw CSS deltas to the nearest token (`padding: 12px → p-3`), falling back to arbitrary values (`p-[13px]`) with a flag in the change request.
- **Queue:** pending change requests persisted under `.the-forge/` (gitignored) so nothing is lost if the agent isn't running yet.
- **MCP server:** registered into the project's agent config at init (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`). Tools:
  - `pull_design_edits` — returns and claims pending change requests
  - `mark_applied(ids, commit-ish?)` — agent reports completion
  - `get_element_context(id)` — full descriptor + screenshots for one edit
- **Slash command install:** writes `/design` into `.claude/commands/`, `.cursor/commands/`, `~/.codex/prompts/` — body: "call pull_design_edits and apply each change exactly as specified; then mark_applied."
- **Verifier:** after HMR reload, re-reads computed styles of affected elements and compares against the requested deltas; flips edits to Implemented / flags mismatches.

## 4. Change-request format

One request = one batch of edits (a "send"). JSON on the wire and in the queue; rendered as readable markdown when delivered through prompt-based channels.

```jsonc
{
  "id": "dc_01H...",
  "createdAt": "2026-07-03T19:40:00Z",
  "edits": [
    {
      "element": {
        "source": { "file": "src/components/Button.tsx", "line": 42, "col": 8 },
        "component": "Button",                  // fiber displayName, enrichment
        "selector": "button.btn-primary",       // fallback context
        "text": "Add mod"                       // fallback context
      },
      "changes": [
        {
          "property": "padding-block",
          "before": { "css": "10px", "authored": "py-2.5" },
          "after":  { "css": "12px", "authored": "py-3", "tokenExact": true }
        }
      ]
    }
  ],
  "screenshots": { "before": ".the-forge/shots/dc_01H_before.png",
                    "after":  ".the-forge/shots/dc_01H_after.png" },
  "instructions": "Apply exactly the authored-value changes. If a change conflicts with a variant/prop system, prefer the project's convention and explain."
}
```

Design decisions:
- **Deterministic-first, intent-as-backup.** The `authored` before/after is the ask; screenshots + selector/text give the agent recovery context if the file drifted since capture.
- `tokenExact: false` marks values that didn't snap to the token scale — a nudge for the agent (and the user) that a magic number is entering the codebase.

## 5. Edit lifecycle: Draft → Sent → Implemented

Per-edit state machine, surfaced in the panel and as subtle badges on edited elements:

1. **Draft** — applied as inline styles only. The **before/after toggle** (panel button + keyboard shortcut) flips between original and drafted appearance by suspending/restoring the inline styles — original values are always retained, so this is O(1) and exact. Toggle works per-element and globally ("view original").
2. **Sent** — batched into a change request, queued, dispatched. Inline preview stays on so the app keeps looking like the draft while the agent works.
3. **Implemented** — agent called `mark_applied`, HMR fired, and the verifier confirmed computed styles match the request. The companion then removes its inline styles (the real code now produces the look). Before/after toggle remains available post-implementation by re-applying the recorded *before* values — cheap and useful for review.
4. **Mismatch** (exception path) — verification failed (agent chose a different value, or another change interfered). Edit flagged in the panel with expected vs. actual; user can re-send or dismiss.

## 6. Properties panel — Figma parity map

Aim: mirror Figma's right-side Design tab section-for-section. Tiering by web feasibility:

| Figma section | Web equivalent | Tier |
|---|---|---|
| Auto layout (direction, gap, padding, alignment) | flex/grid direction, `gap`, `padding`, justify/align | **v1** |
| Size (W/H, min/max) | `width`/`height`/`min-*`/`max-*` | **v1** |
| Appearance: opacity, corner radius (incl. per-corner) | `opacity`, `border-radius` per-corner | **v1** |
| Fill (solid) | `background-color`, `color` — token-aware color picker | **v1** |
| Stroke | `border` width/color/style, per-side | **v1** |
| Typography | family, weight, size, line-height, letter-spacing, align, transform | **v1** |
| Effects: drop/inner shadow, layer/background blur | `box-shadow`, `filter: blur`, `backdrop-filter` | v2 |
| Fill (gradients, images) | gradient editor, `background-image` | v2 |
| Position (x/y, rotation) | `transform`, absolute positioning where already used | v2 (partial) |
| Selection colors | aggregate color list for multi-select | v2 |
| Blend modes | `mix-blend-mode` | v3 |
| Constraints, vector/boolean ops, export | no clean web-editing equivalent | out of scope |

Panel principles: numeric scrubbing (drag on labels), token dropdowns beside raw inputs (the Tailwind scale is the picker's spine), multi-select applies to all selected elements, and every control shows the *authored* value (`p-3`) with the computed value (`12px`) as secondary text.

## 7. Dispatch layer

Per-agent adapters behind one interface, with graceful degradation. User picks the active agent in the toolbar; **Send** always queues first, then dispatches:

**Claude Code**
1. *Channels adapter (experimental):* if the session was launched with the companion's channel enabled (preview: requires `--dangerously-load-development-channels`; companion ships a `dc claude` launcher alias), push the change request straight into the running session. Zero keystrokes.
2. *Terminal injection:* if a Claude Code pane is found in tmux (or via AppleScript for iTerm/Terminal on macOS), type `/design` + Enter into it. Zero keystrokes, fragile-but-fine for personal use; failure degrades to (3).
3. *Manual pull:* toolbar shows "N edits pending — type /design in Claude Code."

**Cursor:** deeplink (`cursor://anysphere.cursor-deeplink/prompt?...`) pre-fills the change request in the open chat pane; user presses Enter (Cursor never auto-executes deeplinks — hard floor). Fallback: `/design` command + MCP pull.

**Codex:** terminal injection (`/design` custom prompt) → manual pull fallback.

**Quick-apply mode (optional, off by default):** companion spawns `claude -p --resume <session>` (or `cursor-agent`/`codex exec`) itself and streams progress into a minimal activity feed in the toolbar. Same CLIs, same subscription; exists for "no session open, just fix the padding" moments. Deliberately not the primary mode.

**Universal floor:** "Copy as prompt" button — the change request as markdown on the clipboard.

## 8. Subscription & harness constraints (hard requirements)

- Integrate only via: the user's running session (MCP/slash/Channels/deeplink/injection) or official CLI binaries (`claude`, `cursor-agent`, `codex`).
- Never embed the Claude Agent SDK or ACP adapters that wrap it (API-key billing; subscription-auth gray area). Re-evaluate if Anthropic's policy changes.
- Spawned sessions run in the project cwd so the full harness loads (CLAUDE.md, skills, MCP, hooks).

## 9. v1 scope and milestones

Stack: React 18/19 + Vite + Tailwind (v3/v4). Agent: Claude Code. Testbed: one of the user's repos (e.g. `DIM-filterUI` or `portfolio` — portfolio is Vite; confirm).

1. **M1 — See:** Vite plugin injects source attributes + toolbar; hover/select; inspector shows computed + authored values + source location. (Proves the mapping spine.)
2. **M2 — Edit:** v1 panel sections (§6); draft preview engine; before/after toggle.
3. **M3 — Package:** token mapper; change-request builder; screenshots; queue + `.the-forge/` persistence.
4. **M4 — Deliver:** MCP server + `/design` command; manual-pull flow end-to-end with Claude Code; verifier + Implemented state.
5. **M5 — Automate:** tmux/AppleScript injection; Channels experiment behind a flag.
6. **M6 — Broaden:** Cursor deeplink adapter; Codex adapter; quick-apply mode.

Each milestone is independently useful (M1 alone ≈ a better click-to-source; M2 ≈ VisBug with source awareness).

## 10. Performance principles (hard commitments)

- **Production impact: zero by construction.** The Vite plugin registers with `apply: 'serve'` — it does not run in `vite build`. No attributes, no toolbar, no bytes in production output. CI check asserts the prod bundle is byte-identical with the plugin present vs. absent.
- **Idle overhead: ~zero by design.** With design mode toggled off, the overlay holds no active listeners, observers, or timers. Dev-mode cost is limited to attribute bytes in the served bundle and one incremental transform in Vite's existing per-file pipeline (the Nuxt DevTools inspector / lovable-tagger precedent).
- **Previews bypass the framework.** Panel edits write inline styles directly — no React state, no re-render, no reconciliation. Slider-to-pixel latency is one frame.
- **No app reflow from chrome.** Selection outlines/badges render on the overlay's own fixed-position layer in the shadow root; hover hit-testing is rAF-throttled.
- **Heavy work stays out of the page.** Screenshots, token mapping, queue persistence, and dispatch run in the companion CLI process, only on Send.
- **Scope guard:** tagging limited to project `src/` by default (node_modules excluded); transform must preserve line numbers (source-map fidelity asserted in tests).
- **Perf test:** fixture app with several thousand DOM nodes; assert no dropped frames with toolbar idle and <16ms edit-preview latency with design mode active.

## 11. Risks & open questions

- **React 19 / ecosystem drift:** mitigated by owning the build-time transform rather than depending on React internals. SWC-based projects (Next.js) deferred to a post-v1 plugin.
- **Channels is a gated preview:** treated as an experiment behind a flag, never the only path.
- **Terminal injection fragility:** acceptable for personal use; always degrades to manual `/design`.
- **Tailwind v4 CSS-first configs:** token mapper must read `@theme` CSS, not just `tailwind.config.ts`. Verify early in M3.
- **Styles defined in CSS files (not utility classes):** v1 emits the delta with the element's source location and lets the agent decide where the change belongs; authored-rule attribution via CDP is a possible v2 (requires extension or debugger attach — revisit).
- **Open:** exact naming; whether M4's `/design` should auto-run via a `UserPromptSubmit` hook that surfaces pending edits whenever the user next messages Claude Code.
- **Open (M3, from handoff investigation 2026-07-03):** shared-component intent — when a drafted element is one of many instances of a component, the change request must record whether the designer means "this instance" or "all instances" (Figma-style prompt at send time). Also: change requests record viewport size + rendered state; styles sourced from CSS files (not the tagged line) rely on computed-delta + screenshots + verifier until authored-rule attribution lands.

## 12. Testing approach

- Unit: token mapper (px→Tailwind snapping, v3+v4 configs), change-request serialization, state machine transitions.
- Integration: fixture Vite app; Playwright drives the toolbar (select → edit → toggle → send), asserts queue contents; a scripted fake "agent" applies edits so the verifier path is testable without burning agent tokens.
- E2E (manual, per milestone): real Claude Code session against the testbed repo.
