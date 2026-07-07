# Panel input polish design — 2026-07-07

Four panel refinements from live-use feedback: comma-separated per-side values in the
multi-prop number fields (display AND entry), the align-self strip shown disabled (instead
of hidden) when its toggle is off, the W/H sizing chevron moved inside the input, and the
Baseline toggle removed from the matrix tile.

User-ratified choices (2026-07-07 brainstorm):

- **Comma values apply to ALL multi-prop rows** — Padding H/V, Margin H/V, corner Radius R,
  Stroke width W — not just the 2-value pairs.
- **4-value entry follows CSS shorthand rules** — `16,8` sets TL/BR=16 TR/BL=8; `16,8,4`
  sets TL=16 TR/BL=8 BR=4 (border-radius shorthand semantics).
- **Baseline toggle is removed entirely** (not relocated). Amends the ratified panel
  patterns doc explicitly — not a silent relitigation.
- **Across a multi-element selection the field still shows `Mixed`** — comma display is a
  single-element, differing-sides affair. A typed comma list applies the same per-side
  values to every selected element.

## Current state (what changes)

- A multi-prop row whose sides differ shows the literal `Mixed` (`NumberField.setMixed()`,
  `panel.ts` refresh: `values.some((v) => v !== values[0])`) whether the variance is across
  sides of one element or across elements. Typing a single number sets all the row's props.
- The flex-child Align strip (`[data-align-self]`, `panel-layout.ts` refreshFlexChild) is
  `hidden` unless the align toggle is ON (`alignSelfRowOn`).
- Each W/H `.size-row` is `[NumberField][.menu-btn chevron]` — the chevron is a flex
  sibling OUTSIDE the field's `.nf` box (`panel.ts` buildRow).
- A `Baseline` toggle sits under the 9-dot matrix in `.matrix-tile` (`panel-layout.ts`),
  drafting `align-items: baseline`; `.baseline-toggle` CSS in `overlay.ts` carries its own
  width/overflow overrides and forces the tile into a column layout.

## Design

### 1. Comma per-side values (multi-prop rows)

**Display** (single element selected, sides differ): the field shows the shortest
CSS-shorthand comma form of the per-side values instead of `Mixed` — read and write use the
same grammar, so a displayed value is always valid to retype.

- 2-prop rows (positional, props order): `16,8` = props[0] 16, props[1] 8 (H row: left,
  right; V row: top, bottom).
- 4-prop rows (CSS border-radius shorthand compression): all four differ → `a,b,c,d`;
  d==b → `a,b,c`; additionally c==a → `a,b`; all equal is the existing non-mixed path.

Multi-element selection keeps `setMixed()` (the ratified Mixed-not-blank pattern survives
untouched for that case).

