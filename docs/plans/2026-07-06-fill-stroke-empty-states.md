# Fill & Stroke Empty States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a selected element has no background / no painting border, the Fill / Stroke panel sections collapse to their title plus a `+` button that drafts a visible default; a matching `−` button removes an existing fill/stroke (pure undo when it was added this session).

**Architecture:** Approach A from the approved spec ([docs/specs/2026-07-06-fill-stroke-empty-states-design.md](../specs/2026-07-06-fill-stroke-empty-states-design.md)): refresh-driven toggle inside `Panel`. Pure emptiness predicates live in `panel-readers.ts`; the +/− buttons are born via the `createButton` factory into the existing section title rows (mirroring Layout's `−` remove-auto-layout button); `refreshFillStroke()` toggles `hidden` on rows and buttons every refresh. Zero new CSS — `.panel-section` is already `justify-content: space-between` flex.

**Tech Stack:** TypeScript, vanilla DOM (shadow-DOM overlay — no React), Vitest + jsdom.

## Global Constraints

- Zero new runtime dependencies; zero new CSS (client bundle budget is 244/250KB — verify with `./scripts/check-prod-clean.sh`).
- New buttons go through `src/client/ui/button.ts`'s `createButton` — never raw `document.createElement('button')`.
- Panel/overlay CSS class names and `data-*` attributes are test hooks — extend, don't rename. New hooks: `data-add-fill`, `data-remove-fill`, `data-add-stroke`, `data-remove-stroke`.
- Why-comments are load-bearing project memory — preserve existing ones verbatim; new ones state constraints, not narration.
- Title-row button glyph order matches the Layout convention: remove (`−`) before add (`+`) before expand (`⋯`).
- All work happens in `packages/the-forge/`. Single-file test runs: `npx vitest run tests/client/panel.test.ts` from `packages/the-forge/`. Root gate: `npm test` from the repo root.

---

### Task 1: Emptiness predicates in panel-readers

**Files:**
- Modify: `packages/the-forge/src/client/panel-readers.ts`
- Test: `packages/the-forge/tests/client/panel-readers.test.ts`

**Interfaces:**
- Consumes: `parseColor` (already imported in panel-readers.ts as `parseColorLocal` from `./tokens`).
- Produces: `fillIsEmpty(css: string): boolean` and `strokeIsEmpty(read: (prop: string) => string): boolean` — both exported; Task 2/3 import them into `panel.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/the-forge/tests/client/panel-readers.test.ts` (add `fillIsEmpty, strokeIsEmpty` to the existing import from `'../../src/client/panel-readers'`):

```ts
describe('fillIsEmpty', () => {
  it('transparent keyword and zero-alpha rgba are empty', () => {
    expect(fillIsEmpty('transparent')).toBe(true)
    expect(fillIsEmpty('rgba(0, 0, 0, 0)')).toBe(true)
  })
  it('an unset background (jsdom computes the empty string) is empty', () => {
    expect(fillIsEmpty('')).toBe(true)
  })
  it('opaque and semi-transparent colors are not empty', () => {
    expect(fillIsEmpty('rgb(255, 0, 0)')).toBe(false)
    expect(fillIsEmpty('rgba(255, 0, 0, 0.5)')).toBe(false)
  })
})

describe('strokeIsEmpty', () => {
  const read = (styles: Record<string, string>) => (prop: string) => styles[prop] ?? ''

  it('nothing authored is empty', () => {
    expect(strokeIsEmpty(read({}))).toBe(true)
  })
  it('width without style is empty (border-style defaults to none)', () => {
    expect(strokeIsEmpty(read({ 'border-top-width': '3px' }))).toBe(true)
  })
  it('style with an explicit zero width is empty', () => {
    expect(
      strokeIsEmpty(read({ 'border-top-style': 'solid', 'border-top-width': '0px' }))
    ).toBe(true)
  })
  it('a single painting side (lone border-bottom divider) is NOT empty', () => {
    expect(
      strokeIsEmpty(read({ 'border-bottom-style': 'solid', 'border-bottom-width': '1px' }))
    ).toBe(false)
  })
  it('explicit border-style: none on every side is empty regardless of widths', () => {
    const styles: Record<string, string> = {}
    for (const side of ['top', 'right', 'bottom', 'left']) {
      styles[`border-${side}-style`] = 'none'
      styles[`border-${side}-width`] = '2px'
    }
    expect(strokeIsEmpty(read(styles))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run (from `packages/the-forge/`): `npx vitest run tests/client/panel-readers.test.ts`
Expected: FAIL — `fillIsEmpty` / `strokeIsEmpty` are not exported.

- [ ] **Step 3: Implement the predicates**

Add to `packages/the-forge/src/client/panel-readers.ts` (it already imports `parseColorLocal`):

```ts
/**
 * A fill "exists" only when it paints: alpha 0 (and jsdom's '' for an unset background)
 * reads as empty — the same rule colorDisplay uses to claim the `transparent` keyword.
 */
export function fillIsEmpty(css: string): boolean {
  const parsed = parseColorLocal(css)
  return !parsed || parsed.a === 0
}

/**
 * A stroke "exists" only when some side paints: style ≠ none AND width > 0 — the same
 * never-rendered predicate groupSelectionColors applies to border-top-color, but checked
 * on ALL four sides so a lone border-bottom divider still counts as a stroke. `read` is
 * draft-aware at the call site (Panel passes currentValue), keeping this a pure function.
 * jsdom reports '' for unset style/width — same "no visible border" reading as none/0.
 */
export function strokeIsEmpty(read: (prop: string) => string): boolean {
  return ['top', 'right', 'bottom', 'left'].every((side) => {
    const style = read(`border-${side}-style`)
    if (style === 'none' || style === '') return true
    const width = Number.parseFloat(read(`border-${side}-width`))
    return !Number.isFinite(width) || width === 0
  })
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/client/panel-readers.test.ts`
Expected: PASS (all pre-existing tests in the file still green).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/panel-readers.ts packages/the-forge/tests/client/panel-readers.test.ts
git commit -m "feat(client): fillIsEmpty/strokeIsEmpty predicates for the empty-state disclosure"
```

---

### Task 2: Glyph-strip helper in panel.test.ts (prep refactor, no behavior change)

The Fill/Stroke titles are about to grow `+`/`−` buttons; ~13 test sites find sections by comparing title `textContent` after stripping only `⋯` (and sometimes `−`). Centralize the stripping FIRST so Task 3/4 don't break unrelated finders.

**Files:**
- Modify: `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Produces: `titleText(n: Element): string` — module-level helper in panel.test.ts; Tasks 3/4 rely on section finders already using it.

- [ ] **Step 1: Add the helper near the top of panel.test.ts (after the `P` const)**

```ts
// Section title rows carry glyph buttons — '⋯' expand, '−' remove, '+' add (fill/stroke
// empty states) — strip all of them before comparing the label text.
function titleText(n: Element): string {
  return (n.textContent ?? '').replace(/[⋯−+]/g, '').trim()
}
```

- [ ] **Step 2: Replace every ad-hoc strip site with the helper**

Find them with: `grep -n "replace('⋯'" packages/the-forge/tests/client/panel.test.ts` (also `grep -n "replace('−'"`). At the time of writing: lines 247, 269, 289, 1290, 1316, 1428, 1541, 1632, 1645, 2622, 2717, 2724, 2734. Each becomes the pattern:

```ts
// before:
(n) => n.textContent?.replace('⋯', '').trim() === 'Fill'
// after:
(n) => titleText(n) === 'Fill'
```

and for the map-over-titles sites:

```ts
// before:
.map((n) => n.textContent?.replace('⋯', '').replace('−', '').trim())
// after:
.map((n) => titleText(n))
```

Where the expectation compares against a trailing-space string (the lines 269/289 style `.toBe('Layout')` after non-trimmed replaces), switch the assertion to `titleText(sections[0])` and the plain label `'Layout'`.

- [ ] **Step 3: Run the suite to verify no behavior change**

Run: `npx vitest run tests/client/panel.test.ts`
Expected: PASS — identical test count, zero failures.

- [ ] **Step 4: Commit**

```bash
git add packages/the-forge/tests/client/panel.test.ts
git commit -m "test(client): centralize section-title glyph stripping ahead of fill/stroke +/− buttons"
```

---

### Task 3: Fill empty state

**Files:**
- Modify: `packages/the-forge/src/client/panel.ts`
- Test: `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Consumes: `fillIsEmpty` from `./panel-readers` (Task 1); `createButton` from `./ui/button`; existing `this.fillRow`, `this.currentValue`, `this.drafts`, `this.onBeforeEdit`, `this.onEdited`, `this.refresh`.
- Produces: `[data-add-fill]` / `[data-remove-fill]` buttons inside the Fill section title; `Panel` private fields `fillAddBtn`, `fillRemoveBtn`.

- [ ] **Step 1: Write the failing tests**

Inside the existing `describe('Panel Fill section', …)` block in panel.test.ts, add:

```ts
it('no background → Fill row hidden, + shown in the title, − hidden', () => {
  const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
  const add = panel.root.querySelector('[data-add-fill]') as HTMLElement
  const remove = panel.root.querySelector('[data-remove-fill]') as HTMLElement
  expect(add.hidden).toBe(false)
  expect(remove.hidden).toBe(true)
  expect(fillSection(panel).contains(add)).toBe(true) // lives in the title row
  expect(colorRows(panel)).toHaveLength(0) // Fill row hidden (and no direct text → no Text row)
})

it('empty fill leaves the Text row untouched', () => {
  const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t">Hello</div>`)
  expect(colorRows(panel)).toHaveLength(1) // Text row alone survives the empty fill
})

