# Token affordance — hover `{ }` icon + named color tokens (2026-07-05)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Implements [docs/specs/2026-07-05-token-affordance-design.md](../specs/2026-07-05-token-affordance-design.md):
a visible, Figma-style (but curly-braces, not hexagon) token affordance on every token-backed
panel field. Numeric fields get a hover-revealed `{ }` icon that opens the existing TokenPicker
(the `=` shortcut stays); color rows get the same icon opening the same picker loaded with
**named color tokens** (swatch + name); the color value chip renders pill-styled whenever the
current color exactly matches a token.

**Goal:** discoverable raw-value-vs-token choice on every field the theme has a scale for.

**Architecture:** generalize `TokenEntry` to a union (numeric | color) with `'color' in entry`
narrowing — no generics, so panel.ts's existing mutual-exclusion monkey-patch of
`tokenPicker.open` keeps working untouched. The icon is a `<button class="token-btn">` living
inside `.nf` / `.color-row`, revealed purely by CSS `:hover`/`:focus-within` rules.

**Tech stack:** vanilla DOM + the overlay's string-const CSS, vitest + jsdom. No new deps.

## Global constraints (inherited, non-negotiable)

- Zero new runtime dependencies; no React in the overlay.
- Zero idle overhead: the icon reveal is pure CSS; buttons exist only inside the open panel
  (design mode on). No new window listeners outside popover-open lifetimes.
- Zero production footprint (client bundle is dev-served only — unchanged).
- Panel/overlay CSS class names are test hooks — **extend, don't rename**. `tp-*`, `nf-*`,
  `color-*`, `cp-*` classes keep their exact current names and rendering.
- Tailwind v4 reader only (`readTokens`/`readTheme` in `src/client/tokens.ts`) — untouched.
- jsdom can't compute the CSS hover reveal — unit tests assert structure/classes/handlers;
  a real-browser E2E pass against the demo app gates the merge (T6).
- Why-comments are load-bearing — preserve verbatim when touching nearby code.

## Plan-level adaptations of the spec (surfaced, not silent)

1. **Spec §4 (palette tooltips) is already implemented** — `colorpicker.ts` `renderPalette()`
   sets `swatch.title = token.name`. T6 pins it with a regression test; no production change.
2. **The color "pill" is derived, not bookkept.** The spec said "hex input becomes a read-only
   pill with Backspace-detach", mirroring numeric fields — but color rows have **no input**:
   they render swatch + a `.color-value` text chip (`buildColorRow`, panel.ts), and
   `colorLabel()` *already* shows the exact-match token name. So the pill is: `.color-value`
   gains a `color-value-pill` class whenever the current color exactly equals a token
   (derived on every `__refresh`), and detach is unnecessary — picking any raw color from
   the ColorPicker naturally leaves token-space and drops the pill styling. No `boundTokens`
   entries for colors, so no divergence/compare/verify bookkeeping changes at all.
3. **Multi-select gets no icons** — same rule as the existing `=` shortcut (`onTokenKey`
   is not wired in multi) and the existing "no token-pill bookkeeping across a
   multi-selection" refresh rule. Selection-colors rows (multi-only) are untouched.

---

## T1 — `{ }` icon in NumberField (`src/client/controls.ts`)

**Files:** modify `src/client/controls.ts`; test `tests/client/controls.test.ts`.

**Produces (later tasks rely on):**

```ts
// exported from controls.ts — shared by NumberField and panel.ts's color rows
export const TOKEN_ICON_SVG: string

export interface NumberFieldOpts {
  // ... existing opts unchanged ...
  /** When set, the field renders a hover-revealed `{ }` token button (`.token-btn`) after the
   * input. Fired on click — UNLIKE onTokenKey, NOT gated on pill state: clicking the icon on a
   * pill-bound field reopens the picker to swap tokens. Callers wire this only when the field
   * actually has token entries (spec: no entries → no icon, never a dead button). */
  onTokenOpen?: () => void
}
```

Contract:

- `TOKEN_ICON_SVG` — inline SVG string, two stroked brace paths, `viewBox="0 0 12 12"`,
  `fill="none" stroke="currentColor"` so CSS `color` themes it:

