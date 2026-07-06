# Designer-Forward Panel — Milestone A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone A of [docs/specs/2026-07-05-designer-forward-panel-design.md](../specs/2026-07-05-designer-forward-panel-design.md) — designer vocabulary relabels (PX/PY → H/V etc.), auto-derived CSS-hint tooltips, and the Margin section shown only when the element actually has margins.

**Architecture:** Pure client-panel work — `panel-specs.ts` (labels, `cssHintFor`), `controls.ts`/`layout-controls.ts` (hint/title plumbing), `panel.ts` (wiring + a `data-props` test hook), `panel-readers.ts` (margin visibility). No request/queue/server changes: the request builder keys on `props`, labels are display-only.

**Tech Stack:** TypeScript, vitest + jsdom (unit), real-browser E2E on the demo app (repo gotcha: jsdom cannot see computed layout).

## Global Constraints

- Zero new runtime dependencies (CLAUDE.md hard constraint).
- Panel/overlay CSS class names are test hooks — **extend, don't rename** (`data-props` is an addition; every existing class stays).
- Why-comments are load-bearing — preserve verbatim when moving code.
- Section order unchanged in M-A: Layout → Size → Padding → Margin → Typography → Fill → Stroke → Appearance (Margin hides via the `hidden` attr in its slot, exactly like Typography does today).
- All work from `packages/the-forge/`; single-file test runs use `npx vitest run tests/client/<file>.test.ts`; the milestone gate is root `npm test`.
- Working branch: `designer-panel-m-a`, branched from the commit carrying this plan + the spec (currently `claude/vigilant-colden-7d55e1`) — feature branch per milestone, repo convention. Merge decision belongs to the user.

---

### Task 1: `data-props` field identity + test-helper migration

Labels are about to stop being unique (`H` will mean height, padding-H, and margin-H). Give every numeric field a stable machine identity derived from its `props`, and move the label-based test helpers onto it **before** any relabeling, so tests stay green through Task 3.

**Files:**
- Modify: `packages/the-forge/src/client/panel.ts` (buildField ~line 1271-1323; gap field ~line 729-759)
- Modify: `packages/the-forge/tests/client/panel.test.ts` (helper at lines 20-26, `pxField` finders at ~1384 and ~1824, label literals throughout)
- Modify: `packages/the-forge/tests/client/design-mode.test.ts` (three duplicated `fieldInput` helpers at ~1139, ~1250, ~1458; inline `'W'` finder at ~1839; label literals throughout)

**Interfaces:**
- Produces: every `.nf` field root carries `data-props="<spec.props.join(' ')>"` (e.g. `data-props="padding-left padding-right"`, gap field `data-props="gap"`). Test files export nothing; both define a local `P` const map used by all later tasks' tests.

- [ ] **Step 1: Write the failing test** — in `panel.test.ts`, inside the top describe next to the existing "reads computed styles" test (~line 55), using that test's exact panel setup:

```ts
it('numeric fields carry data-props identity', () => {
  const roots = [...panel.root.querySelectorAll('.nf')] as HTMLElement[]
  expect(roots.find((n) => n.dataset.props === 'padding-left padding-right')).toBeDefined()
  expect(roots.find((n) => n.dataset.props === 'width')).toBeDefined()
  expect(roots.find((n) => n.dataset.props === 'gap')).toBeDefined()
})
```

- [ ] **Step 2: Run it** — `npx vitest run tests/client/panel.test.ts -t 'data-props'`. Expected: FAIL (dataset.props undefined).

- [ ] **Step 3: Implement.** In `panel.ts` `buildField`, immediately after the `const field = new NumberField({...})` construction (after line ~1323):

```ts
// Stable machine identity for tests/tooling — labels are designer-facing display text and
// may collide across sections (Size H vs Padding H); props are the field's real identity.
field.root.dataset.props = spec.props.join(' ')
```

And in `buildLayoutSection`, after `this.gapField = new NumberField({...})`:

```ts
this.gapField.root.dataset.props = GAP_SPEC.props.join(' ')
```

- [ ] **Step 4: Run it again** — same command. Expected: PASS.