it('populated fill → row shown, − shown, + hidden', () => {
  const { panel } = setup(
    `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(255, 0, 0);"></div>`
  )
  expect((panel.root.querySelector('[data-add-fill]') as HTMLElement).hidden).toBe(true)
  expect((panel.root.querySelector('[data-remove-fill]') as HTMLElement).hidden).toBe(false)
  expect(colorRows(panel)).toHaveLength(1)
})

it('+ drafts the default fill (#D9D9D9) and flips to populated', () => {
  const { el, panel, drafts } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
  ;(panel.root.querySelector('[data-add-fill]') as HTMLElement).click()
  expect(drafts.current(el, 'background-color')).toBe('#D9D9D9')
  expect((panel.root.querySelector('[data-add-fill]') as HTMLElement).hidden).toBe(true)
  expect((panel.root.querySelector('[data-remove-fill]') as HTMLElement).hidden).toBe(false)
  expect(colorRows(panel)).toHaveLength(1)
})

it('− after + is a pure undo: draft discarded, nothing to send, back to empty', () => {
  const { el, panel, drafts } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
  ;(panel.root.querySelector('[data-add-fill]') as HTMLElement).click()
  ;(panel.root.querySelector('[data-remove-fill]') as HTMLElement).click()
  expect(drafts.current(el, 'background-color')).toBe(null)
  expect((panel.root.querySelector('[data-add-fill]') as HTMLElement).hidden).toBe(false)
})

