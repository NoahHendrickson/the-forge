# M2b-1: Layout Section + Field Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The panel gains a Figma-grade Layout section (flex direction, gap with `Auto`, 9-dot alignment matrix, wrap), flex-child controls (align-self + Fill/Hug/Fixed sizing modes), the layout-ripple indicator, and field upgrades (math expressions, `Mixed` display, `auto` keyword).

**Architecture:** Extends the M2a panel within its existing patterns: `controls.ts` gains NumberField v2 + new `SegmentField`/`AlignMatrix` controls; `panel.ts` gains a Layout section driven by the same declarative SECTIONS model with a new contextual-visibility hook (visible only when applicable — but section ORDER never changes, per research); `index.ts` gains the ripple detector. Grounding: `docs/research/2026-07-04-panel-patterns.md` (decisions + principles), spec §6.

**Tech Stack:** unchanged. No new dependencies.

## Global Constraints

- **Stable section order** (research, non-negotiable): Layout → Size → Padding → Margin → Appearance. Inapplicable sections hide entirely (`hidden`), never reorder, never render disabled.
- **`Mixed` literal (never blank)** in linked fields with divergent values; typing/scrubbing replaces for all linked longhands; math expressions starting from `Mixed` are OUT of scope until multi-select (M2b-2) — a plain typed value replaces.
- Math expressions in every NumberField: `+ - * / ( )` operating on the current value when the input begins with an operator (e.g. `+8`, `*2`), or standalone expressions (`60+12`, `(100/2)+6`). Invalid expressions revert like garbage input today.
- `auto` is a first-class field value: displayed as the literal `auto`, typeable, and produced by the Hug sizing mode; scrubbing an `auto` field starts from the element's current computed px.
- All drafts remain plain CSS property/value pairs through the existing `DraftStore` — layout controls write `display`, `flex-direction`, `gap`, `justify-content`, `align-items`, `flex-wrap`, `align-self`, `flex-grow`/`flex`, `width`/`height`. No new draft machinery.
- The token mapper must map the new props: `gap` → `gap-N` (spacing scale), and the request renderer must pass through keyword values (`justify-content: center` has no Tailwind suggestion in M2b-1 — emit css-only lines; utility mapping for enums lands with the token picker in M2b-2). `UTILITY_PREFIXES` gains `gap: 'gap'` only.
- Ripple indicator: purely visual, zero cost while idle, no layout thrash (one rect snapshot before + one rAF-deferred compare after each panel edit, scoped to tagged elements in the selected element's nearest positioned ancestor subtree, capped at 50 elements); fading outlines auto-clear ≤1.6s; never shown for the selected element itself.
- Idle-zero, framework-bypass previews, TS strict, root `npm test` green, prod-clean green — all as before.

---

### Task 1: NumberField v2 — math expressions, Mixed, auto

**Files:**
- Modify: `packages/vite-plugin/src/client/controls.ts`
- Test: `packages/vite-plugin/tests/client/controls.test.ts`

**Interfaces (extending, not breaking — all M2a call sites keep working):**
- `NumberFieldOpts` gains `allowAuto?: boolean`.
- `set(value: number | null)` unchanged; NEW `setMixed(): void` (displays literal `Mixed`), `setAuto(): void` (displays literal `auto`, only meaningful when `allowAuto`).
- `get()` unchanged (`Mixed`/`auto` states report `null`).
- NEW `onKeyword?: (kw: 'auto') => void` in opts — fired when the user types `auto` into an `allowAuto` field.
- `onInput` unchanged — fires with resolved integers, including results of math expressions.
- Expression evaluation: input matching `/^[-+*/(]/` applies to the current numeric value (`+8` → value+8; from `Mixed`/`auto`/empty state, leading-operator input is ignored → revert); otherwise if the input contains an operator, evaluate standalone (`60+12` → 72). Evaluator is a tiny recursive-descent parser over `+ - * / ( )` and numbers — NO `eval`/`Function`. Export it as `evaluateExpression(expr: string, current: number | null): number | null` for direct testing.
- Panel linked rows call `setMixed()` where they currently call `set(null)`.

**Test sketch (RED first):** `evaluateExpression`: `'60+12'`→72, `'*2'` with current 8→16, `'(100/2)+6'`→56, `'+8'` with current null→null, `'2**3'`/garbage→null, division by zero→null. Field behavior: typed `12*2` commits 24 via onInput; typed `auto` in an `allowAuto` field fires `onKeyword('auto')` and displays `auto`; `setMixed()` displays `Mixed` and `get()` null; scrubbing from `auto` state starts at 0 fallback (or documented current-value injection — see Task 3's sizing modes for how W/H seeds it).

Steps: failing tests → implement → root `npm test` green → commit `feat: numberfield v2 — safe math expressions, Mixed and auto states`.

---

### Task 2: SegmentField + AlignMatrix controls

**Files:**
- Create: `packages/vite-plugin/src/client/layout-controls.ts`
- Test: `packages/vite-plugin/tests/client/layout-controls.test.ts`

**Interfaces:**
- `class SegmentField { root: HTMLElement; constructor(opts: { label: string; options: Array<{ value: string; label: string }>; onInput: (value: string) => void }); set(value: string | null): void }` — a row of small toggle buttons (`.seg` / `.seg-active` classes); `set(null)` clears selection (mixed/unknown).
- `class AlignMatrix { root: HTMLElement; constructor(opts: { onInput: (v: { justify: string; align: string }) => void }); set(justify: string | null, align: string | null, direction: 'row' | 'column', spaceBetween: boolean): void }`
  - 3×3 grid of dot buttons (`.am-dot`, `data-j` / `data-a` attributes). The mapping between grid position and (justify, align) FOLLOWS `direction`: in `row`, columns = justify (`flex-start|center|flex-end`), rows = align; in `column`, transposed. Current position gets `.am-active`.
  - `spaceBetween: true` (gap is `Auto`): the main axis collapses — render 3 dots along the cross axis only (main-axis position meaningless under space-between); clicking emits `justify: 'space-between'` with the chosen align.
  - Clicking a dot emits the css keyword pair; the widget itself never writes drafts (Panel wires it).
- Both controls are dumb view components — state in, events out — so jsdom tests fully cover them.

**Test sketch:** SegmentField renders options, click emits value, `set` toggles active class, `set(null)` clears. AlignMatrix: 9 dots; in `row` clicking top-right dot emits `{justify:'flex-end', align:'flex-start'}`; same physical dot in `column` emits transposed pair; `set('center','center','row',false)` activates the middle dot; spaceBetween renders 3 dots and emits `justify:'space-between'`.

Steps: failing tests → implement → green → commit `feat: segment and 9-dot alignment controls`.

---

### Task 3: Panel Layout section + flex-child controls

**Files:**
- Modify: `packages/vite-plugin/src/client/panel.ts`
- Modify: `packages/vite-plugin/src/client/tokens.ts` (add `gap: 'gap'` to UTILITY_PREFIXES)
- Test: `packages/vite-plugin/tests/client/panel.test.ts`, `tokens.test.ts`

**Interfaces / behavior:**
- SECTIONS gains a `Layout` section FIRST (order: Layout → Size → Padding → Margin → Appearance — stable forever). Sections gain an optional `visible?: (el: TaggedElement) => boolean` hook; the section's DOM nodes render always (stable order) but get `hidden` when the hook returns false.
- **Layout section content** (visible when `getComputedStyle(el).display` is `flex` or `inline-flex`):
  - Direction `SegmentField` (Row/Column → `flex-direction`).
  - Gap `NumberField` (`allowAuto: true`): number → `gap: Npx` draft; `auto` keyword → drafts `justify-content: space-between` AND clears any gap draft (Figma semantics); when computed justify-content is `space-between`, the gap field displays `auto`.
  - `AlignMatrix` wired to `justify-content` + `align-items` drafts; re-rendered with current direction and spaceBetween state on every `refresh()`.
  - Wrap `SegmentField` (No wrap/Wrap → `flex-wrap`).
  - When the element is NOT flex: the section shows a single "Add auto layout" button (`data-add-layout`) that drafts `display: flex` — after which `refresh()` reveals the controls (Figma's add-auto-layout affordance).
- **Flex-child controls** (visible when the PARENT's computed display is flex/inline-flex; rendered inside the Size section to keep order stable):
  - `align-self` SegmentField (Auto/Start/Center/End/Stretch) — Auto drafts removal (empty value → DraftStore stores `''`? No: draft `align-self: auto`).
  - W and H fields gain a sizing-mode mini-dropdown (`.size-mode` select with Fixed/Hug/Fill options, always visible next to each field — research: never hide the mode): Fixed = current numeric behavior; Hug = drafts `width: auto` (or `height: auto`) and the field shows `auto`; Fill = drafts `flex-grow: 1` + `flex-basis: 0%` for the main axis, or `align-self: stretch` for the cross axis (decide axis from the PARENT's flex-direction). Mode inference on refresh: explicit px draft/inline → Fixed; `flex-grow ≥ 1` (main) or `align-self: stretch` with no explicit size (cross) → Fill; else Hug when computed width comes from content (no explicit width in draft and computed `width` differs from any authored value — pragmatic heuristic: no draft + no inline style → Hug label only when `auto` would be the authored value; keep the heuristic simple and document it).
- Linked rows now call `setMixed()` for divergent values (Task 1).
- `tokens.ts`: `gap` prefix; `suggestUtility('gap','24px',TW)` → `gap-6`.

**Test sketch:** section order stable and Layout hidden for non-flex element but STILL first child in DOM; add-auto-layout button drafts display:flex; direction change re-maps the matrix; gap 24 drafts gap:24px and suggests gap-6 (tokens test); gap `auto` drafts justify-content:space-between; matrix click drafts both properties; align-self control writes draft; W mode Fill on a row-parent drafts flex-grow/basis; H mode Hug drafts height:auto and field shows `auto`; child controls hidden when parent not flex.

Steps: failing tests → implement → green → commit `feat: layout section — direction, gap with Auto, alignment matrix, wrap, flex-child controls`.

---

### Task 4: Layout-ripple indicator

**Files:**
- Create: `packages/vite-plugin/src/client/ripple.ts`
- Modify: `packages/vite-plugin/src/client/overlay.ts` (ripple outline pool), `packages/vite-plugin/src/client/index.ts` (wiring), `packages/vite-plugin/src/client/panel.ts` (onEdited passes the edited element)
- Test: `packages/vite-plugin/tests/client/ripple.test.ts` + wiring test

**Interfaces:**
- `snapshotRects(selected: TaggedElement, doc?: Document): Map<TaggedElement, DOMRect>` — collects rects of tagged elements (excluding `selected`) within the nearest scope: `selected.parentElement?.closest('[data-dc-source]') ?? doc.body`, capped at 50 elements (document the cap; log nothing).
- `diffRects(before: Map<TaggedElement, DOMRect>): TaggedElement[]` — re-measures the same elements, returns those whose rect changed by >0.5px in any dimension AND are still connected.
- `Overlay.showRipples(rects: DOMRect[]): void` — draws up to 8 outline divs (`.ripple-outline`, distinct dashed style, `opacity` transition), auto-clears after 1.5s (single shared timer; re-trigger resets it). `Overlay.setActive(false)` clears immediately.
- Wiring in DesignMode: panel's `onEdited` callback (already exists for outline re-measure) now ALSO runs the ripple flow: snapshot taken synchronously BEFORE the draft applies is impossible in the current call order (onEdited fires after apply) — so Panel's `buildField`/control handlers call a new pre-hook `onBeforeEdit(el)` before `drafts.apply(...)`, then `onEdited` after; DesignMode implements onBeforeEdit → `snapshotRects`, onEdited → rAF → `diffRects` → `showRipples`. Debounce: while scrubbing (rapid edits), reuse the FIRST snapshot until 300ms of quiet (so ripples reflect drag-start → drag-end, not per-tick noise).
- Ripple outlines are pointer-events:none, below the selection outline z-order.

**Test sketch:** snapshot excludes selected + respects scope; diff detects a grown sibling (jsdom rects are 0 — stub `getBoundingClientRect` on fixtures per existing test patterns); wiring test with fake rAF: editing PY on a stubbed-rect sibling arrangement calls `showRipples` with the changed sibling's rect; scrub burst uses one snapshot (debounce test with fake timers); deactivate clears ripples.

Steps: failing tests → implement → green → commit `feat: layout-ripple indicator — fading outlines on reflowed siblings`.

---

### Task 5: Fixture, gates, browser E2E (controller-heavy)

**Files:**
- Modify: `fixtures/demo-app/src/App.tsx` — give the cards' parent row a visible test surface for layout controls (it's already `flex gap-6`; add a third small card so wrap/alignment changes are visible).

**Steps:**
- [ ] Step 1 (implementer): fixture tweak; `npm test && ./scripts/check-prod-clean.sh` green; commit `feat: third fixture card for layout-section testing`.
- [ ] Step 2 (controller, real browser): select the card ROW (parent) → Layout section appears with direction/gap/matrix/wrap populated from computed styles; scrub gap → visible live; type `auto` in gap → cards space-between; matrix click re-aligns; direction column re-maps matrix. Select the Recovery CARD → child controls appear; H mode dropdown; set H taller → **ripple outlines flash on the sibling cards**; align-self start on Vitality → it stops stretching (the original user complaint, fixed from inside the overlay). Math: type `*2` in PY. Mixed: set PT≠PB, collapse → linked row shows `Mixed`. Send one layout edit through `/design`-style MCP loop → applied + implemented (gap → `gap-N` suggestion in the request).
- [ ] Step 3: record in task report; revert fixture drafts.

---

## Self-Review

- **Spec coverage:** §6 auto-layout row (direction/gap/justify/align, v1 tier — finally lands) → Tasks 2–3; child sizing modes (Fill/Hug/Fixed) → Task 3; research decisions (stable order, Mixed, math, matrix, mode-always-visible, Figma-style spacing kept) → Tasks 1–3; §10 layout-ripple backlog item → Task 4; token mapping for gap → Task 3.
- **Placeholder scan:** contract + test-sketch style per M4 precedent; every ambiguous behavior is pinned in interface text (gap-Auto semantics, mode inference heuristic documented as pragmatic, ripple scope/cap/debounce).
- **Type consistency:** NumberField v2 extends without breaking M2a call sites; SegmentField/AlignMatrix consumed only by panel.ts; ripple pre-hook threading named explicitly (`onBeforeEdit`); UTILITY_PREFIXES gains only `gap`.
