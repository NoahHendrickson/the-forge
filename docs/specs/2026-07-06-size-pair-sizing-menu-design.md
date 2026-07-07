# Size pair + sizing menu design — 2026-07-06

Redesign of the W/H rows in the properties panel: a side-by-side Size pair (like the
padding pair), the Fixed/Hug/Fill modes + min/max + variable binding consolidated behind a
per-field dropdown menu, and a whisper label inside the field showing the applied Hug/Fill
mode alongside the real measured number.

User-ratified choices (2026-07-06 brainstorm):

- **Custom popover menu**, not a restyled native `<select>` — checkmark on the active mode,
  separators, and a `Variable…` item that opens the token picker.
- **The menu chevron always renders; Fixed/Hug/Fill items appear only for flex children.**
  Min…/Max…/Variable… items appear for every element (today the native select disappears
  entirely for non-flex children, stranding the min/max entry points).
- **"Size" group label** above the W|H line, mirroring the padding block's structure.

## Current state (what changes)

- W and H each sit on their own line: the Layout section body is a flex column, and each
  `.size-row` holds `[NumberField][native select]`. The select (Fixed/Hug/Fill + "Add min…"/
  "Add max…") is hidden unless the element is a flex child (`refreshFlexChild` in
  `panel-layout.ts`).
- Min/max disclosure rows (`data-minmax-row`) interleave in DOM order directly under their
  own axis row: W, min-W, max-W, H, min-H, max-H. Their labels are the bare `Min` / `Max` —
  unambiguous only because of that positional nesting.
- Hug/Fill display: the field shows the literal `auto` keyword (`setAuto()`), not a number.
- The token/variable affordance on W/H is the hover-revealed `{ }` button plus the `=` key.

## Design

### 1. Size block — side-by-side pair

The Layout section body starts with a `size-block` mirroring `padding-block`:

```
.size-block (data-size-block)
  .group-label            "Size"
  .size-fields            one line
    .size-row  (W first)  [NumberField W][chevron menu button]
    .size-row  (H second) [NumberField H][chevron menu button]
```

The four min/max disclosure rows move BELOW the pair (after `.size-block`, before the
auto-layout cluster) and gain axis-qualified labels — **Min W, Max W, Min H, Max H** — in
that order. `minMaxRowsFor(sizeSpec)` derives the labels from the size row it constrains
(`Min ${sizeSpec.label}`), so the pair can still never desync from its axis.

New fixed Layout-section order (amends the M-C / 2026-07-06 layout-polish order contract in
`panel.test.ts`): **Size block → min/max rows → auto-layout cluster → Padding block →
Align block.**

### 2. Sizing menu — `ui/menu.ts` factory

The native size-mode select is removed. Each W/H `.size-row` gets a small always-visible
chevron button at the field's right edge (a sibling of the field inside `.size-row`, styled
to read as part of the field — NumberField's own DOM stays generic). Clicking opens a
custom popover menu styled like the token picker popover.

Menu contents are computed at open time:

| Context | Items |
| --- | --- |
| Flex child | `Fixed` / `Hug` / `Fill` (checkmark on the inferred current mode), separator, `Min…`, `Max…`, separator, `Variable…` |
| Not a flex child | `Min…`, `Max…`, `Variable…` |

- Mode items route through the existing `onSizeModeChange` write path unchanged; the
  checkmark reads the `updateSizeMode` inference with **one fix**: today `hasExplicitSize`
  counts ANY draft/inline value as Fixed — including the `auto` that picking Hug writes —
  so the select silently reads back "Fixed" immediately after the user picks Hug (latent
  quirk; no test pins the select value after Hug, only the draft). The inference must
  exclude the `auto` keyword from "explicit size" so Hug reads back as Hug — the whisper
  label sits directly on this inference and would otherwise never say `Hug`.
- `Min…` / `Max…` call the existing `openMinMax` (disclose row + focus field). No new
  removal affordance — clearing a constraint stays "type `auto` in the row" (ratified M-D
  behavior). `SIZE_MODES` in `panel-specs.ts` stays a pure mode table; the action items
  live in the menu layer.
- `Variable…` fires the same `onTokenOpen` path as the token button, anchored to the field.
  The hover `{ }` token button is **no longer rendered on W/H fields** (the variable
  affordance lives in the menu); the invisible `=` key shortcut stays.
- Close on outside click and Escape, same conventions as the token/color popovers.
- Per the ui/ conventions: the factory lives in `src/client/ui/menu.ts`, all buttons go
  through `ui/button.ts` where applicable, and a Storybook story renders the real control.
  The existing size-mode select story is retired/replaced by the menu story.

Multi-select: chevron hidden (same single-select-only rule as the old selects and the
min/max rows). The W/H fields themselves keep their multi relative-delta behavior.

### 3. Whisper text — Hug/Fill shown with the real number

`NumberField` gains `setWhisper(text: string | null)`: a dim right-aligned `.nf-whisper`
span inside the field, rendered alongside the numeric value.

Refresh semantics for a single-selected **flex child** (where mode inference runs):