- [ ] **Step 5: Migrate helpers.** In `panel.test.ts`, replace the `fieldInput` body (lines 20-26) with a `data-props` lookup and add a `P` map above it:

```ts
// Field identities (data-props) — labels are display text and are free to change.
const P = {
  W: 'width',
  H: 'height',
  PX: 'padding-left padding-right',
  PY: 'padding-top padding-bottom',
  PT: 'padding-top',
  PR: 'padding-right',
  PB: 'padding-bottom',
  PL: 'padding-left',
  MX: 'margin-left margin-right',
  MY: 'margin-top margin-bottom',
  GAP: 'gap',
} as const

function fieldInput(panel: Panel, props: string): HTMLInputElement {
  const nf = [...panel.root.querySelectorAll('.nf')].find((n) => (n as HTMLElement).dataset.props === props)
  if (!nf) throw new Error(`no field with data-props ${props}`)
  return nf.querySelector('input')!
}
```

Mechanically update call sites (from `packages/the-forge/`):

```bash
sed -i '' "s/fieldInput(panel, '\\([A-Z]*\\)')/fieldInput(panel, P.\\1)/g" tests/client/panel.test.ts
```

Then update the two local `pxField`-style finders (~1384, ~1824) to the same `dataset.props` lookup (they take a label param — switch each call like `pxField(panel, 'PX')` → `pxField(panel, P.PX)` with the finder matching `dataset.props`). Do the equivalent in `design-mode.test.ts`: add the same `P` const at module top, update the three `fieldInput` helper bodies, sed the `fieldInput(mode.panelRoot, 'PY')`-style call sites, and convert the inline `'W'` label finder at ~1839 to `dataset.props === P.W`. Any remaining label-based finder that grep reveals (`grep -n "nf-label'!)\.textContent ===" tests/client/*.test.ts`) gets the same treatment — EXCEPT assertions that deliberately test label *display text* (e.g. the stroke-labels assertion at panel.test.ts ~1190 — leave it; Task 3 updates it).

