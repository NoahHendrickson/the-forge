# Canvas mode — design

**Date:** 2026-07-11
**Status:** approved (brainstormed with user; scroll model, panel behavior, entry model, and approach user-ratified)
**Milestone:** canvas mode — pan/zoom the real page like a Figma canvas

## Goal

Give design mode an optional **canvas mode**: the running page becomes a full-height artboard sitting on a gray canvas that the user can pan and zoom, Figma-style — while remaining the real page, real code, real HMR. Motivation: the docked panel pushes content narrower; canvas mode lets the page lay out at full viewport width and the user simply pans/zooms to see any of it, including behind the panel.

## Scope (user-ratified)

- **Full-page artboard model.** In canvas mode the page renders at its full document height as one artboard; the document's own scrollbar goes away; wheel pans the canvas, pinch/ctrl-wheel zooms. Accepted trades: document-level sticky/scroll-triggered UI doesn't fire while canvas is on (nothing scrolls), and inner scrollable divs can't be wheel-scrolled until canvas mode is exited.
- **Panel stays docked — no floating panel.** The panel remains exactly as today: full-height, docked to the right edge, top to bottom. The only change is underneath it: the dock's `margin-right` push on `<html>` is suspended, the page lays out at full viewport width, and the canvas pans/zooms behind the panel.
- **Opt-in toggle inside design mode.** Design mode works exactly as today unless the user turns canvas mode on. Turning design mode off always restores the page fully.
- **Same client bundle on both frameworks** — nothing here is Vite- or Next-specific.
- **Out of scope:** selectable artboard widths / responsive preview (page lays out at the live viewport width, as today), multi-artboard, minimap, wheel passthrough to inner scroll containers.

## Approach (chosen: A — transform on `<body>`)

Canvas state is `{x, y, scale}` applied as a single inline style on `<body>`: `transform: translate(x,y) scale(z)` with `transform-origin: 0 0`. Transforms don't reflow — the page keeps its real layout at the real viewport width, so what you edit is what ships.

Why `<body>` specifically: React portals (dropdowns, modals) append to `body`, so they scale and pan **with** the page. A wrapper div around the app root would leave portals untransformed and mispositioned.

Rejected alternatives:

- **(B) iframe re-hosting** — true Figma architecture, but injecting into a *running* app means reloading it inside an iframe: app state lost, HMR wiring broken, endpoint/auth story doubled. Violates "it's still the real page."
- **(C) CSS `zoom`** — reflows; computed styles change with zoom level, which would make the inspector and verifier lie. Disqualifying.

Everything downstream keeps working for free, and this is load-bearing for the design:

- Pointer hit-testing on transformed elements is native browser behavior — click-to-select unchanged.
- `getBoundingClientRect()` returns post-transform **visual** coords — hover/selection outlines and ripple align at any zoom unchanged.
- `getComputedStyle` ignores ancestor transforms — panel values and the verify loop stay truthful at any zoom.

## Core mechanics — `src/client/canvas.ts` (`CanvasMode` class)

**Enter:**

1. Save verbatim (dock.ts discipline) every inline style touched: body `transform` / `transform-origin` / `box-shadow` / `background-color`, html `overflow` / `background-color`.
2. Freeze document scroll: `html { overflow: hidden }`.
3. Seed the transform to `translate(-scrollX, -scrollY) scale(1)` — entry is **pixel-identical**; the canvas starts exactly where the page was scrolled, no jump.
4. Paint the canvas backdrop: html background → canvas gray; body gets a subtle box-shadow so the artboard reads as a frame. If the page painted its background on `<html>` (body computed background transparent), copy the computed color onto body for the duration so the artboard doesn't turn gray.

**Exit:** restore every saved inline style verbatim, then `scrollTo` the page-point that was at the viewport's top-left (`-x/scale, -y/scale`) — leaving canvas mode lands on the same content, not back at the top. Design-mode off while canvas is on runs the same full exit.

**Host relocation (unconditional, not canvas-gated):** the overlay host moves from `document.body` to `document.documentElement` (one line in overlay.ts). A div appended to `<html>` renders fine in every browser; shadow DOM and listeners survive the move. This keeps our chrome out of the transformed subtree — `position: fixed` in the overlay keeps meaning the real viewport — and dodges app CSS like `body > *` selectors as a bonus.

**Dock coordination:** `Dock` gains a `canvasActive` flag. When set, `syncWidth`/`applyDocked` skip the `margin-right` push (page lays out full-width) but everything else about docked mode is unchanged. The saved-margin restore path is untouched.

## Interaction bindings (Figma-standard)

All listeners exist **only while canvas mode is on** — zero idle overhead, same rule as the rest of the client. One window-level wheel listener (capture, `passive: false`); events whose `composedPath()` includes the overlay host pass through untouched so the panel keeps scrolling itself.

- **Wheel** → pan (trackpad two-finger pan works natively).
- **Ctrl/Cmd + wheel** (also what trackpad pinch emits) → zoom toward the cursor, clamped **10%–400%**, page-point under the cursor held fixed.
- **Space + drag** → grab-hand pan (mouse users).
- **Shift+0** → 100%, **Shift+1** → zoom-to-fit. Figma's own keys — deliberately not Cmd+0/± which fight browser zoom. Ignored when focus is in an input or inside the panel.

## UI chrome

- **Canvas toggle:** small button in the panel header next to the existing dock-mode button, built via `ui/button.ts`. New test-hook class `.canvas-toggle`.
- **Zoom pill:** bottom-left of the viewport, visible only in canvas mode, shows the current percentage. Click opens a `ui/menu.ts` popover: *Zoom to fit · 50% · 100% · 200%*. Test-hook class `.zoom-pill`. Storybook story in `stories/` renders the real control, per convention.
- **Persistence:** `sessionStorage 'the-forge:canvas'` storing `{on, x, y, scale}`, parsed with the usual `unknown` + manual checks. A full reload (or HMR bailout) restores the exact canvas position.

## What deliberately doesn't change

Selection, hover outlines, ripple, drafts, the composer, send/dispatch/verify loop, MCP contract, server code — untouched. The verifier confirms edits identically at any zoom. Both frameworks get canvas mode for free via the shared client bundle.

## Testing

- **Unit (jsdom), `tests/client/canvas.test.ts`:** zoom math as exported pure helpers (zoom-to-cursor invariant, clamps, fit computation), enter/exit inline-style save/restore, wheel routing (panel-path passthrough), persistence parsing.
- **Real-browser E2E** against the demo app before merge — standing gotcha: jsdom cannot see transforms, layout, or hit-testing. Flow: enter canvas → zoom out → whole page visible → select element → edit → send → verify → exit restores scroll and inline styles byte-identically.
- **Budget first:** client bundle sits ~236/250KB; this module should cost ~3–4KB minified. Measure before building (standing rule), keep comments out of CSS strings (bundle bytes).
