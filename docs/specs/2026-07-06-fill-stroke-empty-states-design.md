# Fill & Stroke empty states — design

**Date:** 2026-07-06
**Status:** Approved (brainstorm ratified: + drafts a default immediately; only the Fill row collapses, Text row keeps its own life; a matching − remove button ships in the same milestone)

## Problem

When a selected element has no background, the Fill row still renders a swatch reading `transparent`; when it has no border, the Stroke section renders W=0 / style `none` / a color row for a border that never paints. Figma's answer — and the ratified one here — is an empty state: just the section title with a `+` button on the right; clicking `+` adds a visible default and reveals the normal editing rows.

## Approach (chosen: A)

Refresh-driven toggle inside `Panel` (`src/client/panel.ts`). The +/− buttons are built once into the existing Fill/Stroke section title rows via the `createButton` factory (`src/client/ui/button.ts`), exactly like Layout's `−` remove-auto-layout button; `refreshFillStroke()` computes emptiness on every refresh and toggles `hidden` on rows and buttons. No new module (rejected B: a `FillStrokeSection` extraction would move more code than the ~60 lines of policy it owns), no generic `SectionSpec.emptyState` config (rejected C: two consumers, YAGNI).

`.panel-section` is already a `justify-content: space-between` flex row, so title buttons land on the right with **zero new CSS** (bundle budget: 244/250KB — CSS-string bytes count).

## Emptiness predicates (draft-aware, via `currentValue`)

- **Fill empty** ⇔ current `background-color` parses to alpha 0 — the same rule `colorDisplay` (`panel-token-ui.ts`) uses to claim the `transparent` keyword.
- **Stroke empty** ⇔ **no side paints**: every one of the four sides has `border-*-style: none` or `border-*-width` 0 — the same "never rendered" predicate `groupSelectionColors` applies to `border-top-color`. All four sides are checked (not just top) so a lone `border-bottom` divider still counts as having a stroke.

Both predicates read through `currentValue` (draft wins over computed, except during Compare), so a drafted fill flips the section to its populated state immediately, and Compare mode shows the *before* reality — consistent with every other Compare behavior.

## UI states

**Empty:**
- Fill: the Fill color row is hidden (`hidden` attr); the **Text row is untouched** — it has its own life. A `+` button shows in the Fill title.
- Stroke: both `.stroke-row` rows hide, **and so do the `⋯` expand button and any open BT/BR/BB/BL expand rows** — nothing to fine-tune on a border that doesn't exist. A `+` button shows in the Stroke title.

**Populated:** normal rows show; the title shows `−` instead of `+`. Button order in the title follows the Layout glyph convention (remove before expand): `Fill −`, `Stroke − ⋯`.

**Multi-select:** unaffected — Fill/Stroke sections are already hidden entirely in multi mode (replaced by Selection colors); the title buttons hide with their sections via the existing `sectionEls` mechanism.

**Button hooks:** `data-add-fill`, `data-remove-fill`, `data-add-stroke`, `data-remove-stroke` (test hooks — extend, don't rename), plus `aria-label`s and agent-vocabulary `title` tooltips matching the remove-layout precedent.

## + behavior (draft a default immediately)

- **Fill +**: drafts `background-color: #D9D9D9` (Figma's default fill gray). Instantly visible; the color picker / nearest-token machinery takes over from there.
- **Stroke +**: drafts `border-width: 1px` and `border-style: solid` on **all four sides** (the same width⇒solid pairing `draftSolidIfNone` already enforces). Color is left to compute (usually `currentColor`) so the stroke is immediately visible without guessing a palette color.

Both go through the standard `onBeforeEdit` → `drafts.apply` → `refresh` → `onEdited` cycle, so the row flips to populated and the − appears in the same refresh.

## − behavior (mirrors Layout's remove semantics)

- **Added this session** (a draft exists for the *anchor* prop — `background-color` for Fill, any `border-*-style` for Stroke; style is the anchor because adding a stroke always drafts it, while a width tweak on a stylesheet-real border never does) → **pure undo**: targeted `drafts.discard` of the fill/stroke prop set. The element returns to stylesheet reality; nothing to send. Accepted edge, identical to Layout's documented "(or display re-drafted this session)" behavior: re-drafting the anchor on a stylesheet-real fill/stroke and then clicking − undoes the drafts rather than drafting removal.
- **From the app's own CSS** → draft the removal: Fill drafts `background-color: transparent`; Stroke drafts `border-style: none` on all sides and discards any width/color drafts so the change request is just the removal (the request builder maps it to the `border-none`-family utility delta).

## Downstream

Nothing new. Drafts flow through the existing request builder, queue, dispatch, and verifier untouched. No server, MCP, or request-format changes.

## Testing

Additions to `tests/client/panel.test.ts` (jsdom — inline-style drafts and `hidden` toggles are fully visible to it):

1. Element with transparent background → Fill row hidden, `[data-add-fill]` visible, `[data-remove-fill]` hidden; Text row still visible.
2. Element with no painting border (including style set but width 0) → stroke rows hidden, `[data-expand]` for stroke hidden, `[data-add-stroke]` visible.
3. Element with only `border-bottom` → stroke section populated (four-side predicate).
4. Click `+` (fill) → `background-color: #D9D9D9` drafted, rows appear, buttons flip to −.
5. Click `+` (stroke) → 1px solid drafted on all four sides.
6. Click `−` after a session-added `+` → drafts discarded (pure undo, `drafts.current` returns null).
7. Click `−` on a stylesheet-real fill/stroke → removal drafted (`transparent` / `border-style: none`).
8. Click `−` on a stylesheet-real stroke whose *width* was tweaked this session (style anchor untouched) → removal drafted, width draft discarded — not a mere undo of the tweak.
9. Existing title-label tests (`section order…`, `Layout section TITLE stays visible…`) get `+` added to their glyph-strip before comparing labels.

Before merge: real-browser E2E pass against the demo app (jsdom cannot see cascade/computed styles — known gotcha; kill stale dev servers first), `npm test` root gate, `./scripts/check-prod-clean.sh` budget check.
