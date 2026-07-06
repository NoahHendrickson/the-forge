# Designer-Forward Panel — Figma-Parity Redesign (2026-07-05)

Brainstormed and ratified with the user 2026-07-05. Reshapes the properties panel to speak a
designer's language (Figma vocabulary) end-to-end while keeping the deterministic CSS/Tailwind
mapping that the change-request pipeline depends on.

## Goals

- A designer who lives in Figma reads every control in the panel without translation.
- An engineer (or the agent) can always recover the exact CSS/Tailwind meaning of any control.
- Nothing about the change-request output format changes: pure Tailwind vocabulary, exact
  file:line targets, deterministic.

## The three-languages principle

| Layer | Language | Audience |
| --- | --- | --- |
| Panel labels & controls | Figma (Auto layout, Horizontal/Vertical, Gap, Hug/Fill, H/V padding) | designers |
| Tooltips (`title` attrs) | CSS + Tailwind (`flex-direction: column → flex-col`) | engineers, curious designers |
| Change request | Pure Tailwind utilities (unchanged) | the agent / the codebase |

Tooltips are **auto-derived** from each row's `props` via the existing `UTILITY_PREFIXES` /
`utilityPrefixFor` machinery (new `cssHintFor(spec)` helper in `panel-specs.ts`), so the hint
text can never drift from what the request builder actually emits. Props with no utility prefix
fall back to the CSS property name alone. Native `title` attributes work inside the shadow DOM —
no custom tooltip component.

## Ratified decisions (this brainstorm)

1. **Vocabulary: designer-first + CSS hints.** Figma terms in the UI, CSS/Tailwind in tooltips,
   Tailwind in the request. (User explicitly weighed pure-Figma and pure-flexbox and chose this.)
2. **Margin: show only when non-zero.** Designers don't set margins (Figma has none); modern CSS
   practice agrees (gap/padding-first). But real codebases carry margins (`space-y-*` compiles to
   `margin-top`, `mx-auto`, legacy `margin-bottom` lists), so hiding them entirely creates
   invisible, unfixable space. The section keeps its slot and its honest name **"Margin"** with an
   explanatory tooltip ("space this element adds around itself") — no invented vocabulary.
3. **Unified Layout section (Figma UI3 parity).** Layout + Size + Padding merge into one
   "Layout" section, matching Figma's current (UI3) panel. This **re-ratifies** the
   2026-07-04 stable section order to: **Layout → Margin (conditional) → Typography → Fill →
   Stroke → Appearance** — fixed forever from here. The stable-order *principle* (contextual
   content, never contextual position) is unchanged; padding renders in one fixed spot inside
   Layout regardless of flex-ness, never conditionally repositioned.
   `docs/research/2026-07-04-panel-patterns.md` gets a dated amendment note.
4. **Remove auto layout** joins add (user requirement: "we should be able to remove those").
5. **Min/max sizing** ships (Figma UI3 has it; clean CSS/Tailwind mapping exists).
6. **Position/constraints deferred.** Figma's X/Y/rotation/constraints only map to CSS for
   absolutely-positioned elements; offering X/Y on normal-flow elements invites
   `position: absolute` soup. Revisit when real sessions demand it.

## Control → CSS → Tailwind mapping (the wiring contract)

| Panel control (Figma language) | CSS drafted (preview) | Tailwind emitted (request) |
| --- | --- | --- |
| + Add auto layout | `display: flex` | `flex` |
| − Remove auto layout | `display: block` (or draft discard, see M-B) | remove `flex`/`flex-col`/`gap-*`/`justify-*`/`items-*` |
| Direction → (horizontal) | `flex-direction: row` | `flex-row` |
| Direction ↓ (vertical) | `flex-direction: column` | `flex-col` |
| Wrap toggle | `flex-wrap: wrap` / `nowrap` | `flex-wrap` / remove it |
| Gap | `gap` | `gap-*` |
| Gap = Auto | `justify-content: space-between` (gap draft cleared) | `justify-between` |
| Alignment matrix (9-dot) | `justify-content` × `align-items` | `justify-*`, `items-*` |
| Baseline align toggle | `align-items: baseline` | `items-baseline` |
| W / H (Fixed) | `width` / `height` | `w-*` / `h-*` |
| W / H (Hug) | `width/height: fit-content`/`auto` | `w-fit` / `h-auto` |
| W / H (Fill) | `flex: 1` / `align-self: stretch` | `flex-1` / `self-stretch` |
| Min/Max W/H | `min-width` `max-width` `min-height` `max-height` | `min-w-*` `max-w-*` `min-h-*` `max-h-*` |
| Padding H / V (expand T/R/B/L) | `padding-*` | `px-*` `py-*` `pt-*` … |
| Margin H / V (expand T/R/B/L, conditional section) | `margin-*` | `mx-*` `my-*` `mt-*` … |

Everything else (Typography, Fill, Stroke, Appearance) is unchanged by this redesign apart from
side-label renames and tooltips (M-A).

## Milestones

Four milestones, each its own dated plan in `docs/plans/` and its own feature branch
(repo convention). Each is independently shippable.

### M-A — Vocabulary + margin disclosure

- **Labels.** Padding rows `PX/PY` → `H/V`; expand rows `PT/PR/PB/PL` → `T/R/B/L`. Same
  treatment for Margin (`MX/MY` → `H/V`, sides → `T/R/B/L`) and Stroke's expand
  (`BT/BR/BB/BL` → `T/R/B/L`). Direction segment options `Row/Column` →
  `Horizontal/Vertical` (still text; icons arrive in M-B). Appearance keeps `R`/`O` with
  tooltips. Labels are display text only — the request builder keys on `props`, so no request
  changes.
