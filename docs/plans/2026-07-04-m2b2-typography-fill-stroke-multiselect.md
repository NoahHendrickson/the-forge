# M2b-2 — Typography, Fill/Stroke, token picker, multi-select (2026-07-04, overnight Track B)

Builds on Track A's dark panel. Section order stays fixed forever (research doc): Layout → Size → Padding → Margin → **Typography → Fill → Stroke** → Appearance. New sections render always, hidden via the `hidden` attribute when inapplicable.

## Global constraints

- All 321 tests stay green; class hooks preserved; new classes additive.
- Drafts remain inline styles via `DraftStore.apply(el, prop, cssValue)` — no new draft mechanics.
- Change-request pipeline (`request.ts` → `renderMarkdown`) must handle color values correctly; that's what Task B0 guarantees BEFORE any color drafts exist.
- Token-first: color and numeric edits should land on the Tailwind scale whenever the user picks from tokens; `suggestUtility`/`findExistingUtility` stay the single mapping layer for requests.
- Dark-chrome styling per Track A's token comment block in overlay.ts; accent `#0D99FF`.

## Tasks

### B0 (PREREQUISITE) — keyword allowlist in request.ts

Replace the keyword-shape regex passthrough (`/^[a-z-]+$/i` at request.ts:117) with an explicit allowlist. Passthrough applies ONLY to: `auto`, `fit-content`, `min-content`, `max-content`, `flex`, `inline-flex`, `row`, `column`, `row-reverse`, `column-reverse`, `wrap`, `nowrap`, `wrap-reverse`, `flex-start`, `flex-end`, `center`, `space-between`, `space-around`, `space-evenly`, `stretch`, `baseline`, `normal`, `none`, `solid`, `dashed`, `dotted`. Export the set as `KEYWORD_PASSTHROUGH` for tests. Tests: `red` / `blue` drafts do NOT pass through (afterCss = measured computed rgb); `auto` still does; case-insensitivity preserved.

### B1 — NumberField v3 + panel nits (foundation)

