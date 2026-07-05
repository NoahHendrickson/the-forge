# UI catalog — tokens, atom factories, Storybook (2026-07-05)

Spec: [docs/specs/2026-07-05-ui-catalog-design.md](../specs/2026-07-05-ui-catalog-design.md). Goal: edit a button/select/color once, it updates everywhere; a Storybook catalog renders the real controls so drift is visible. No Base UI/shadcn (React — violates zero-dep + budget constraints); we take blank-slate-ui's *structure* only.

**Sequencing:** three tasks, in order, each leaving `npm test` green and each its own commit. Storybook lands last so stories exercise the factories. Real-browser E2E check after Task 1 and Task 2 (jsdom can't see the cascade — project gotcha; kill stale dev servers first, check `lsof -iTCP:5173`).

## Diagnosis (why these three tasks)

- The `CSS` const in `src/client/overlay.ts` already *documents* its palette in a comment block ("Design tokens … used literally throughout this file") — but declares every value literally: `rgba(255,255,255,0.12)` ×12, `#F5F5F5` ×9, `#0D99FF` ×8, etc. A palette edit is a ~90-site find-and-replace. Task 1 makes the comment executable.
- Buttons are born at 14 `document.createElement('button')` sites across 4 files, styled purely by context selectors (`#status button`, `:where(#panel) button`); `<select class="size-mode">` is hand-assembled at 4 sites in `panel.ts` with copy-pasted option loops. Tasks 2 centralizes creation without touching styling or class hooks.
- `NumberField`, `SegmentField`, `AlignMatrix`, swatches are already single-source — they get stories, not refactoring.

## Contract

### Task 1 — Design tokens in the overlay stylesheet

`src/client/overlay.ts` only. Add a second `:host` rule directly under `:host { all: initial }` (`all` does not reset custom properties, but a separate rule keeps reset and tokens visually distinct) declaring the token set, then replace every occurrence of each value in the sheet with `var(...)`:

| Token | Value | Notes |
| --- | --- | --- |
| `--surface` | `#2C2C2C` | panel/toggle/status bg |
| `--surface-2` | `#383838` | |
| `--control` | `rgba(255,255,255,0.06)` | elevated control bg |
| `--control-hover` | `rgba(255,255,255,0.12)` | also border-hover |
| `--control-active` | `rgba(255,255,255,0.16)` | |
| `--border-panel` | `rgba(255,255,255,0.09)` | |
| `--border-strong` | `rgba(255,255,255,0.15)` | toggle/status border, scrollbar thumb |
| `--separator` | `rgba(255,255,255,0.07)` | section rules |
| `--text-primary` | `#F5F5F5` | |
| `--text-secondary` | `#D4D4D4` | |
| `--text-title` | `#E8E8E8` | section titles |
| `--text-faint` | `#B8B8B8` | |
| `--text-muted` | `#9A9A9A` | |
| `--accent` | `#0D99FF` | |
| `--accent-soft` | `#7CC4FF` | |
| `--accent-outline` | `rgba(13,153,255,0.75)` | hover outline |
| `--positive` | `#62C073` | `#watch.live` |
| `--ripple` | `#E2954A` | unifies the `#e2954a` case variant; **preserve the "must stay distinct from selection accent" why-comment** |
| `--font-ui` | `system-ui, sans-serif` | used inside `font:` shorthands via `var()` (valid: custom properties substitute before shorthand parsing) |
| `--font-mono` | `ui-monospace, monospace` | |
| `--text-xs` / `--text-sm` / `--text-md` | `10px` / `11px` / `12px` | type scale, used in `font:` shorthands |

Sweep rule: any *other* repeated or clearly-intentional gray/blue literal found during the pass joins the table (e.g. `#A8A8A8` on `#watch` → fold into `--text-muted`-adjacent or its own token — implementer's call, recorded in the commit message). Stays literal: structural gradient endpoints in the color picker (`#000`/`#fff`/`red`), `--cp-hue` machinery, black shadow alphas, single-use incidental alphas (`0.05`, `0.08`, `0.18`, `0.28`, `0.6`), accent-alpha fills `rgba(13,153,255,0.15/0.25)`. Rewrite the palette comment block to describe the *token names*, not repeat the values.

**Tests** (extend `tests/client/overlay.test.ts`; jsdom can't cascade, so assert on the CSS string — established pattern from the `[hidden]` rule test):

```ts
const count = (s: string) => CSS.split(s).length - 1
it('declares the palette once as custom properties', () => {
  expect(CSS).toContain('--accent: #0D99FF')
  expect(count('#0D99FF')).toBe(1)              // declaration only — every use is var(--accent)
  expect(count('rgba(255,255,255,0.12)')).toBe(1)
  expect(count('#F5F5F5')).toBe(1)
  expect(count('e2954a')).toBe(0)               // lowercase variant unified
  expect(count('#E2954A')).toBe(1)
})
```

**E2E check (demo app, real browser):** with design mode on and a flex card selected, sample computed `background-color`/`color`/`border-color` of `#toggle`, `#status button`, `#panel`, `.panel-section`, an `.nf` input, and an `.am-active` dot — byte-identical before/after the refactor. Also confirm `font-size` on a `.nf` input and `.panel-head-src` (the var-in-`font:`-shorthand risk).

### Task 2 — Atom factories: `src/client/ui/`

New folder; two files; no CSS changes; every existing class name and attribute hook kept verbatim.

```ts
// src/client/ui/button.ts — the single place overlay buttons are born.
export interface ButtonOpts {
  label?: string
  title?: string
  /** Additive class(es) — appended, never replacing context styling. */
  className?: string
}
export function createButton(opts: ButtonOpts = {}): HTMLButtonElement

// src/client/ui/select.ts — the .size-mode dropdown.
export interface SelectOpts {
  /** Appended after the base 'size-mode' class, e.g. 'type-weight'. */
  className?: string
  options: ReadonlyArray<{ value: string; label: string }>
  value?: string
  onChange: (value: string) => void
}
export function createSelect(opts: SelectOpts): HTMLSelectElement
```

Call sites swapped (attribute wiring like `data-expand`/`data-add-layout`, ids, and event listeners stay at the call site — the factory owns markup, not behavior):

- `overlay.ts`: `toggle`, `sendButton`, `copyButton`, `compareAllButton`, `resetAllButton` (5)
- `panel.ts`: `compareButton`, `resetButton` (:53–54), expand `⋯` button (~:595), `addBtn` (~:625); selects: `type-family` (~:763), `type-weight` (~:789), `stroke-style` (~:976), size-mode (~:1157) — the four option-building loops collapse into `createSelect` calls (family options are computed at the call site and passed in)
- **Not** swapped (internal to their controls, per spec): `layout-controls.ts` segment buttons + matrix dots, `colorpicker.ts` palette swatches, panel swatch buttons (~:885, :1079)

**Tests:** new `tests/client/ui.test.ts` mirroring `src/client/ui/`:

```ts
it('createButton sets label, title, additive class', () => {
  const b = createButton({ label: 'Reset all', title: 'Reset', className: 'x' })
  expect(b.tagName).toBe('BUTTON'); expect(b.textContent).toBe('Reset all')
  expect(b.title).toBe('Reset');    expect(b.classList.contains('x')).toBe(true)
})
it('createSelect renders options, base class, initial value, and fires onChange', () => {
  const seen: string[] = []
  const s = createSelect({ className: 'stroke-style', value: 'dashed',
    options: [{ value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }],
    onChange: v => seen.push(v) })
  expect(s.className).toBe('size-mode stroke-style')
  expect(s.value).toBe('dashed')
  expect([...s.options].map(o => o.value)).toEqual(['solid', 'dashed'])
  s.value = 'solid'; s.dispatchEvent(new Event('change'))
  expect(seen).toEqual(['solid'])
})
```

Plus the whole existing suite green unmodified — that's the proof the swap preserved hooks. **E2E check:** click through Send/Copy/Reset, expand `⋯`, add-auto-layout, and change family/weight/stroke-style/size-mode selects in the demo app; console clean.

### Task 3 — Storybook (`@storybook/html-vite`, devDeps only)

- devDependencies in `packages/vite-plugin`: `storybook` + `@storybook/html-vite` (current major — 10.x at writing; if it refuses Vite 6, pin down rather than upgrading Vite). Scripts: `"storybook": "storybook dev -p 6006"`, `"build-storybook": "storybook build"`.
- `.storybook/main.ts`:

```ts
import type { StorybookConfig } from '@storybook/html-vite'
export default {
  framework: '@storybook/html-vite',
  stories: ['../stories/**/*.stories.ts'],
} satisfies StorybookConfig
```

- `stories/mount.ts` — the fidelity guarantee. Renders story content inside a real shadow root carrying the product stylesheet; `context` wraps content in the ancestor the context selectors need:

```ts
import { CSS } from '../src/client/overlay'
export type MountContext = 'panel' | 'status' | 'bare'
export function mountInShadow(content: HTMLElement | HTMLElement[], context: MountContext = 'panel'): HTMLElement {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS
  root.append(style)
  let target: HTMLElement | ShadowRoot = root
  if (context !== 'bare') {
    const wrap = document.createElement('div')
    wrap.id = context // #panel / #status context selectors apply
    // Stories flow in the preview canvas; the product positions these fixed.
    wrap.style.position = 'static'
    root.append(wrap); target = wrap
  }
  target.append(...(Array.isArray(content) ? content : [content]))
  return host
}
```

- Stories (CSF3, `import type { Meta, StoryObj } from '@storybook/html-vite'`; each story's render returns `mountInShadow(...)`):
  - `tokens.stories.ts` — palette swatch grid + type specimen, generated by parsing the `--*:` declarations out of the `CSS` const (single source; the story can never show a stale palette).
  - `button.stories.ts` — `createButton` in `status` and `panel` contexts; Send/Copy/Reset labels; `data-add-layout` dashed variant; `data-expand` `⋯`.
  - `select.stories.ts` — `createSelect` with the four real option sets (family/weight/stroke-style/size-mode).
  - `number-field.stories.ts` — real `NumberField`: plain, `allowAuto` showing `auto`, pill-bound (`bindToken`) state.
  - `segment-field.stories.ts` — real `SegmentField`, one with active segment.
  - `align-matrix.stories.ts` — real `AlignMatrix` with `set()` called (populated + active dot) and unset.
  - `swatch.stories.ts` — a `.swatch`/`.color-value` row as `panel.ts` builds it; the color-picker popover as one story.
- Housekeeping: add `storybook-static/` to the root `.gitignore`; add `"stories"` and `".storybook"` to `tsconfig.json` `include` so `npm run typecheck` covers them (vitest's `tests/**` glob is untouched).

**Verification:** `npm run build-storybook -w @the-forge/vite` exits 0; `npm run storybook` browsed — every story visually matches the same control in the demo app; `npm test` and `./scripts/check-prod-clean.sh` unchanged (Storybook is devDeps + non-`dist/` files only, so the published package and 250KB budget are untouched by construction — verify anyway).

## Out of scope (parked)

- Restyling anything; button visual variants (factory takes `className` — variants become one-liners when a design pass wants them).
- Interaction/a11y tests in Storybook (play functions) — bolt on later if the catalog earns it.
- Tokenizing color-picker gradient structure, shadows, incidental alphas.
- Swatch/color-row factory; moving existing control classes under `ui/`.