- [ ] **Step 6: Full check** — `npx vitest run tests/client/panel.test.ts tests/client/design-mode.test.ts`. Expected: all pass (behavior unchanged).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "test: key panel field lookups on data-props, not display labels"
```

---

### Task 2: `cssHintFor` + hint/title plumbing

**Files:**
- Modify: `packages/the-forge/src/client/panel-specs.ts` (new `cssHintFor`, `SectionSpec.hint`)
- Modify: `packages/the-forge/src/client/controls.ts` (NumberField `hint` opt; labelEl ~line 203)
- Modify: `packages/the-forge/src/client/layout-controls.ts` (SegmentField per-option `title`; ~line 25-38)
- Modify: `packages/the-forge/src/client/panel.ts` (wire hints: buildField, gap field, size-mode select in buildRow ~line 1133, Margin section title in buildBody ~line 627-641)
- Create: `packages/the-forge/tests/client/panel-specs.test.ts`
- Test: `packages/the-forge/tests/client/controls.test.ts`, `packages/the-forge/tests/client/layout-controls.test.ts`, `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Produces: `cssHintFor(spec: { props: string[] }): string` exported from `panel-specs.ts` (e.g. `'padding-left, padding-right → px-*'`; falls back to bare prop list when no utility prefix). `NumberFieldOpts.hint?: string` (sets `title` on `.nf-label`). `SegmentFieldOpts.options[].title?: string` (button `title`, falls back to `option.label` — today's behavior). `SectionSpec.hint?: string` (sets `title` on the section-title element).

- [ ] **Step 1: Write failing tests.** New `tests/client/panel-specs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cssHintFor, GAP_SPEC } from '../../src/client/panel-specs'

describe('cssHintFor', () => {
  it('maps single-prop rows to their Tailwind prefix', () => {
    expect(cssHintFor({ props: ['padding-top'] })).toBe('padding-top → pt-*')
  })
  it('maps multi-prop synthetic rows (padding-inline → px)', () => {
    expect(cssHintFor({ props: ['padding-left', 'padding-right'] })).toBe('padding-left, padding-right → px-*')
  })
  it('falls back to bare CSS prop names when no utility prefix exists', () => {
    expect(
      cssHintFor({ props: ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'] })
    ).toBe('border-top-width, border-right-width, border-bottom-width, border-left-width')
  })
  it('covers the gap spec', () => {
    expect(cssHintFor(GAP_SPEC)).toBe('gap → gap-*')
  })
})
```

In `controls.test.ts` (mirror its existing NumberField construction style):

```ts
it('applies hint as the label title', () => {
  const f = new NumberField({ label: 'H', hint: 'padding-left, padding-right → px-*', onInput: () => {} })
  expect((f.root.querySelector('.nf-label') as HTMLElement).title).toBe('padding-left, padding-right → px-*')
})
```

In `layout-controls.test.ts`:

```ts
it('applies per-option titles, falling back to the label', () => {
  const f = new SegmentField({
    label: 'Direction',
    options: [
      { value: 'row', label: 'Horizontal', title: 'flex-direction: row → flex-row' },
      { value: 'column', label: 'Vertical' },
    ],
    onInput: () => {},
  })
  const btns = [...f.root.querySelectorAll('.seg')] as HTMLElement[]
  expect(btns[0].title).toBe('flex-direction: row → flex-row')
  expect(btns[1].title).toBe('Vertical')
})
```

- [ ] **Step 2: Run them** — `npx vitest run tests/client/panel-specs.test.ts tests/client/controls.test.ts tests/client/layout-controls.test.ts`. Expected: FAIL (cssHintFor not exported; hint/title ignored).

- [ ] **Step 3: Implement.** `panel-specs.ts` (near `utilityPrefixFor`), and add `hint?: string` to `SectionSpec` with a doc comment (`/** Tooltip (title attr) on the section title — used where the section name itself needs explaining (Margin). */`):

```ts
/**
 * Tooltip text bridging a row to its CSS props and Tailwind utility ("padding-left,
 * padding-right → px-*"). Derived via utilityPrefixFor from the same UTILITY_PREFIXES map
 * request.ts emits from, so the hint can never drift from the generated change request; rows
 * with no utility prefix fall back to the bare CSS prop list.
 */
export function cssHintFor(spec: { props: string[] }): string {
  const css = spec.props.join(', ')
  const prefix = utilityPrefixFor(spec.props)
  return prefix ? `${css} → ${prefix}-*` : css
}
```

`controls.ts`: add to `NumberFieldOpts` — `/** Tooltip (title attr) on the label — the CSS/Tailwind mapping hint. */ hint?: string`; after `this.labelEl.textContent = opts.label` (line ~204): `if (opts.hint) this.labelEl.title = opts.hint`.

`layout-controls.ts`: option type becomes `Array<{ value: string; label: string; title?: string }>`; the existing `button.title = option.label` line (keep its why-comment verbatim) becomes `button.title = option.title ?? option.label`.

- [ ] **Step 4: Wire in panel.ts.**
  - `buildField`: add `hint: cssHintFor(spec),` to the NumberField opts.
  - Gap field construction: add `hint: cssHintFor(GAP_SPEC),`.
  - `buildRow` size-mode select (after `createSelect`): `select.title = 'Fixed: exact px · Hug: fit-content · Fill: stretch / flex-1'`.
  - `buildBody`: where the section title element is created (the `title` variable the expand button is appended to at ~line 638): `if (section.hint) title.title = section.hint`.
  - Direction/Wrap option titles are applied in Task 3 (with the relabel).

- [ ] **Step 5: Add a wiring test** in `panel.test.ts` (same setup as the Task 1 test):

```ts
it('field labels carry CSS/Tailwind hint tooltips', () => {
  const nf = [...panel.root.querySelectorAll('.nf')].find(
    (n) => (n as HTMLElement).dataset.props === P.PX
  ) as HTMLElement
  expect((nf.querySelector('.nf-label') as HTMLElement).title).toBe('padding-left, padding-right → px-*')
})
```

- [ ] **Step 6: Run** — `npx vitest run tests/client/panel-specs.test.ts tests/client/controls.test.ts tests/client/layout-controls.test.ts tests/client/panel.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(client): CSS/Tailwind hint tooltips derived from UTILITY_PREFIXES"
```

---

### Task 3: Designer relabels

**Files:**
- Modify: `packages/the-forge/src/client/panel-specs.ts` (SECTIONS labels: Padding lines ~189-197, Margin ~203-211, Stroke expandRows ~230-234)
- Modify: `packages/the-forge/src/client/panel.ts` (Direction options ~line 679-682, Wrap options ~line 763-766)
- Modify: `packages/the-forge/stories/segment-field.stories.ts` (lines 17-18, 32-33)
- Test: `packages/the-forge/tests/client/panel.test.ts` (stroke-labels assertion ~line 1190)

**Interfaces:**
- Consumes: `data-props` lookups from Task 1 (label literals are no longer load-bearing in tests); per-option `title` from Task 2.
- Produces: final M-A display labels — Padding/Margin rows `H`/`V`, all per-side expand rows `T`/`R`/`B`/`L`, Direction `Horizontal`/`Vertical`, Wrap unchanged text with CSS titles.

- [ ] **Step 1: Write the failing label test** in `panel.test.ts`:

```ts
it('padding and margin speak designer labels (H/V + T/R/B/L)', () => {
  const labelFor = (props: string): string => {
    const nf = [...panel.root.querySelectorAll('.nf')].find(
      (n) => (n as HTMLElement).dataset.props === props
    ) as HTMLElement
    return (nf.querySelector('.nf-label') as HTMLElement).textContent ?? ''
  }
  expect(labelFor(P.PX)).toBe('H')
  expect(labelFor(P.PY)).toBe('V')
  expect(labelFor(P.PT)).toBe('T')
  expect(labelFor(P.MX)).toBe('H')
  expect(labelFor(P.MY)).toBe('V')
})
```

- [ ] **Step 2: Run it** — expect FAIL (labels still PX/PY/…).

- [ ] **Step 3: Relabel.** In `panel-specs.ts` SECTIONS: Padding rows → `{ label: 'H', props: ['padding-left', 'padding-right'], min: 0 }` / `{ label: 'V', props: ['padding-top', 'padding-bottom'], min: 0 }`; Padding expandRows → `T`/`R`/`B`/`L` (same props); Margin rows → `H`/`V`, expandRows → `T`/`R`/`B`/`L`; Stroke expandRows → `T`/`R`/`B`/`L` (props + `onBeforeApply: draftSolidIfNone` unchanged). In `panel.ts` Direction options:

```ts
options: [
  { value: 'row', label: 'Horizontal', title: 'flex-direction: row → flex-row' },
  { value: 'column', label: 'Vertical', title: 'flex-direction: column → flex-col' },
],
```

Wrap options keep their labels, gain titles `'flex-wrap: nowrap'` / `'flex-wrap: wrap'`. Update `stories/segment-field.stories.ts` sample options (both stories) from Row/Column to Horizontal/Vertical so the catalog matches the shipped control.

- [ ] **Step 4: Fix the stroke-labels assertion** (~line 1190) — replace the label-text `arrayContaining(['BT','BR','BB','BL'])` with a props-based check (labels T/R/B/L are no longer unique to Stroke):

```ts
const propsList = [...panel.root.querySelectorAll('.nf')].map((n) => (n as HTMLElement).dataset.props)
expect(propsList).toEqual(
  expect.arrayContaining(['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'])
)
```

Then sweep for stragglers: `grep -n "'Row'\|'Column'\|'PX'\|'PY'\|'MX'\|'BT'" tests/client/*.test.ts` — update any remaining display-text assertion to the new labels (local fixture data in `layout-controls.test.ts` and spec-literal `label:` fields in `panel-token-ui.test.ts` are NOT display assertions — leave them).

- [ ] **Step 5: Run the client suite** — `npx vitest run tests/client/`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(client): designer-first labels (H/V, T/R/B/L, Horizontal/Vertical)"
```

---

### Task 4: Margin section shows only when the element has margins

**Files:**
- Modify: `packages/the-forge/src/client/panel-readers.ts` (new `marginSectionVisible`)
- Modify: `packages/the-forge/src/client/panel-specs.ts` (`SectionSpec.visible` signature; Margin section entry)
- Modify: `packages/the-forge/src/client/panel.ts` (refresh() visible call sites, lines ~322/327/329: pass `this.drafts`)
- Create: `packages/the-forge/tests/client/panel-readers.test.ts`
- Test: `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Consumes: `DraftStore.current(el, prop): string | null` (existing).
- Produces: `marginSectionVisible(el: TaggedElement, drafts?: DraftStore): boolean` exported from `panel-readers.ts`; `SectionSpec.visible` becomes `(el: TaggedElement, drafts?: DraftStore) => boolean` (existing `hasDirectText` stays as-is — fewer-param functions remain assignable).

- [ ] **Step 1: Write failing unit tests.** New `tests/client/panel-readers.test.ts` (mirror DraftStore construction from `tests/client/drafts.test.ts`):

```ts
import { describe, expect, it } from 'vitest'
import { marginSectionVisible } from '../../src/client/panel-readers'
import { DraftStore } from '../../src/client/drafts'
import type { TaggedElement } from '../../src/client/source'

function el(css: string): TaggedElement {
  const d = document.createElement('div')
  d.setAttribute('style', css)
  document.body.append(d)
  return d as unknown as TaggedElement
}

describe('marginSectionVisible', () => {
  it('false for a margin-less element', () => {
    expect(marginSectionVisible(el(''))).toBe(false)
  })
  it('true when any side is non-zero', () => {
    expect(marginSectionVisible(el('margin-top: 12px'))).toBe(true)
  })
  it('true for auto margins (mx-auto is margin usage)', () => {
    expect(marginSectionVisible(el('margin-left: auto; margin-right: auto'))).toBe(true)
  })
  it('true for negative margins', () => {
    expect(marginSectionVisible(el('margin-top: -8px'))).toBe(true)
  })
  it('a live margin draft keeps it true even when the drafted value is 0', () => {
    const e = el('margin-top: 16px')
    const drafts = new DraftStore()
    drafts.apply(e, 'margin-top', '0px')
    expect(marginSectionVisible(e, drafts)).toBe(true)
  })
})
```

- [ ] **Step 2: Run** — `npx vitest run tests/client/panel-readers.test.ts`. Expected: FAIL (not exported).

- [ ] **Step 3: Implement** in `panel-readers.ts` (add `import type { DraftStore } from './drafts'`):

```ts
const MARGIN_PROPS = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']

/**
 * Margin-section disclosure (spec 2026-07-05, decision 2): designers don't set margins, so
 * the section renders only when the element actually carries some — any computed margin that
 * isn't zero (negative and `auto` margins count), OR any live margin draft. The draft clause
 * is the mid-edit latch: scrubbing a margin to 0 keeps the draft (and thus the section) alive
 * under the pointer; it only disappears once the element genuinely has no margin and no
 * pending edit. jsdom reports '' for an unset margin — treat as zero (same quirk handling as
 * draftSolidIfNone's border-style read).
 */
function marginSectionVisible(el: TaggedElement, drafts?: DraftStore): boolean {
  const computed = getComputedStyle(el)
  return MARGIN_PROPS.some((p) => {
    if (drafts && drafts.current(el, p) !== null) return true
    const v = computed.getPropertyValue(p)
    return v !== '' && v !== '0px'
  })
}
```

Export it from the existing export list. In `panel-specs.ts`: widen `SectionSpec.visible` to `(el: TaggedElement, drafts?: DraftStore) => boolean` (type-only DraftStore import already exists via `drafts.ts` import at top), and on the Margin section add:

```ts
visible: marginSectionVisible,
hint: 'Space this element adds around itself (CSS margin) — shown only when the element actually has margins',
```

In `panel.ts` `refresh()` pass drafts at all three call sites: `spec.visible(el, this.drafts)` (lines ~322 and ~329) and `this.els.some((e) => spec.visible!(e, this.drafts))` (line ~327).

- [ ] **Step 4: Panel-level tests** in `panel.test.ts` — mirror the existing Typography-visibility assertions (find them via `grep -n "Typography" tests/client/panel.test.ts`) for how a section's title/body `hidden` state is asserted:

```ts
describe('Margin section disclosure', () => {
  it('is hidden for a margin-less element', () => { /* select element without margins; assert Margin title el .hidden === true */ })
  it('is shown when the element has margins', () => { /* element with style margin-top: 12px; assert .hidden === false */ })
  it('stays shown while a margin draft exists after editing to 0', () => {
    /* margined element; commit(fieldInput(panel, P.MY), '0'); refresh happens on commit; assert still visible */
  })
  it('multi-select: shown when ANY selected element has margins', () => { /* one margined + one margin-less */ })
})
```

Fill in each body using the file's existing setup helpers (same pattern as the neighboring Typography tests — the assertions are on the `hidden` attribute of the section's title and body elements, which `setSectionHidden` toggles together).

