# Token affordance — hover icon + named color tokens

**Date:** 2026-07-05
**Status:** Approved (brainstorm ratified by user)

## Problem

The panel already reads the project's Tailwind v4 theme at runtime (`src/client/tokens.ts` — `--color-*`, `--text-*`, `--spacing`, `--radius-*` from the live stylesheets) and already has a searchable token picker for spacing/radius/font-size fields (`src/client/tokenpicker.ts`). But the picker's only trigger is pressing `=` inside a numeric field — invisible unless you know the shortcut — and color fields have no named-token selection at all: the color picker shows the project palette as anonymous swatches.

Users should be able to choose between a raw value and a project token from any token-backed field, discoverably. Figma's ratified pattern: a hexagon icon appears at the right edge of a field on hover; clicking it opens a searchable dropdown of type-appropriate variables; an applied variable renders as a pill with a detach action.

## Decisions (user-ratified)

- **Color affordance: "Both"** — a hover icon on the Fill/Stroke color rows opening a named color-token dropdown, *and* token-name tooltips on the existing color-picker palette swatches.
- **Token source: Tailwind v4 only** for this milestone. v3 config parsing and arbitrary custom CSS variables are explicitly out of scope (future milestone, own design).
- **Color selection binds as a token pill**, identical semantics to the existing numeric pills; the change request names the token utility (`bg-neutral-900`).
- **Approach A:** generalize the existing `TokenPicker` rather than cloning a color variant or skipping the color dropdown.

## Design

### 1. Hover token icon (new trigger)

- Every field whose spec yields token entries gets a small icon button docked at the right edge of the input row. The glyph is a curly-braces token icon (`{ }`, inline SVG) — deliberately NOT Figma's hexagon (user-ratified); braces read as "token/variable" to The Forge's developer audience and echo the `{token.name}` notation of the design-token world.
- Revealed purely via CSS on row `:hover` / `:focus-within` — no JS listeners for the reveal. Buttons exist only while the panel is open (design mode on), preserving the zero-idle-overhead constraint.
- Gate is the existing one: `tokenEntriesFor(spec, theme, tokens) === null` → no icon rendered (opacity, border width, and any scale the theme doesn't define stay icon-free).
- The `=` keyboard shortcut remains as-is.
- **Pill-bound behavior differs from `=`:** the icon remains active while a field is pill-bound and reopens the picker to swap tokens (the `=` path stays dead while bound, unchanged).

### 2. TokenPicker generalization

- `TokenEntry` grows an optional color variant: `{ label: string; px: number }` (numeric, unchanged) or `{ label: string; color: string }` (e.g. `{ label: 'neutral-900', color: '#171717' }`).
- Row rendering: color entries show a swatch square + name (new `tp-row-swatch` class); numeric entries keep the existing `label — px` rendering.
- Search, keyboard navigation, outside-click close, Esc close: untouched.
- Existing `tp-*` class names are test hooks — extended, never renamed.

### 3. Color rows: full token loop

- Every color-bearing row gets the icon (Fill's background/text color and Stroke's border color — whichever color rows the panel renders), opening the shared picker with entries built from `tokens.colors`.
- On apply: draft the token's resolved color value; the hex input becomes a read-only token pill showing the token name, Backspace/Delete detaches back to raw hex — mirroring `NumberField`'s pill contract.
- Pill bookkeeping joins the existing `boundTokens` map in `panel.ts` with the same rules: divergence between computed value and token value drops the pill; compare-mode hides it; explicit detach is not resurrected by refresh.
- Request emission needs no builder changes: the drafted value equals the token value exactly, so `suggestUtility` already resolves `tokenExact: true` and emits the token utility (`bg-neutral-900`, `text-…`, `border-…`).

### 4. Color picker palette upgrade

- Palette swatches inside the existing `ColorPicker` popover get the token name as a `title` tooltip. The nearest-token hint already names tokens; no other picker changes.

### 5. Out of scope

- Tailwind v3 (`tailwind.config.js`) theme resolution.
- Non-Tailwind custom CSS variables (`--brand-primary`).
- Token affordances for properties with no Tailwind scale (opacity, border width).
- Any new runtime dependency (hard constraint) or React (overlay stays vanilla DOM).

## Error handling

- No tokens found (theme missing `--spacing`, empty color set): icons simply don't render — the existing null-gate covers it; no error states, no empty dropdowns.
- Token whose value no longer parses (`parseColor` null): filtered out of entries, same as the palette already does.

## Testing

- Unit (jsdom, mirroring `src/`): icon presence/absence per field spec; color entry construction from `tokens.colors`; color pill bind/detach/divergence/compare interactions; swap-while-bound via the icon; `tp-row-swatch` rendering.
- jsdom cannot see the CSS hover reveal — unit tests assert structure and classes only.
- Real-browser E2E against the demo app before merge: hover reveal, dropdown open/select, pill render, sent request carries the token utility.