```ts
export const TOKEN_ICON_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true">' +
  '<path d="M4.6 1.5C3.2 1.5 3.7 3.1 3.3 4.5 3.1 5.4 2.4 5.7 1.8 6c.6.3 1.3.6 1.5 1.5.4 1.4-.1 3 1.3 3" fill="none" stroke="currentColor" stroke-linecap="round"/>' +
  '<path d="M7.4 1.5c1.4 0 .9 1.6 1.3 3 .2.9.9 1.2 1.5 1.5-.6.3-1.3.6-1.5 1.5-.4 1.4.1 3-1.3 3" fill="none" stroke="currentColor" stroke-linecap="round"/>' +
  '</svg>'
```

- In the constructor, when `opts.onTokenOpen` is set, append after `this.input`:
  `<button type="button" class="token-btn">` with `innerHTML = TOKEN_ICON_SVG` and
  `title = 'Use design token'`; `click` → `this.opts.onTokenOpen?.()`. No other listeners;
  no field without `onTokenOpen` gets the button (assert: `root.querySelector('.token-btn')`
  is null). The `=`/`onTokenKey` path is untouched (still `!pillBound`-gated).

Test sketch (`tests/client/controls.test.ts`):

- [ ] no `onTokenOpen` → no `.token-btn` rendered
- [ ] with `onTokenOpen` → button exists inside `.nf`, `title === 'Use design token'`, and
      `click()` fires the callback once
- [ ] after `bindToken('px-4')`, `click()` STILL fires `onTokenOpen` (swap-while-bound),
      while `=` keydown still does NOT fire `onTokenKey` (existing gate pinned)
- [ ] run `npx vitest run tests/client/controls.test.ts` (fail first, then green); commit

## T2 — TokenPicker color entries (`src/client/tokenpicker.ts`)

**Files:** modify `src/client/tokenpicker.ts`, `src/client/overlay.ts` (CSS); test
`tests/client/tokenpicker.test.ts`.

**Produces:**

```ts
/** Numeric scale entry (spacing/radius/text) — unchanged shape — OR a named color token. */
export type TokenEntry =
  | { label: string; px: number }      // e.g. { label: '4', px: 16 }
  | { label: string; color: string }   // e.g. { label: 'neutral-900', color: 'oklch(...)' }
```

Contract:

- `OpenOpts` unchanged (`entries: TokenEntry[]`, `onApply: (entry: TokenEntry) => void`) —
  consumers narrow with `'color' in entry`. This deliberately avoids a generic `open<E>()`:
  panel.ts monkey-patches `tokenPicker.open` for popover mutual exclusion, and a generic
  method would not survive that bind/reassign pattern cleanly.
- `renderList()` — numeric entries render **byte-identically** to today
  (`label` + ' — ' + `px`px, classes `tp-row-label`/`tp-row-px`). Color entries render:
  swatch `<span class="tp-row-swatch">` (`style.background = entry.color`) then the label
  span — no px span, no ' — ' separator.
- Search/keyboard/outside-click/Esc logic untouched (filters on `label` either way).
- CSS added to overlay.ts next to the existing `.tp-row` block:

```css
.tp-row-swatch {
  width: 12px; height: 12px; border-radius: 3px; flex: none;
  border: 1px solid rgba(255,255,255,0.15);
}
/* .tp-row is flex + justify-content:space-between (label left, px right). A color row has
 * only swatch + label — space-between would fling the label to the right edge, so pull it
 * back left by absorbing the slack. Extend-only: .tp-row's own declarations are untouched. */
.tp-row-swatch + .tp-row-label { margin-right: auto; }
```

  `.tp-row` is already `display:flex; align-items:center; gap:6px` — the swatch needs no
  margin of its own; the sibling rule above is the only layout addition.

Test sketch (`tests/client/tokenpicker.test.ts`):

- [ ] numeric entries: existing tests stay green untouched (rendering pinned)
- [ ] color entries: open with `[{ label: 'red-500', color: '#ef4444' }]` → row contains
      `.tp-row-swatch` with `style.background === 'rgb(239, 68, 68)'` (jsdom normalizes) and
      `.tp-row-label` text `red-500`; no `.tp-row-px`
- [ ] search filters color entries by label; Enter/click commit passes the color entry
      through `onApply` intact
- [ ] run `npx vitest run tests/client/tokenpicker.test.ts`; commit

## T3 — `colorTokenEntries` (`src/client/panel-specs.ts`)