- [ ] **Step 5: Run** — `npx vitest run tests/client/panel-readers.test.ts tests/client/panel.test.ts tests/client/design-mode.test.ts`. Expected: PASS. If any pre-existing design-mode test selected a margin-less fixture and touched Margin fields, it will now fail — fix by giving that fixture element an inline margin in the test's setup (not by weakening the disclosure rule).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(client): Margin section discloses only when the element has margins"
```

---

### Task 5: Real-browser E2E + spec sync + gate

**Files:**
- Modify: `fixtures/demo-app/src/App.tsx` (ensure one element with margin utilities, e.g. add `mt-6` to an existing card, for the disclosure check)
- Modify: `docs/specs/2026-07-05-designer-forward-panel-design.md` (M-A latch wording)

- [ ] **Step 1: Update the spec's latch paragraph** — replace the "evaluated at selection time and latched" sentence in M-A with the shipped mechanism: evaluated on refresh, but a live margin draft keeps the section visible, which provides the same mid-edit guarantee without selection-scoped state.

- [ ] **Step 2: Build + fresh dev server** (stale-server gotcha):

```bash
npm run build
lsof -iTCP:5173 -sTCP:LISTEN -n -P || true   # kill any listed pid first
npm run dev -w demo-app
```

- [ ] **Step 3: Browser pass** (playwright/Chrome MCP against `http://localhost:5173`): toggle design mode → select a padded, margin-less element → verify: Padding rows read `H`/`V` (expand shows `T/R/B/L`), hovering the `H` label shows title `padding-left, padding-right → px-*` (assert via `getAttribute('title')` inside the shadow root), Direction segment reads `Horizontal`/`Vertical`, **no Margin section rendered**. Select the `mt-6` element → Margin section appears with `H`/`V`; scrub its `V` field to 0 → section stays; press Escape/deselect and reselect a margin-less element → section hidden again. Send one padding change → queued markdown in `.the-forge/queue.json` still shows `px-*`/`py-*` utilities (labels changed nothing downstream).

- [ ] **Step 4: Full gate** — from repo root: `npm test`. Expected: typecheck + full vitest suite pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs+fixtures: M-A spec sync, demo margin fixture; E2E-verified designer labels"
```

---

## Self-review notes (run after drafting — resolved)

- **Spec coverage:** M-A spec items — relabels (Task 3), tooltips incl. Margin section title + size-mode select (Task 2), margin disclosure with mid-edit latch (Task 4), "labels are display text only" (Task 1 makes it structurally true), stable class names (global constraint). ✓
- **Type consistency:** `cssHintFor(spec: { props: string[] })` matches `tokenEntriesFor`'s param shape; `SectionSpec.visible` widening is backward-compatible with `hasDirectText`. `P` map duplicated per test file deliberately (test files have no shared-helper module today; introducing one is out of scope).
- **Known judgment calls for the executor:** exact section-title element/class in `buildBody` (locate via the expand-button append at panel.ts:638) and the panel.test.ts setup helpers — mirror neighboring tests rather than inventing new scaffolding.
