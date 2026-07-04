# Track A — Panel visual audit & cleanup (2026-07-04, overnight)

## Diagnosis (verified live in the demo app, Playwright)

The user "couldn't find the 9-dot alignment matrix." Three concrete, reproduced defects compound into that experience:

1. **`[hidden]` is defeated by the panel's own CSS.** `#panel .panel-rows { display: flex }` and `.seg-field { display: flex }` outrank the UA's `[hidden] { display: none }`. Verified live: with a non-flex element selected, `.layout-controls` has `hidden=true` but computes `display: flex`. Consequences:
   - Non-flex selection shows **ghost Layout controls** (Direction/Gap/Wrap) *plus* "Add auto layout" — and the matrix inside them is **empty** (0 dots, since `AlignMatrix.set()` is never called for non-flex), so the section reads as broken.
   - Non-flex-child selection shows a **ghost align-self row** ("Alig / Auto / Start / …").
   - The one place this was known: `#panel .panel-section[hidden] { display: none }` patched section *titles* only.
   - jsdom never caught it because jsdom doesn't cascade stylesheet rules into `el.hidden` behavior — the unit tests assert the `hidden` attribute, which is set correctly.

2. **No active dot on a default flex container.** Computed `justify-content`/`align-items` for untouched flex is `normal`, which is not in the matrix keyword set (`flex-start|center|flex-end`), so **0 of 9 dots highlight**. A matrix with no current-state marker doesn't read as a matrix.

3. **The matrix is visually illegible even when populated.** 16px white squares with a 1px `#e3e3de` border on a white panel, rendered mid-flow in a wrapping `panel-rows` so the Wrap segment sits *between* the dot rows. Also: "Align" label truncated to "Alig", "Stretch" segment clipped off the panel's right edge, raw `<select>`s for size modes, no hover/focus states anywhere, uppercase micro-headers with no separators, unstyled Compare/Reset at top.

Before-screenshots: `docs/screenshots/track-a/01..03-before-*.png`.

## Contract

### Task 1 — Visibility correctness (bug fixes, TDD)

- `overlay.ts` CSS gains a shadow-root-wide `[hidden] { display: none !important }` (first rule, so *nothing* can defeat the semantic attribute again).
- `panel.ts` normalizes computed alignment keywords before feeding widgets, display-only (drafts still write canonical keywords):
  - justify: `normal|start|left` → `flex-start`; `end|right` → `flex-end`
  - align: `normal|start` → `flex-start`; `end` → `flex-end`
  - explicit `stretch` align keeps **no active dot** (stretch is represented by child W/H = Fill, not a matrix position). Decision recorded for the morning report.
- Tests: CSS-string assertion for the `[hidden]` rule (jsdom can't cascade); panel tests asserting an `.am-active` dot exists for a default flex container (`justify/align: normal`), and none for explicit `stretch` align.

### Task 2 — Panel redesign (structure + full CSS rewrite)

Design language: **dark tool-chrome** (Figma UI3 dark reference) — the overlay sits on arbitrary apps, so it must read as *tool*, not *page*. Accent `#0D99FF` (Figma blue). Panel width 260 → **280px**.

Structural changes in `panel.ts` (all existing class hooks preserved; new classes are additive):
- Header becomes two lines: `<tag>` prominent + source path secondary (`panel-head` kept as container; new `panel-head-tag`, `panel-head-src`), with Compare/Reset as compact quiet buttons in a `panel-actions` row.
- Section title row (`panel-section`) becomes a flex row; the `⋯` expand button moves into it (right-aligned). `[data-expand]` hook unchanged.
- Layout section rearranged to the Figma composition: Direction segment on top; below it the **matrix as a contained tile** (left) beside a right-hand stack of Gap + Wrap. New wrapper classes `layout-grid`, `matrix-tile` — `.align-matrix`, `.am-dot`, `.am-active` hooks unchanged.
- Size-mode `<select>`s stay `<select>` (native a11y) but restyled (`appearance: none`, chevron, filled bg). `.size-row` keeps `.nf` and `.size-mode` as siblings (tests rely on it).
- "Add auto layout" empty state: full-width quiet button, `+` prefix.

CSS rewrite (~90 → ~230 lines): consistent type scale (11px/12px), 4px spacing grid, section separators, filled inputs with hover/focus-ring states, segmented controls in a track, matrix dots as centered round dots with hover growth + accent active, scrub-cursor affordance on field labels, dark status strip + toggle to match. All 296 tests stay green.

### Task 3 — Controller E2E + after-screenshots

Same scenario set as diagnosis: non-flex card, flex row, button, add-auto-layout flow, matrix click writes drafts, gap Auto = space-between, size modes, expand rows, scrub. Console must stay clean. After-screenshots into `docs/screenshots/track-a/`.

## Out of scope (parked for B/C or user)

- Typography/Fill/Stroke sections (Track B).
- Icons for direction/wrap segments (text labels tonight; icon set is a user design decision).
- Expand-state persistence across selections (M2a deferral, listed in Track B nits).