**Files:** modify `src/client/panel-specs.ts`; test `tests/client/panel.test.ts` (panel-specs
has no own test file — `tokenEntriesFor` coverage lives in panel.test.ts; colocate).

**Produces:**

```ts
/** Named color-token entries for the color rows' `{ }` icon — null when the theme defines
 * no (parseable) color tokens, which suppresses the icon entirely (spec: no empty dropdowns). */
export function colorTokenEntries(tokens: Tokens): TokenEntry[] | null
```

Implementation (complete):

```ts
import { parseColor } from './tokens'   // add to the existing tokens.ts import

export function colorTokenEntries(tokens: Tokens): TokenEntry[] | null {
  const entries = tokens.colors
    .filter((t) => parseColor(t.value) !== null)
    .map((t) => ({ label: t.name, color: t.value }))
  return entries.length === 0 ? null : entries
}
```

Test sketch:

- [ ] maps `tokens.colors` to `{label, color}` entries preserving `readTokens`' sorted order
- [ ] unparseable token value (e.g. `var(--indirect)`) is filtered out
- [ ] empty color set → null
- [ ] run `npx vitest run tests/client/panel.test.ts`; commit

## T4 — numeric field + gap icon wiring (`src/client/panel.ts`)

**Files:** modify `src/client/panel.ts`, `src/client/overlay.ts` (CSS); test
`tests/client/panel.test.ts`.

Contract:

- `buildField(spec)`: hoist the existing `onTokenKey` closure body into a local
  `const openTokenPicker = () => { ... }` (verbatim body — entries lookup, `tokenPicker.open`,
  onApply committing + `bindToken` + `boundTokens.set`). Inside onApply add the union guard
  first: `if ('color' in entry) return` (numeric fields never receive color entries; the
  guard is for type narrowing). Wire:
  - `onTokenKey: multi ? undefined : openTokenPicker` (unchanged behavior), and
  - `onTokenOpen: !multi && tokenEntriesFor(spec, readTheme(), readTokens()) !== null ? openTokenPicker : undefined`.
  The build-time `tokenEntriesFor` probe is what keeps opacity / Stroke-W (border-width)
  fields icon-free — same null gate the `=` handler already uses at open time.
- Gap field (the bespoke NumberField in `buildLayoutSection`, wired at panel.ts ~756): same
  treatment — hoist its onTokenKey body, add `onTokenOpen` with the same
  `tokenEntriesFor(GAP_SPEC, ...) !== null` gate, `if ('color' in entry) return` guard in
  its onApply.