- **Tooltips, where M-A reaches.** `cssHintFor(spec)` (props + `utilityPrefixFor`) → `title`
  attr on every numeric row label (including Gap), the Direction/Wrap segment options, and the
  Margin section title. The size-mode select gets a fixed (non-`cssHintFor`) descriptive title.
  The remaining selects and segments — typography family/weight, stroke style, align controls —
  pick up CSS-hint titles in M-B alongside the `SegmentField` icon work.
- **Margin visibility.** `SectionSpec.visible` for Margin, evaluated **on every `refresh()`**:
  shown iff any of the four computed margins is non-zero, OR any margin prop currently has a
  live draft. The draft clause is what prevents the section from vanishing mid-edit when a user
  scrubs a margin to 0 (computed alone would read 0 and un-render the section under the user's
  pointer) — the same mid-edit guarantee as a selection-time latch, but without any
  selection-scoped state to keep in sync.
- Panel CSS class names untouched (test hooks — extend, don't rename).

### M-B — Auto-layout cluster rework

- **Direction as icons.** The Direction segment becomes Figma's icon pair — `→` (horizontal),
  `↓` (vertical) — with the Wrap toggle joining the same row as an icon toggle (Figma UI3
  grouping). `SegmentField` gains icon-label support; every icon carries `aria-label` + CSS-hint
  `title`. Existing field classes stay.
- **− Remove auto layout.** Affordance in the Layout section header, visible only when the
  element is flex (`data-remove-layout` hook). Semantics:
  - If `display: flex` was drafted this session (auto layout added via the panel): **discard**
    the display/flex-direction/gap/justify-content/align-items/flex-wrap drafts — a pure undo,
    element returns to its stylesheet reality, nothing to send.
  - If flex comes from the app's own CSS: draft `display: block` and discard any other
    flex-prop drafts. The change request phrases intent explicitly ("remove auto layout
    (flexbox) from this element") so the agent removes the flex-family classes rather than
    adding `block`.
- **Baseline alignment.** A small toggle adjacent to the matrix (`data-align-baseline`) drafting
  `align-items: baseline`. `normalizeAlign` learns to pass `baseline` through; when active, the
  matrix shows no active vertical dot and the toggle carries the active state.

### M-C — Unified Layout section (the structural move)

- One "Layout" section containing, in fixed order: **W row → H row (size modes + flex-child
  controls as today) → auto-layout cluster (add/remove, direction+wrap, gap, alignment) →
  Padding rows (H/V, expand to T/R/B/L)**. Padding always renders here, flex or not.
- Standalone Size and Padding sections are deleted; their row markup moves verbatim (same
  classes, same `expandKey: 'padding'`), so most `.panel-rows`-level test hooks survive.
  Section-count/title assertions are updated once.
- **Multi-select behavior preserved per-row:** W/H/Padding rows keep working in multi-select
  (relative deltas), the auto-layout cluster stays single-element-only (decision B6) and is
  hidden in multi — same rules as today, just co-resident in one section.
- Section list becomes: Layout → Margin (conditional) → Typography → Fill → Stroke → Appearance.
  Amendment appended to `docs/research/2026-07-04-panel-patterns.md`.

### M-D — Min/max sizing

- The W/H size-mode select gains **Add min… / Add max…** action items (Figma UI3 keeps min/max
  in the same dropdown as Fixed/Hug/Fill). Choosing one inserts a disclosure row beneath the
  W/H row (changed-from-default disclosure: min/max rows render only when the element has a
  non-default computed value or the user just added one). Clearing the field removes the
  constraint (drafts `max-*` to `none`, `min-*` to `auto` — their respective CSS initial
  values — and the request drops the utility).
- `UTILITY_PREFIXES` gains `min-width: 'min-w'`, `max-width: 'max-w'`, `min-height: 'min-h'`,
  `max-height: 'max-h'`; the numeric spacing scale token picker applies (Tailwind v4 sizes these
  off the spacing scale). Named container widths (`max-w-md` etc.) are out of scope for the
  picker's first pass — nearest-token still resolves numerically.
- No verifier changes: min/max verify through the normal computed-style path.

## Deferred / out of scope

- **Position section** (X/Y, rotation, constraints, "ignore auto layout" absolute toggle) —
  deferred with rationale above.
- **Effects (shadows), blend modes** — not part of this redesign.
- Named container-width tokens in the min/max picker (see M-D).
- Any change to change-request format, queue, MCP contract, or server code — this is a
  client-panel-only redesign.

## Testing

- Unit (jsdom, mirrored files): label/tooltip derivation (`cssHintFor` against
  `UTILITY_PREFIXES` fixtures), Margin visibility latch (zero → hidden, non-zero → shown,
  scrub-to-zero mid-edit → stays shown), remove-auto-layout draft semantics (both the
  discard path and the `display: block` path), baseline normalize pass-through, unified-section
  DOM order and multi-select row visibility, min/max utility emission in `request.ts`.
- Real-browser E2E on the demo app before each milestone merges (repo gotcha: jsdom cannot see
  flex layout or real computed styles) — script: select fixture elements, walk every renamed
  control, add + remove auto layout, verify computed styles and the queued request markdown.
- `npm test` (typecheck + full vitest) is the gate per milestone, as always.
