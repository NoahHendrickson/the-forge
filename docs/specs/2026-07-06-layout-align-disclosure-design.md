# Layout section polish: align-self disclosure, padding row, wide-panel pass

**Date:** 2026-07-06
**Status:** ratified (this spec is the record of the brainstorm; the user approved the design conversationally)
**Prereq state:** main at 20e3427 — the M-C unified Layout section and M-D min/max rows are merged. This spec amends the within-Layout composition that M-C ratified.

## Motivation

Three findings from the first real designer pass over the shipped M-C/M-D panel:

1. **The align-self strip reads as duplicate.** Designers think container-first: select the parent, use the 9-dot matrix. Figma has no per-child start/center/end override at all — alignment lives on the auto-layout frame. Our always-visible Auto/Start/Center/End/Stretch strip (shown whenever the parent is flex) surfaces a CSS concept with no Figma equivalent, in prime panel real estate between the H row and the cluster.
2. **Padding became anonymous.** M-C folded the padding H/V rows into the Layout section but nothing replaced the old "Padding" section title. Two bare `H`/`V` inputs under the matrix are not identifiable as padding (Margin's identical H/V shorthand is explained by its section title; padding's isn't).
3. **The section breaks when the panel is widened.** `.layout-section` stacks children in a column but inherits `align-items: center` from `.panel-rows` — in a column axis that means *horizontal centering*, so every non-full-width child floats toward the middle. Invisible at the 280px default width, obvious at 700px: W/H rows, Direction track, matrix tile, and padding inputs all drift to arbitrary indents.

## Design

### New Layout section body order (single-select, top → bottom)

1. W / H rows with size-mode dropdowns, min/max disclosure rows under each — **unchanged**
2. Auto-layout cluster: "+ Add auto layout" ⇄ (Direction + wrap, 9-dot matrix + Baseline, Gap) — **unchanged**
3. **Padding row** — mini-label "Padding" (same muted label style as "Direction"), then ONE line: H field (`padding-left`+`padding-right`) on the left, V field (`padding-top`+`padding-bottom`) on the right — mirroring the Margin section's H|V row. Replaces the two stacked padding rows. The `⋯` per-side expand (T/R/B/L) is untouched.
4. **Align row** (new, at the bottom) — replaces the always-on flex-child strip that previously sat between the H row and the cluster.

Multi-select: the align row, cluster, and size-mode selects stay hidden exactly as today (B6); the W/H and padding rows keep multi relative-delta behavior.

### Align row behavior

- **Visibility:** rendered only when the element's parent is a flex container (same predicate as today's strip: `isFlex(parentElement)`); hidden in multi-select.
- **Anatomy:** mini-label "Align" + a small toggle button (born via `ui/button` `createButton`, `aria-pressed`, same idiom as the wrap and Baseline toggles). Toggle **off** → no strip; the element follows the parent's 9-dot alignment. Toggle **on** → the Auto/Start/Center/End/Stretch `SegmentField` appears; picking a segment drafts `align-self` (opening alone drafts nothing).
- **Auto-on predicate:** the toggle starts ON whenever `align-self` is already non-default — from the app's own CSS, a live draft (including a restored one), or cross-axis size-mode Fill (which writes `align-self: stretch`). Reality is never hidden behind an off toggle. The predicate is a pure function in `panel-readers.ts` beside `minMaxRowVisible` (canonical-predicate convention). Non-default means computed/drafted `align-self` is not `''`/`auto`/`normal`.
- **Manual-open latch:** toggling ON without any draft latches the row open for the current selection only — same per-selection lifecycle as `openedMinMax` (cleared on selection change / teardown). Opening drafts nothing until the user picks a segment.
- **Toggling off:** if `align-self` was drafted this session → discard the draft (pure undo, Baseline-toggle semantics; nothing to send). If it comes from the app's own CSS → draft `align-self: auto`, so the change request says "make this element follow its parent."
- **Compare mode:** the row reflects pre-draft reality while comparing (`isComparing` ⇒ draft reads as null), same as every other control.
- **Change-request output:** unchanged plumbing — `align-self` drafts already map to Tailwind `self-*` utilities in `request.ts`.
- **Model note:** `align-self` remains in the size-mode machinery (cross-axis Fill inference and writes) regardless of toggle state. The toggle gates UI, not the model.

### Wide-panel CSS pass

Root cause fix, not per-widget patches: `.layout-section` children left-anchor and stretch (`align-items: stretch` semantics for the column), with:

- inputs, segment tracks, and rows growing with the panel width;
- intrinsically-sized pieces (matrix tile, wrap/Baseline/Align toggles) keeping fixed size, left-aligned;
- an audit of the other sections (Margin/Fill/Stroke/Appearance share the `.panel-rows` system) at width extremes while in there.

jsdom cannot see flex layout — the acceptance gate for this piece is a real-browser E2E pass at ~280 / ~450 / ~700px panel widths against the demo app.

## Tests

- `panel.test.ts` composition test updated for the new in-section order (W/H → cluster → Padding → Align).
- New align-row tests: off by default when `align-self` is default; auto-on for app-CSS value, for restored draft, and after cross-axis Fill; toggle-off discards a session draft vs drafts `auto` over app CSS; drafting nothing on bare open; hidden when parent isn't flex; hidden in multi-select; latch cleared on selection change.
- Padding row keeps `data-props-row` hooks; existing test hooks (`data-align-self`, `.flex-child-controls`) are extended, never renamed.
- New DOM hooks for the toggle (e.g. `data-align-toggle`) follow the existing data-attribute convention.

## Non-goals

- Margin stays its own section (ratified: Figma has no margin concept; the section self-hides when the element has none).
- Cross-section order (Layout → Margin → Typography → Fill → Stroke → Appearance) untouched.
- No removal of `align-self` from size-mode Fill semantics.
- No panel width persistence / resizing behavior changes beyond the CSS fix.

## Gates

- Root `npm test` (typecheck + full vitest suite).
- Real-browser E2E on the demo app (three panel widths, plus the standard select→edit→send loop).
- `./scripts/check-prod-clean.sh` — package budget is at 247/250KB; this work must fit, and is expected to be low single-digit KB (mostly CSS in the existing string const).

## Doc updates

- `docs/research/2026-07-04-panel-patterns.md`: record the align-self disclosure and the new within-Layout order as a user-ratified amendment (2026-07-06, this brainstorm).
- The M-C spec's "flex-child strip" position note gets a pointer to this spec.

## Ratified choices (from the brainstorm)

- Align row lives at the BOTTOM of the Layout section, off by default, toggle to enable — designers think container-first; the per-child override is the exception, not the default surface.
- Auto-on over pure-hidden: an off toggle must never mask a real `align-self` in the app's CSS or an active draft.
- Padding H and V share one line (H left, V right), with a "Padding" mini-label — not stacked rows, not a restored section title.
- "Add align…"-style hidden affordance (min/max pattern) was considered and rejected: min/max had a natural home inside the size dropdown; align has none, and discoverability loses.