it('− on a stylesheet-real fill drafts transparent as the removal', () => {
  const { el, panel, drafts } = setup(
    `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(255, 0, 0);"></div>`
  )
  ;(panel.root.querySelector('[data-remove-fill]') as HTMLElement).click()
  expect(drafts.current(el, 'background-color')).toBe('transparent')
  expect((panel.root.querySelector('[data-add-fill]') as HTMLElement).hidden).toBe(false)
})
```

Then adapt three existing tests whose fixtures have no background and therefore now read as empty:

1. `'Text row is hidden for an element with no direct text child'` — give the fixture a background so the test keeps proving what its name says: fixture becomes `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(1, 2, 3);"><span>x</span></div>` (expectation stays `toHaveLength(1)` — Fill only).
2. `'Text row is visible for an element with direct text'` — fixture becomes `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(1, 2, 3);">Hello</div>` (expectation stays `toHaveLength(2)`).
3. `'a fully-transparent Fill shows the literal "transparent" label, not a nearest-token guess'` — a fully-transparent fill IS the empty state now; rewrite the test:

```ts
it('a fully-transparent background reads as empty — + shown, no Fill row', () => {
  const { panel } = setup(
    `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: transparent;"></div>`
  )
  expect((panel.root.querySelector('[data-add-fill]') as HTMLElement).hidden).toBe(false)
  expect(colorRows(panel)).toHaveLength(0)
})
```

(The `transparent`-literal display rule itself stays covered: `colorDisplay` has its own unit coverage, and the Stroke color row can still legitimately show it.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/client/panel.test.ts`
Expected: the six new tests FAIL (`[data-add-fill]` doesn't exist → click on null); the three adapted tests pass or fail incidentally — fine either way at this step.

- [ ] **Step 3: Implement**

All edits in `packages/the-forge/src/client/panel.ts`.

3a. Import the predicate — extend the existing `./panel-readers` import with `fillIsEmpty`.

3b. Add private fields next to the existing Fill/Stroke widget fields (`fillRow` block, ~line 112):

```ts
private fillAddBtn: HTMLButtonElement | null = null
private fillRemoveBtn: HTMLButtonElement | null = null
```

3c. Null them in `buildBody()`'s reset block (where `this.fillRow = null` already happens):

```ts
this.fillAddBtn = null
this.fillRemoveBtn = null
```

3d. In `buildBody()`'s fill branch (`if (section.custom === 'fill')`), append the buttons to the title before `continue`:

```ts
// − before + (Layout's title glyph order: remove first). Only one is ever visible —
// refreshFillStroke flips them on the fill-empty predicate.
title.append(this.buildFillRemoveButton(), this.buildFillAddButton())
```

3e. Add the two builders near `buildFillSection()`:

```ts
private buildFillAddButton(): HTMLButtonElement {
  const btn = createButton({ label: '+' })
  btn.setAttribute('data-add-fill', '')
  btn.setAttribute('aria-label', 'Add fill')
  btn.title = 'Add fill — drafts a default background-color the request turns into a bg-* class'
  btn.hidden = true
  btn.addEventListener('click', () => {
    const el = this.el
    if (!el) return
    this.onBeforeEdit(el)
    // #D9D9D9 is Figma's default fill gray — a deliberately-neutral starting point the
    // color picker / nearest-token machinery immediately takes over from.
    this.drafts.apply(el, 'background-color', '#D9D9D9')
    this.refresh()
    this.onEdited()
  })
  this.fillAddBtn = btn
  return btn
}

private buildFillRemoveButton(): HTMLButtonElement {
  const btn = createButton({ label: '−' })
  btn.setAttribute('data-remove-fill', '')
  btn.setAttribute('aria-label', 'Remove fill')
  btn.title = 'Remove fill — the request tells the agent to drop bg-* classes'
  btn.hidden = true
  btn.addEventListener('click', () => {
    const el = this.el
    if (!el) return
    this.onBeforeEdit(el)
    if (this.drafts.current(el, 'background-color') !== null) {
      // Fill was added (or re-drafted) this session — pure undo, mirroring remove-auto-
      // layout: targeted discard restores the recorded original; nothing to send.
      this.drafts.discard(el, ['background-color'])
    } else {
      // Fill comes from the app's own CSS: draft transparent as the deterministic removal.
      this.drafts.apply(el, 'background-color', 'transparent')
    }
    this.refresh()
    this.onEdited()
  })
  this.fillRemoveBtn = btn
  return btn
}
```

3f. In `refreshFillStroke()`, before the existing `__refresh` calls, compute emptiness and toggle:

```ts
const fillEmpty = fillIsEmpty(this.currentValue(el, 'background-color', computed))
if (this.fillRow) this.fillRow.hidden = fillEmpty
if (this.fillAddBtn) this.fillAddBtn.hidden = !fillEmpty
if (this.fillRemoveBtn) this.fillRemoveBtn.hidden = fillEmpty
```

(The existing `fillRow.__refresh?.()` line stays — refreshing a hidden row is harmless and keeps the code un-branched.)

- [ ] **Step 4: Run the suite**

Run: `npx vitest run tests/client/panel.test.ts`
Expected: PASS — all new tests plus the adapted three plus everything pre-existing.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck -w the-forge`
Expected: clean.

```bash
git add packages/the-forge/src/client/panel.ts packages/the-forge/tests/client/panel.test.ts
git commit -m "feat(client): Fill empty state — title + button drafts default, − removes (undo-aware)"
```

---

### Task 4: Stroke empty state

**Files:**
- Modify: `packages/the-forge/src/client/panel.ts`
- Test: `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Consumes: `strokeIsEmpty` from `./panel-readers` (Task 1); `BORDER_WIDTH_PROPS`, `BORDER_STYLE_PROPS`, `BORDER_COLOR_PROPS` (already imported in panel.ts); `this.expandState` (existing `Map<string, boolean>`).
- Produces: `[data-add-stroke]` / `[data-remove-stroke]` buttons in the Stroke title; `Panel` private fields `strokeAddBtn`, `strokeRemoveBtn`, `strokeRowsWrap`, `strokeExpandBtn`, `strokeExpandWrap`.

- [ ] **Step 1: Write the failing tests**

Inside the existing `describe('Panel Stroke section', …)` block:

```ts
it('no painting border → stroke rows and ⋯ hidden, + shown', () => {
  const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
  expect((panel.root.querySelector('[data-add-stroke]') as HTMLElement).hidden).toBe(false)
  expect((panel.root.querySelector('[data-remove-stroke]') as HTMLElement).hidden).toBe(true)
  // the .stroke-rows wrap is the title's immediate body sibling
  expect((strokeSection(panel).nextElementSibling as HTMLElement).hidden).toBe(true)
  expect((panel.root.querySelector('[data-expand="stroke"]') as HTMLElement).hidden).toBe(true)
})

it('width set but style none still reads empty', () => {
  const { panel } = setup(
    `<div data-dc-source="src/Card.tsx:4:7" id="t" style="border-top-width: 3px;"></div>`
  )
  expect((panel.root.querySelector('[data-add-stroke]') as HTMLElement).hidden).toBe(false)
})

it('a lone border-bottom counts as a stroke (four-side predicate)', () => {
  const { panel } = setup(
    `<div data-dc-source="src/Card.tsx:4:7" id="t" style="border-bottom-style: solid; border-bottom-width: 1px;"></div>`
  )
  expect((panel.root.querySelector('[data-add-stroke]') as HTMLElement).hidden).toBe(true)
  expect((panel.root.querySelector('[data-remove-stroke]') as HTMLElement).hidden).toBe(false)
  expect((strokeSection(panel).nextElementSibling as HTMLElement).hidden).toBe(false)
})

it('+ drafts a 1px solid border on all four sides and flips to populated', () => {
  const { el, panel, drafts } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
  ;(panel.root.querySelector('[data-add-stroke]') as HTMLElement).click()
  for (const side of ['top', 'right', 'bottom', 'left']) {
    expect(drafts.current(el, `border-${side}-width`)).toBe('1px')
    expect(drafts.current(el, `border-${side}-style`)).toBe('solid')
  }
  expect((panel.root.querySelector('[data-remove-stroke]') as HTMLElement).hidden).toBe(false)
  expect((strokeSection(panel).nextElementSibling as HTMLElement).hidden).toBe(false)
  expect((panel.root.querySelector('[data-expand="stroke"]') as HTMLElement).hidden).toBe(false)
})

it('− after + is a pure undo: all border drafts discarded, back to empty', () => {
  const { el, panel, drafts } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
  ;(panel.root.querySelector('[data-add-stroke]') as HTMLElement).click()
  ;(panel.root.querySelector('[data-remove-stroke]') as HTMLElement).click()
  for (const side of ['top', 'right', 'bottom', 'left']) {
    expect(drafts.current(el, `border-${side}-width`)).toBe(null)
    expect(drafts.current(el, `border-${side}-style`)).toBe(null)
  }
  expect((panel.root.querySelector('[data-add-stroke]') as HTMLElement).hidden).toBe(false)
})

it('− on a stylesheet-real border drafts border-style: none on all sides', () => {
  const { el, panel, drafts } = setup(
    `<div data-dc-source="src/Card.tsx:4:7" id="t" style="border-style: solid; border-width: 2px;"></div>`
  )
  ;(panel.root.querySelector('[data-remove-stroke]') as HTMLElement).click()
  for (const side of ['top', 'right', 'bottom', 'left']) {
    expect(drafts.current(el, `border-${side}-style`)).toBe('none')
  }
  expect((panel.root.querySelector('[data-add-stroke]') as HTMLElement).hidden).toBe(false)
})

it('− on a real border with a session width tweak still drafts removal and discards the tweak (style anchor untouched)', () => {
  const { el, panel, drafts } = setup(
    `<div data-dc-source="src/Card.tsx:4:7" id="t" style="border-style: solid; border-width: 2px;"></div>`
  )
  commit(strokeWidthField(panel), '5') // widths drafted; style stays stylesheet-real (all sides already solid)
  ;(panel.root.querySelector('[data-remove-stroke]') as HTMLElement).click()
  for (const side of ['top', 'right', 'bottom', 'left']) {
    expect(drafts.current(el, `border-${side}-style`)).toBe('none')
    expect(drafts.current(el, `border-${side}-width`)).toBe(null) // tweak discarded, not kept
  }
})

it('the ⋯ open state survives a remove/add round-trip', () => {
  const { panel } = setup(
    `<div data-dc-source="src/Card.tsx:4:7" id="t" style="border-style: solid; border-width: 2px;"></div>`
  )
  const expandBtn = panel.root.querySelector('[data-expand="stroke"]') as HTMLElement
  expandBtn.click() // open BT/BR/BB/BL
  ;(panel.root.querySelector('[data-remove-stroke]') as HTMLElement).click()
  ;(panel.root.querySelector('[data-add-stroke]') as HTMLElement).click()
  const expandWrap = expandBtn.closest('.panel-section')!.nextElementSibling!.nextElementSibling as HTMLElement
  expect(expandWrap.hidden).toBe(false) // restored from expandState, not reset
})
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/client/panel.test.ts`
Expected: the eight new tests FAIL (`[data-add-stroke]` doesn't exist).

- [ ] **Step 3: Implement**

All edits in `packages/the-forge/src/client/panel.ts`.

3a. Extend the `./panel-readers` import with `strokeIsEmpty`.

3b. Add private fields next to `strokeColorRow`:

```ts
private strokeAddBtn: HTMLButtonElement | null = null
private strokeRemoveBtn: HTMLButtonElement | null = null
private strokeRowsWrap: HTMLElement | null = null
private strokeExpandBtn: HTMLElement | null = null
private strokeExpandWrap: HTMLElement | null = null
```

3c. Null all five in `buildBody()`'s reset block.

3d. In `buildBody()`'s stroke branch (`if (section.custom === 'stroke')`), after `rowWrap = this.buildStrokeSection()` and its append, keep the wrap and add the title buttons (before the shared `appendExpandRows` call so the `⋯` lands last — Layout glyph order):

```ts
this.strokeRowsWrap = rowWrap
title.append(this.buildStrokeRemoveButton(), this.buildStrokeAddButton())
```

3e. After the `this.appendExpandRows(section, title, sectionBodyEls)` call in that same generic path, capture the stroke expand widgets (they only exist for sections with `expandKey`; guard on the stroke branch):

```ts
if (section.custom === 'stroke') {
  // appendExpandRows just appended the ⋯ to the title and pushed expandWrap last —
  // refreshFillStroke needs both to hide the whole fine-tune affordance on an empty stroke.
  this.strokeExpandBtn = title.querySelector<HTMLButtonElement>('[data-expand="stroke"]')
  this.strokeExpandWrap = sectionBodyEls[sectionBodyEls.length - 1]
}
```

3f. Add the two builders near `buildStrokeSection()`:

```ts
private buildStrokeAddButton(): HTMLButtonElement {
  const btn = createButton({ label: '+' })
  btn.setAttribute('data-add-stroke', '')
  btn.setAttribute('aria-label', 'Add stroke')
  btn.title = 'Add stroke — drafts a 1px solid border (border + border-solid)'
  btn.hidden = true
  btn.addEventListener('click', () => {
    const el = this.el
    if (!el) return
    this.onBeforeEdit(el)
    // Width + style only — color is left to compute (usually currentColor), so the new
    // stroke is immediately visible without guessing at the project's palette.
    for (const prop of BORDER_WIDTH_PROPS) this.drafts.apply(el, prop, '1px')
    for (const prop of BORDER_STYLE_PROPS) this.drafts.apply(el, prop, 'solid')
    this.refresh()
    this.onEdited()
  })
  this.strokeAddBtn = btn
  return btn
}

private buildStrokeRemoveButton(): HTMLButtonElement {
  const btn = createButton({ label: '−' })
  btn.setAttribute('data-remove-stroke', '')
  btn.setAttribute('aria-label', 'Remove stroke')
  btn.title = 'Remove stroke — the request tells the agent to drop border classes (border-none)'
  btn.hidden = true
  btn.addEventListener('click', () => {
    const el = this.el
    if (!el) return
    this.onBeforeEdit(el)
    if (BORDER_STYLE_PROPS.some((prop) => this.drafts.current(el, prop) !== null)) {
      // Style is the anchor: adding a stroke always drafts it (directly or via
      // draftSolidIfNone), while a width tweak on a fully-bordered element never does.
      // Anchor drafted this session — pure undo of the whole stroke prop set.
      this.drafts.discard(el, [...BORDER_WIDTH_PROPS, ...BORDER_STYLE_PROPS, ...BORDER_COLOR_PROPS])
    } else {
      // Stroke comes from the app's own CSS: draft border-style none as the removal
      // (request builder → border-none); width/color drafts would contradict it — discard.
      this.drafts.discard(el, [...BORDER_WIDTH_PROPS, ...BORDER_COLOR_PROPS])
      for (const prop of BORDER_STYLE_PROPS) this.drafts.apply(el, prop, 'none')
    }
    this.refresh()
    this.onEdited()
  })
  this.strokeRemoveBtn = btn
  return btn
}
```

3g. In `refreshFillStroke()`, after the fill block from Task 3:

```ts
const strokeEmpty = strokeIsEmpty((prop) => this.currentValue(el, prop, computed))
if (this.strokeRowsWrap) this.strokeRowsWrap.hidden = strokeEmpty
if (this.strokeAddBtn) this.strokeAddBtn.hidden = !strokeEmpty
if (this.strokeRemoveBtn) this.strokeRemoveBtn.hidden = strokeEmpty
if (this.strokeExpandBtn) this.strokeExpandBtn.hidden = strokeEmpty
if (this.strokeExpandWrap) {
  // An empty stroke has nothing to fine-tune: force the BT/BR/BB/BL wrap closed, but
  // restore the user's sticky expandState when the stroke comes back (remove → add
  // round-trip must not silently reset an opened ⋯).
  this.strokeExpandWrap.hidden = strokeEmpty || !(this.expandState.get('stroke') ?? false)
}
```

- [ ] **Step 4: Run the suite**

Run: `npx vitest run tests/client/panel.test.ts`
Expected: PASS. Note: pre-existing stroke tests whose fixtures have no painting border (`'W field drafts all four border-*-width longhands'` with only `border-style: solid`, `'drafting a width while computed border-style is none…'`, `'style select drafts…'`) keep passing — a `hidden` wrap doesn't block programmatic `commit()`/`dispatchEvent`. If any of them fails on a visibility assertion instead, fix the FIXTURE (give it a painting border, e.g. add `border-width: 2px`) — never weaken the new empty-state assertions.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck -w the-forge`
Expected: clean.

```bash
git add packages/the-forge/src/client/panel.ts packages/the-forge/tests/client/panel.test.ts
git commit -m "feat(client): Stroke empty state — + drafts 1px solid, − removes (style-anchor undo), ⋯ hides when empty"
```

---

### Task 5: Full gate, budget, real-browser E2E

**Files:**
- No new files — verification only (fix-forward anything it surfaces).

- [ ] **Step 1: Root gate**

Run from the repo root: `npm test`
Expected: typecheck + full vitest suite green (~1200+ tests across ~44 files).

- [ ] **Step 2: Build + budget**

Run: `npm run build && ./scripts/check-prod-clean.sh`
Expected: build clean; prod-clean gate passes; unpacked size within the 250KB budget (was 244KB — this change adds well under 1KB).

- [ ] **Step 3: Real-browser E2E against the demo app**

jsdom cannot see cascade/computed styles — this step is the actual proof. First kill stale dev servers (`lsof -iTCP:5173`, kill any old pids — the server often binds IPv6 `[::1]:5173`), then start fresh (`npm run dev -w demo-app`; a restart is REQUIRED after the build — Vite caches the old client bundle). In the browser (preview tools or manually):

1. Toggle Design mode (bottom-right), select an element with **no background and no border**: Fill and Stroke sections show only their titles with `+` on the right; no swatch rows, no `⋯` on Stroke.
2. Click Fill's `+`: element turns `#D9D9D9` live; the swatch row appears; the title button flips to `−`.
3. Click Fill's `−`: gray disappears (pure undo — Changes list shows nothing pending for it).
4. Click Stroke's `+`: a 1px solid border appears live; W/style/Color rows and `⋯` appear.
5. Select an element that HAS a stylesheet background (e.g. a card): Fill shows the normal row with `−` in the title; click `−` → background goes transparent and the change is sendable.
6. Send a `+`-added fill to the agent and confirm the change request's markdown carries a `bg-*`/background-color delta (check `.the-forge/queue.json` at the git root).

Expected: all six observations hold.

- [ ] **Step 4: Commit any E2E fixes, then hand off**

If E2E surfaced fixes, commit them with why-comments. Then follow superpowers:finishing-a-development-branch (merge decision belongs to the user — this project merges via PR after user review).

---

## Deviations from spec

None intended. One spec note made concrete: the spec's "accepted edge" (re-drafting the anchor then `−` = undo rather than removal) also covers a width tweak on a **partially**-bordered element — `draftSolidIfNone` drafts the missing sides' styles, touching the anchor, so `−` first restores stylesheet reality and a second click drafts the removal. Graceful, two-click worst case, consistent with Layout.