**Entry**: a typed value containing `,` parses as a list of 1–N plain decimal numbers —
no math expressions inside comma lists (`+8` etc. stay single-value only). The list
expands to the row's props: 2-prop rows accept 1 or 2 values (1 = both); 4-prop rows
accept 1–4 values via CSS shorthand expansion. More values than props, or any non-numeric
segment, is invalid → the field reverts (existing revert contract, extended to restore a
comma display). Each expanded value clamps to the row's min/max, then drafts per-prop —
`onBeforeApply` hooks (e.g. Stroke's `draftSolidIfNone`) fire per prop exactly as today.

**NumberField mechanics** (`controls.ts`):

- New display state `'values'` + `setValues(values: number[])` (renders the compressed
  comma form; `lastValid` stays null; `get()` reports null — same contract as Mixed/auto).
  An unedited blur of the comma text survives, mirroring the Mixed/auto early-returns.
- New opt `onValuesInput?: (values: number[]) => void` — fires with the FULLY EXPANDED
  per-prop list (panel code never re-derives shorthand). Wired by `buildField` only for
  multi-prop specs; single-prop fields never see comma parsing (a `,` there stays garbage
  → revert, as today).
- Pure helpers `expandShorthand(values, count)` / `compressShorthand(values)` exported for
  direct unit testing.
- Scrubbing keeps the existing `onRelative` behavior — the panel's per-prop scrub
  baselines already move each side independently by the drag delta; no change.
- Arrow keys in the `'values'` state route through `onRelative` (±1 / ±10 per side against
  each prop's own baseline) instead of the absolute-commit path — today's path would
  `parseFloat('16,8')` → commit 16±1 to ALL sides, silently collapsing the variance.
- Token pills stay suppressed while sides differ (the `mixed` flag passed to
  `PanelTokenUi.rebind` is true for the comma display too).

**Request path**: no changes. Comma entry drafts individual longhands; `request.ts`
already emits per-prop utility deltas (`pl-*`, `rounded-tl-*`, …) from individual drafts.

### 2. Align strip disabled preview (toggle off)

`refreshFlexChild` no longer hides the strip when the toggle is off — it shows it
**disabled**, previewing the child's *effective* alignment: the parent's computed
`align-items` (what `align-self: auto` resolves to — exactly what the parent's 9-dot
matrix sets). Editing the parent's matrix refreshes the panel, so the disabled strip
follows it live.

- `SegmentField.setDisabled(disabled: boolean)` — toggles `.seg-disabled` on the root and
  the `disabled` attribute on the track buttons. CSS: dimmed + `pointer-events: none` on
  the track. (Trailing addons are unaffected; the align strip has none.)
- Off-state mapping: parent `align-items` normalized via `normalizeAlign` → the matching
  segment (`flex-start`→Start, `center`→Center, `flex-end`→End, `stretch`→Stretch).
  `baseline` (app-CSS only, once the toggle is gone) matches no segment → `set(null)`.
  The `Auto` segment lights only when the toggle is ON with a genuine `auto` value —
  never in the disabled preview.
- Toggle ON: strip enables and behaves exactly as today. Multi-select: the whole
  flex-child block stays hidden (unchanged).

### 3. Sizing chevron inside the W/H inputs

The menu button moves INSIDE the field box: `buildRow` appends `menu.button` into the
field's `.nf` root (after the whisper span) instead of as a `.size-row` flex sibling.

- The field root gains `.nf-has-menu`; CSS absolutely positions the chevron at the input's
  right edge and pads the input right so text never runs under it. The Hug/Fill whisper's
  right offset shifts left to sit just before the chevron.
- Same button element and class (`.menu-btn` — test-hook rule: extend, don't rename), so
  the `sizeModes` registry, `closeSizeMenus`, multi-select hiding, and popover anchoring
  are all unchanged. `.size-row` survives as the row wrapper (also a test hook).

### 4. Remove the Baseline toggle

- Delete from `panel-layout.ts`: the creation block in `buildBodyInto`, the `baselineOn`
  refresh lines, the `baselineToggle` field + teardown null.
- Delete from `overlay.ts`: `.baseline-toggle` rules; simplify the `.matrix-tile` column
  comment/rules now that the tile holds only the matrix (small bundle win).
- App-CSS `align-items: baseline` now simply lights no matrix dot (`normalizeAlign`
  returns `'baseline'`, which matches no dot) until the user picks one, which drafts over
  it. `normalizeAlign` keeps its `baseline` vocabulary (readers stay honest).
- Amend `docs/research/2026-07-04-panel-patterns.md` with the removal decision + date.

## Constraints & risks

- **Bundle budget:** merged tree is ~233KB of the 250KB cap. Comma parsing + disabled CSS
  are small; baseline removal offsets. Budget-check with `./scripts/check-prod-clean.sh`
  early. CSS-string comments are bundle bytes — why-comments go between segments.
- Zero new runtime dependencies. Panel/overlay class names are test hooks — extend, don't
  rename (`.size-row`, `.menu-btn`, `[data-align-self]` all survive).
- The comma grammar must not collide with the expression evaluator: `handleChange` checks
  for `,` (values path) BEFORE the expression path, and only when `onValuesInput` is wired.
- jsdom can't verify the chevron overlay or disabled-strip visuals — real-browser E2E on
  the demo app is part of the merge gate.

## Test sketch

- `expandShorthand`/`compressShorthand` unit tests: 1/2/3/4-value expansion, compression
  round-trips, over-length and non-numeric → null.
- NumberField: `setValues` renders compressed form; unedited blur survives; invalid entry
  reverts to the comma display; comma entry fires `onValuesInput` with expanded+clamped
  values; `get()` null in values state; arrows route relative; single-prop field treats
  commas as garbage.
- Panel integration: differing padding sides show `16,8` (padding, margin, radius, stroke
  W); typing `16,8` drafts per-side; typing `16,8,4` on radius expands per shorthand;
  multi-element still `Mixed`; pill suppressed while sides differ.
- Align strip: toggle off → visible, `.seg-disabled`, segment mirrors parent
  `align-items`, updates after a matrix edit; toggle on → enabled, today's behavior;
  baseline parent → no segment active.
- Chevron: menu button lives inside `.nf` (`.nf-has-menu`); multi-select still hides it;
  selection-change still closes an open menu.
- Baseline: `data-align-baseline` assertions removed; app-CSS baseline lights no dot.
- Real-browser E2E before merge: comma entry end-to-end (panel → draft → change request),
  chevron placement, disabled align strip following the matrix.

## Out of scope

- Math expressions inside comma lists (single-value expressions unchanged).
- Comma display/entry across multi-element selections ("comma when consistent" was
  considered and rejected — stays `Mixed`).
- Any change to the request builder, queue, or MCP surface — panel-only.
- Defeating default-stretch cross-axis Hug inference (pre-existing carve-out, unchanged).
