# UI catalog: tokens, atom factories, and a Storybook for the overlay

**Date:** 2026-07-05
**Status:** Draft — pending user review

## Goal

Make the overlay's visual design centrally manageable: edit a button, input, or color once and it updates consistently everywhere it appears — with a browsable Storybook catalog of the atomic pieces so drift is visible immediately.

Explicitly **not** the goal: adopting Base UI/shadcn (React-based; conflicts with the zero-runtime-dependency constraint, the 250KB package budget, and shadow-DOM portaling), restyling the panel, or building a general-purpose component library. We borrow the *structure* of [blank-slate-ui](https://github.com/NoahHendrickson/blank-slate-ui) (small curated set, colocated stories, one token sheet, Storybook as the doc site) with vanilla TS instead of React.

## Current state (why this design)

- The overlay UI is hand-rolled vanilla TS in a shadow root. Scrub inputs (`NumberField`), segmented controls (`SegmentField`), and the 9-dot `AlignMatrix` are already single-source classes — they need stories, not refactoring.
- Buttons are **not** single-source: ~14 `document.createElement('button')` call sites across `overlay.ts`, `panel.ts`, `layout-controls.ts`, `colorpicker.ts`, each styling itself by class.
- Native `<select>` dropdowns (`.size-mode`) are created inline at 4 sites in `panel.ts`.
- All styling is one `CSS` string const in `overlay.ts` with hardcoded colors. The palette is coherent (~10 distinct intentional values: accent `#0D99FF`/`#7CC4FF`, text tiers `#F5F5F5`/`#D4D4D4`/`#B8B8B8`/`#9A9A9A`, surfaces `#2C2C2C`/`#383838`, white-alpha borders, black-alpha shadows) but declared literal-by-literal — a color change today is a find-and-replace across ~90 occurrences.

## Design

Three pieces, in dependency order:

### 1. Design tokens (CSS custom properties)

At the top of the `CSS` const in `overlay.ts`, declare the palette and type scale as custom properties on `:host`, and replace hardcoded literals throughout the sheet with `var(...)` references:

```css
:host {
  --fg-accent: #0D99FF;      --fg-accent-hover: #7CC4FF;
  --fg-primary: #F5F5F5;     --fg-secondary: #D4D4D4;
  --fg-muted: #B8B8B8;       --fg-faint: #9A9A9A;
  --surface-1: #2C2C2C;      --surface-2: #383838;
  --border-subtle: rgba(255,255,255,0.06);
  --border-strong: rgba(255,255,255,0.12);
  /* …complete set enumerated during implementation… */
  --font-size-xs: 10px; --font-size-sm: 11px; --font-size-md: 12px;
}
```

Purely mechanical; computed styles must be pixel-identical before/after (verified in a real browser — jsdom can't see the cascade). One-off alpha values that are visibly incidental (single-use focus rings etc.) may stay literal; the token set covers the repeated, intentional values. Naming is finalized during implementation, not here.

`:host { all: initial }` already isolates us from the host page, and custom properties declared on `:host` are visible to the whole shadow tree — no inheritance surprises.

### 2. Atom factories — `src/client/ui/`

A new folder holding the single sources of truth for atoms that today are created ad-hoc:

- `ui/button.ts` — `createButton({ variant, label?, title? })` with the variants the overlay actually uses (approximately: `primary` (Send), `ghost` (Copy/Compare/Reset), `icon` (small square icon buttons), plus the toggle FAB either as a variant or left bespoke if it shares nothing). Existing class names are **kept verbatim** — they are test hooks and CSS anchors (extend, don't rename). The factory centralizes creation; the CSS stays in the one stylesheet.
- `ui/select.ts` — `createSelect({ options, value, onChange })` producing the `.size-mode` select; the 4 inline sites in `panel.ts` switch to it.

Existing single-source atoms (`NumberField`, `SegmentField`, `AlignMatrix`, swatch buttons, color rows) stay where they are — moving files churns imports/tests for zero consistency gain. The rule going forward: **a new button or select anywhere in the overlay goes through `ui/`**.

Call sites swapped: `overlay.ts` (5 buttons), `panel.ts` (buttons + 4 selects), `layout-controls.ts` and `colorpicker.ts` only where the element genuinely is a shared atom (segment buttons, matrix dots, and palette swatches are internal to their controls — they keep their local creation).

### 3. Storybook — `html-vite`, devDependencies only

Installed inside `packages/vite-plugin` (no new workspace package). Nothing enters `dist/` or the npm package (`files: ["dist"]`); the prod-clean check and package budget are untouched.

```
packages/vite-plugin/
  .storybook/main.ts, preview.ts    # framework: @storybook/html-vite
  stories/
    mount.ts                  # shared shadow-root mount helper
    tokens.stories.ts         # palette swatches + type specimen, rendered from the token values
    button.stories.ts         # every variant × states (hover/disabled)
    select.stories.ts
    number-field.stories.ts   # plain / auto / pill-bound / relative-entry
    segment-field.stories.ts
    align-matrix.stories.ts
    swatch.stories.ts         # color row + swatch; picker popover as one story
```

**`mount.ts` is the fidelity guarantee:** it creates a host element, attaches a shadow root, injects the same `CSS` const the product injects, and mounts the real control class/factory inside. Stories render the actual product atoms — the catalog cannot drift from the overlay because they share one implementation and one stylesheet.

Script: `"storybook": "storybook dev -p 6006"` in the package, runnable as `npm run storybook -w @the-forge/vite`.

**Testing scope:** stories only — no play functions, no a11y gate initially (deliberately minimal; bolt on later if the catalog earns it). The existing vitest suite remains the merge gate; factory swaps are covered by existing panel/overlay tests continuing to pass, plus small new unit tests for `createButton`/`createSelect` mirroring `tests/client/`.

## Error handling / risk

- **Visual regression risk** is concentrated in the token extraction (step 1). Mitigation: real-browser E2E pass against the demo app before merge (per project gotcha — jsdom can't verify this), comparing a sample of computed colors before/after.
- **Test-hook stability:** factories keep every existing class name; tests that select by class continue to work unmodified.
- **Storybook/Vite compatibility:** Storybook ≥9 `html-vite` supports Vite 6 (already a devDependency). If a version conflict emerges, pin Storybook to the newest version compatible with Vite 6 rather than upgrading Vite.

## Milestones / sequencing

Single milestone, three PR-sized steps in order: tokens → factories → Storybook. Each step leaves the suite green; Storybook lands last so its stories exercise the factories, not the ad-hoc call sites.

## Success criteria

1. Changing `--fg-accent` in one place recolors every accent use in the overlay.
2. Changing `createButton`'s markup/classes updates every action button in the overlay.
3. `npm run storybook -w @the-forge/vite` shows tokens + 6 atom catalogs rendering the real controls inside a shadow root.
4. `npm test` and `./scripts/check-prod-clean.sh` pass unchanged; published package contents identical.
