# Docked Panel, Resizable Width, and Text-Cutoff Audit — Design

**Date:** 2026-07-04
**Status:** Approved by user (brainstorm session)
**Scope:** `packages/vite-plugin/src/client/` only — no server, transform, or MCP changes.

## Goal

Three user-requested changes to the properties panel:

1. **Docked by default:** the panel anchors to the right edge like DevTools and *pushes page content left* instead of floating over it.
2. **Resizable width:** a drag handle lets the user widen/narrow the panel, with a sane minimum.
3. **Text-cutoff audit:** find and fix places where panel text silently clips.

## Non-goals

- No iframe-based "real viewport" split (would remount the user's app — violates the don't-perturb-the-app constraint).
- No change to floating mode's show-on-select behavior.
- No new runtime dependencies; zero prod footprint and zero idle overhead are preserved.

## Decisions (user-ratified)

| Decision | Choice |
| --- | --- |
| When the dock reserves space | While design mode is ON (not per-selection) — content shifts once per session |
| Floating mode | Kept, behind a dock/float toggle in the panel header; **docked is the default** |
| Status strip in docked mode | Re-parented into a pinned dock footer; Design toggle shifts left of the dock |
| Width persistence | `localStorage` (`the-forge:panel` → `{ width, mode }`) |
| Default / min / max width | 320px / **280px** (current width, so existing clip fixes keep holding) / `min(560px, 50vw)` |

## Mechanism: pushing content left

Set an inline `margin-right: <dockWidth>px` on `document.documentElement` while the dock is open; save any pre-existing inline value and restore it exactly on exit (design mode off, Escape-out, or float-toggle). This is the VisBug-style approach: ~10 lines, framework-agnostic, fully reversible.

**Accepted limitations (inherent to any in-page dock):** the page's own `position: fixed` elements and `100vw`-based sizing don't shift, and media queries still see the full viewport width. Acceptable for a dev tool.

## Architecture

New module **`src/client/dock.ts`** owns: dock/float mode state, html-margin apply/restore, localStorage persistence, and the resize drag. `overlay.ts` gains the dock CSS; `index.ts` wires dock enter/exit into `setActive`; `panel.ts` gains the docked empty state.

### 1. Dock layout

- Design mode ON + mode `docked` → panel root gets a `docked` class: `top: 0; right: 0; bottom: 0; width: var(--forge-dock-w); max-height: none; border-radius: 0; border-left: 1px solid rgba(255,255,255,0.09)`.
- Panel becomes a flex column: header (tag + source), scrollable body (sections), pinned footer (status strip).
- The dock is visible even with no selection: `panel.hide()` in docked mode clears the body to an empty state ("Click an element to edit") instead of hiding the root. Floating mode keeps today's hide-on-deselect.
- Design mode OFF → `docked` class removed, html margin restored.

### 2. Status strip → dock footer

- The existing `#status` div (watch indicator, draft count, Send/Copy/Before/Reset) is **re-parented** into the dock footer when docked, and back to its floating bottom-right spot when floating. Same DOM nodes — ids, listeners, and `overlay.updateStatus()` lookups all keep working.
- The `Design` toggle button stays floating but offsets left while docked: `right: calc(16px + var(--forge-dock-w))`.

### 3. Resize

- A 6px grab strip on the panel's left edge (`cursor: col-resize`), active in both dock and float modes.
- Dragging updates `--forge-dock-w` and (when docked) the html margin live; width clamped to [280px, `min(560px, 50vw)`].
- Width persists to `localStorage['the-forge:panel']`; window resize while docked re-clamps.
- Drag listeners are pointer-events scoped to the drag (attach on pointerdown, remove on pointerup); nothing attached while design mode is off.

### 4. Dock/float toggle

- Icon button in the panel header toggles mode; persisted in the same localStorage entry. Docked is the default when no stored value exists.
- Float mode = exactly today's behavior (fixed right 16 / top 16, `max-height: 80vh`, 12px radius, status strip floats).

### 5. Text-cutoff fixes

Root cause everywhere is the fixed 280px width — resize solves most of it. Plus targeted fixes:

- `.seg` segment labels: add `text-overflow: ellipsis` + `title` attribute (today they hard-clip with no affordance).
- `.panel-head-src`: add `title` with the full path, and truncate in JS (middle-ellipsis: keep the leading dir + always keep the trailing `file.tsx:12:4`) rather than CSS end-ellipsis, so the useful tail is never the part that's cut. (No `direction: rtl` CSS trick — it mangles punctuation.)
- `.nf-pill` token pills: ellipsis + `title` so long tokens (`spacing-2.5`) never silently clip.
- **Real-browser audit at 280px:** scan every panel text node for `scrollWidth > clientWidth` in the demo app and fix remaining offenders per-row (jsdom cannot see this — explicit E2E step per project gotchas). Per-row fixes follow the existing precedent: label-above-track stacking (`[data-align-self]`, `[data-text-align]`), shorter labels, or ellipsis+title.

## Error handling / edge cases

- Restore a pre-existing inline `margin-right` on `<html>` verbatim (don't clobber to `''` unconditionally).
- Corrupt/absent localStorage value → defaults (docked, 320px); values re-clamped on read.
- Escape-key deactivation and toggle-button deactivation both go through the same `setActive(false)` path, so margin restore is single-sourced.
- Popovers (`.color-popover`, `.token-popover`) are `position: absolute; right: 12px` inside the panel — width-agnostic, no change needed.

## Testing

- **Unit (jsdom):** dock class + html-margin set/restore (including pre-existing inline margin), localStorage round-trip + corrupt-value fallback, footer re-parenting both directions, resize clamp math, empty-state visibility, dock/float state machine.
- **E2E (real browser, demo app, pre-merge):** content actually shifts left with no horizontal scrollbar; drag-resize works; clipping scan (`scrollWidth > clientWidth`) comes back clean at 280px; toggling design mode off restores page layout exactly.
- Existing panel/overlay CSS class names are test hooks — `docked`, footer, and handle classes are **additions only**; nothing renamed.

## Risks

- Re-parenting `#status` moves buttons referenced by existing tests — ids are unchanged so lookups keep working, but status-visibility assertions need extending for docked mode.
- Pages with their own `<html>` inline margin are rare but handled by save/restore.