- `pillLabelFor(spec, entry)` — signature keeps `TokenEntry`; it reads only `.label`, no change.
- `boundTokens` map type stays `Map<string, { label: string; px: number }>` — colors never
  enter it (adaptation #2).
- Token-button CSS added to overlay.ts beneath the `.nf-pill` block (shared by T5's rows):

```css
.token-btn {
  display: none; flex: none; width: 16px; height: 16px; padding: 0;
  align-items: center; justify-content: center;
  background: transparent; border: none; color: #9A9A9A; cursor: pointer;
}
.token-btn:hover { color: #F5F5F5; }
.token-btn svg { width: 11px; height: 11px; display: block; }
.nf:hover .token-btn, .nf:focus-within .token-btn, .color-row:hover .token-btn { display: flex; }
```

Test sketch (`tests/client/panel.test.ts`, using the existing theme/tokens fixtures):

- [ ] PX field root contains `.token-btn`; opacity field ('O') and Stroke width field ('W')
      do NOT (tokenEntriesFor-null gate)
- [ ] clicking PX's `.token-btn` opens the token popover (`.token-popover` not hidden) with
      spacing entries
- [ ] pick entry → same end state as the existing `=` flow tests: draft applied, `.nf-pill`
      bound with `px-4`-style label, boundTokens survives refresh (reuse existing assertions)
- [ ] with a pill already bound, clicking the icon re-opens the picker; picking a different
      entry swaps the pill label and drafted value
- [ ] multi-select: no `.token-btn` rendered on any field
- [ ] gap field (flex element fixture): has `.token-btn`, same open/apply flow
- [ ] run `npx vitest run tests/client/panel.test.ts`; commit

## T5 — color rows: icon, dropdown, derived pill (`src/client/panel.ts`)

**Files:** modify `src/client/panel.ts`, `src/client/overlay.ts` (CSS); test
`tests/client/panel.test.ts`.

Contract:

- `buildColorRow(opts)`: after `valueEl`, when `colorTokenEntries(readTokens()) !== null`
  at build time, append `<button type="button" class="token-btn">` (`innerHTML =
  TOKEN_ICON_SVG` imported from controls.ts, `title = 'Use design token'`). Click:

```ts
tokenBtn.addEventListener('click', () => {
  const entries = colorTokenEntries(readTokens())
  if (!entries || !this.el) return
  this.tokenPicker.open({
    anchor: row,
    entries,
    onApply: (entry) => {
      if (!('color' in entry)) return
      if (!this.el) return
      this.onBeforeEdit(this.el)
      opts.onPick(entry.color)   // exact token value ⇒ request.ts emits bg-neutral-900 etc.
      this.refresh()
      this.onEdited()
    },
  })
})
```

  (Mirrors the swatch-click → colorPicker.onPick flow one block above it; the panel's
  existing `tokenPicker.open` monkey-patch auto-closes the ColorPicker for mutual exclusion.)
- Derived pill: split the exact-match half out of `colorLabel` into
  `private colorTokenName(css: string): string | null` (returns the token name only for a
  fully-opaque exact `nearestColorToken` hit — preserve the existing alpha-guard why-comments
  verbatim); `colorLabel` calls it. In the row's `__refresh`, toggle:
  `valueEl.classList.toggle('color-value-pill', this.colorTokenName(css) !== null)`.
- All three `buildColorRow` callers (Fill, Text, Stroke Color) get the icon for free.
  Selection-colors (multi) rows don't use `buildColorRow` — untouched by design.
- CSS (overlay.ts, next to `.color-value`; palette matches `.nf-pill`):

```css
.color-value-pill {
  background: rgba(13,153,255,0.15); color: #7CC4FF;
  border-radius: 4px; padding: 1px 5px;
}
```

Test sketch (`tests/client/panel.test.ts`):

- [ ] Fill row contains `.token-btn` when theme has color tokens; absent when the fixture
      theme defines none
- [ ] click icon → `.token-popover` opens listing color entries with `.tp-row-swatch`
- [ ] pick `red-500` → `background-color` draft === the token's exact value; row's
      `.color-value` shows `red-500` and carries `.color-value-pill`
- [ ] pick a raw color via the ColorPicker (existing flow) that matches no token → pill
      class absent, hex label shown (derived-state round trip)
- [ ] Stroke Color row: pick drafts ALL four `border-*-color` longhands (mirrors existing
      swatch-flow test)
- [ ] request end-to-end pin: after a token pick, the built change request's after-utility is
      the token form (`bg-red-500`) with no arbitrary-value bracket — extend an existing
      panel→request test rather than a new harness
- [ ] run `npx vitest run tests/client/panel.test.ts`; commit

## T6 — palette-tooltip pin, docs, gate, E2E

**Files:** test `tests/client/colorpicker.test.ts`; modify `CLAUDE.md`.

- [ ] colorpicker.test.ts: pin the (already-shipping) spec §4 behavior — every `.cp-swatch`
      has `title === token.name`
- [ ] CLAUDE.md client-modules table: `tokenpicker.ts` row — "`=`-triggered" becomes
      "`=` / `{ }`-icon-triggered searchable Tailwind token picker (numeric scales + named
      colors); bound values render as pills"
- [ ] full gate: `npm test` (typecheck + suite) from the repo root, `npm run build`
- [ ] real-browser E2E against the demo app (`npm run build` first, then restart any running
      dev server — Vite caches the virtual client module; check `lsof -iTCP:5173` for stale
      servers): hover a padding field → `{ }` appears; click → dropdown; pick token → pill;
      hover Fill row → icon; pick `red-500` → value chip pills; Send → queue item's markdown
      names `bg-red-500`
- [ ] commit; hand back for merge decision (merge always belongs to the user)

## Explicitly out of scope (spec §5)

Tailwind v3 config resolution; non-Tailwind custom CSS variables; token affordances for
opacity/border-width (no Tailwind scale); any change to `request.ts`, `verifier.ts`, the
queue, or the MCP surface — the token-exact request path already exists and is only *pinned*
by T5's last test.