- Inferred **Fixed** → plain number, no whisper.
- Inferred **Hug** or **Fill** → the field shows the **measured computed px** (today it
  shows the literal `auto`) and the whisper reads `Hug` / `Fill`.
- Typing a number into a Hug/Fill field drafts a px value and flips the mode to Fixed
  (existing inference — whisper clears on the next refresh).

Non-flex children get no whisper (Fill/Hug are flex concepts and mode inference doesn't
run); an author-authored inline `width: auto` keeps today's literal `auto` display.
Token-pill binding wins over whisper (pill display as today, whisper cleared). Multi-select
never shows a whisper.

## Constraints & risks

- **Bundle budget:** client budget is ~244KB of the 250KB cap. The menu factory + CSS must
  fit (partially offset by deleting the select wiring). The implementation plan budget-checks
  with `./scripts/check-prod-clean.sh` early, not at the end. CSS-string comments are bundle
  bytes (guard-tested) — why-comments for menu CSS go between segments, not inside.
- Zero new runtime dependencies; panel/overlay class names are test hooks — extend, don't
  rename (`.size-row`, `data-minmax-row`, `data-props-row` all survive).
- `#panel .panel-rows` specificity trap applies to any new nested row CSS.
- jsdom can't verify layout — a real-browser E2E pass on the demo app is part of the
  merge gate.

## Test sketch

- Panel composition test amendments: Size block first (group label "Size", W then H in one
  `.size-fields` line), min/max rows after the pair with the new axis-qualified labels.
- `ui/menu.ts` unit tests: open/close (outside click, Escape), item select fires callback,
  checkmark placement, flex-gated mode items vs always-on Min/Max/Variable.
- Inference fix regression test: after picking Hug, the menu's checked mode reads `hug`
  (pins the auto-draft-is-not-Fixed rule the old select never asserted).
- NumberField whisper tests: set/clear, coexistence with number display, pill binding wins.
- Panel integration: Hug/Fill shows measured px + whisper (not `auto`); menu `Variable…`
  opens the token picker; `Min…` discloses + focuses; multi-select hides chevrons; W/H
  fields no longer render `{ }`.
- Storybook story for the menu; real-browser E2E before merge.

## Out of scope

- Extending Fill/Hug semantics to non-flex elements (width:auto / width:100% inference).
- A menu-based "remove min/max" action (clearing stays `auto`-keyword in the row).
- Any change to the request builder, queue, or MCP surface — this is panel-only.

## Amendment (2026-07-06, E2E finding)

Real-browser E2E on the demo app (a Tailwind `flex-1` card) found that the write half must
defeat app-CSS-authored fill on the main axis, or Fixed/Hug picks and typed sizes visibly
no-op: `flex-basis: 0%` + grow (from the stylesheet, not a draft) keep winning the main-axis
sizing even after a px is drafted. The old "app-CSS-authored fill is out of scope" line
applied to the READ half (whisper honesty) and now applies **only to cross-axis Hug** (see
below) — the write half defeats it:

- **Fixed/Hug picks (main axis):** after the existing discard + pin (Fixed) or `auto`
  (Hug), if computed `flex-grow` is still >= 1 (fill survives because it's stylesheet-
  authored, not drafted), also draft `flex-grow: '0'` and `flex-basis: 'auto'`.
- **Typing/scrubbing/token-picking a main-axis size** performs the same defeat via an
  `onBeforeApply` hook on the W/H rows (one shared implementation, `defeatFillIfGrowing`,
  used by both the typed-value path and the Fixed/Hug menu picks).
- **Fill pick (cross axis):** an explicit cross size defeats `align-self: stretch` in CSS
  (stretch only applies when the cross size is auto), so picking Fill also clears an
  explicit cross size to `auto`. Main axis needs no equivalent — drafted `flex-basis: 0%`
  already beats an explicit width.

The read half (mode inference) is now axis-split instead of Fill-first on both axes:

- **Main axis (unchanged):** Fill (computed flex-grow >= 1) -> explicit size -> Hug.
- **Cross axis (fixed regression):** explicit size -> Fill (`align-self: stretch`) -> Hug.
  The old stretch-first order misreported Fill for an element rendering at a fixed height.

The "app-CSS fill out of scope" carve-out now applies only to **cross-axis Hug**: the code
reads computed `align-self`, and the stretch detection matches an explicit `align-self:
stretch` only — a default-stretch parent (`align-items: stretch` with no explicit
`align-self`) reports computed `auto`/`normal`, which reads as Hug, not Fill. That's a
pre-existing reader limitation carried over unchanged from the old select, noted here for a
possible follow-up rather than fixed in this pass; defeating it properly would mean drafting
`align-self: flex-start`, which changes alignment, not just size.

One exception to "pill wins over whisper" (see the M-D min/max section above): a token-bound
W or H field that reads back as Hug or Fill shows the measured px alongside the Hug/Fill
whisper instead of the pill — `updateSizeMode` unconditionally calls `field.set(px)` for
either mode, which clears the pill display (bookkeeping survives underneath); the pill
re-binds on the next refresh once that field's mode returns to Fixed. This is a deliberate
per-axis exception (applies to whichever of W/H is currently Hug/Fill, not just the main
axis), not a regression of the pill-binding rule.