`controls.ts`:
- `destroy()`: removes any window listeners (scrub handlers); Panel calls it when rebuilding fields.
- Escape in the input blurs the input and stops propagation (selection survives; DesignMode's Escape-deselect must not fire).
- `onRelative?: (apply: (current: number) => number) => void` — when set and the entry is a leading-op expression (`+8`, `*2`), call it with the closure instead of onInput(evaluated). Plain numbers still hit onInput.
- Scrub relative mode: `onScrubStart?: () => void` fires at mousedown; when `onRelative` is set, each scrub move calls `onRelative(c => c + totalDeltaSinceStart)` semantics must be idempotent per move — the panel is responsible for applying against the scrub-start baseline it snapshotted in onScrubStart (spec the exact contract in the brief).
- Pill display API (for B5): `bindToken(label: string)` renders the input as a pill (input readonly, value = label, class `nf-pill`); `detach()` returns to numeric display; Backspace/Delete on a pill calls `onDetach?()`.

`panel.ts` nits:
- Expand state persists across selections (instance Map keyed by expandKey; buildBody honors it).
- W/H fields show the `auto` keyword when the AUTHORED value is auto (inline style or draft) even when a computed px exists.

### B2 — tokens.ts v2: color/text scales, nearest color, contrast (pure logic)

- `readTokens()`: walk same-origin `document.styleSheets` collecting custom properties from rule styles: `--color-*` → `{ name, value }[]` (resolve var values via getComputedStyle(document.documentElement)); `--text-*` (font-size scale); reuse existing `--spacing`/`--radius-*`. Handle cross-origin sheets (skip on SecurityError).
- `parseColor(css) → {r,g,b,a} | null` (hex 3/4/6/8, rgb/rgba(), named via canvas-free lookup table only for the CSS basic 16 — computed styles give rgb() anyway).
- `nearestColorToken(rgb, tokens) → { name, value, distance }` (sRGB distance is fine v1).
- `contrastRatio(fg, bg) → number` (WCAG 2.1 relative luminance; alpha-composite fg over bg first).
- `suggestUtility` gains `background-color`/`color`/`border-color` support: exact token match → `bg-red-500`/`text-…`/`border-…` (tokenExact true), else arbitrary `bg-[#hex]` (tokenExact false). Prefix map: background-color→bg, color→text, border-color→border.
- All pure functions, exhaustive unit tests.

### B3 — Typography section

Visible when the element has a direct non-whitespace text node child. Controls (research: type scales + named weights, NO sliders):
- Family: `.size-mode`-styled select — options: current computed family (first), families from `document.fonts` (unique, loaded), `system-ui`, `serif`, `monospace`. Drafts `font-family`.
- Weight: select of the 9 named weights (`100 Thin` … `900 Black`), drafts `font-weight`.
- Size + Line height on one row (NumberFields, `S`/`LH`); letter-spacing (`LS`, can be negative) + Align segment (`Left/Center/Right`, drafts `text-align`) on the next. Line-height computed `normal` displays as `auto`-style keyword; drafting writes px. Letter-spacing `normal` → 0.
- Section title `Typography`.

### B4 — Fill & Stroke sections + color picker popover

- `colorpicker.ts`: `ColorPicker` popover component (shadow-panel-internal, absolutely positioned, one instance reused). Anatomy: SV area (CSS-gradient square, pointer-driven), hue slider, hex input, Tailwind palette grid (from `readTokens().colors`, grouped by family), nearest-token hint chip (click = snap), contrast ratio line (ratio + AA/AAA/fail badge) computed against a caller-provided comparison color, Esc/outside-click closes. Emits `onPick(cssValue, meta: { token?: string })` live (preview-as-you-drag).
- Fill section: row `Fill` = swatch + value (token name if exact else hex) for `background-color`; row `Text` = same for `color` (hidden when element has no text child). Swatch click opens picker anchored to the row; contrast comparison: Fill ↔ current text color; Text ↔ effective background (walk up ancestors for first non-transparent bg).
- Stroke section: row 1 `W` linked border-width NumberField + style select (`none/solid/dashed/dotted`); row 2 color swatch; expand `⋯` → per-side widths (BT/BR/BB/BL). Drafting a width when computed style is `none` also drafts `border-style: solid` (matches DevTools behavior).
- Swatches: `.swatch` 16×16 rounded with checkerboard under transparency.

### B5 — `=` Tailwind token picker with pills

- `tokenpicker.ts`: searchable dropdown popover (same positioning infra as ColorPicker). Opens on `=` keydown inside a NumberField input. Content per field kind: spacing fields (padding/margin/gap/W/H) → spacing scale (`0.5→2px` … `96→384px`, computed from `--spacing`); radius fields → radius tokens; font-size field → `--text-*` scale. Type-to-filter; Enter/click applies.
- Applying: drafts the token's px value AND calls `bindToken(name)` so the field renders a pill; Backspace detaches (field returns to the number, draft unchanged). Pills are display-only state — the request pipeline stays untouched (exact px hits `suggestUtility`'s exact-token path).
- Pill visual: accent-tinted chip (`rgba(13,153,255,0.15)` bg, `#7CC4FF` text, radius 4).

### B6 — Multi-select with relative deltas + Selection colors

- `index.ts`/inspector: Shift-click toggles membership in a selection set (plain click = single-select as today). Overlay: `showSelectOutlines(rects: DOMRect[])` (pooled divs like ripples; single-rect path unchanged).
- Panel multi-mode (`show(els: TaggedElement[], …)` — keep single-el signature working): fields aggregate values → equal shows value, divergent shows `Mixed`. Edits:
  - Plain number → absolute apply to ALL selected.
  - Leading-op expression → `onRelative` per element against each element's own current value (`Mixed+8` math).
  - Scrub → relative per element from scrub-start baselines (panel snapshots all baselines in `onScrubStart`).
- Section visibility in multi-mode: a section shows when applicable to ANY selected element; inapplicable elements are skipped on apply (e.g. Layout controls apply only to flex members).
- Selection colors section (multi-mode only, replaces Fill/Stroke): unique colors across selection (bg/text/border) with usage counts; click swatch → ColorPicker; picking REPLACES that color on every element/property that used it (per-element drafts).
- Header shows `N selected`; Compare/Reset act on all.

### B7 — Controller E2E + screenshots (real browser)

Typography edits on a heading; fill/text color with contrast readout + token snap; stroke on a card; `=` picker binding `p-4` pill + Backspace detach; multi-select two cards → `+8` padding relative math verified per-element; Selection colors replace; change request markdown shows `bg-…`/`text-…` utilities with tokenExact; console clean. After-screenshots per state into docs/screenshots/track-b/.

## Out of scope (parked)

Effects/gradients/position sections (spec v2); alpha channel UI in picker (parse-only); icon segments; scrub pointer-lock/speed-modulation polish; instance-vs-component scope question (spec §10).
