# Designer-Forward Panel — Milestone B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone M-B of [docs/specs/2026-07-05-designer-forward-panel-design.md](../specs/2026-07-05-designer-forward-panel-design.md) — Figma-style icon direction cluster (→ ↓ + wrap toggle in one row), a "− remove auto layout" affordance with clean undo-vs-request semantics, baseline alignment, plus the two M-A deferrals (CSS-hint titles on the remaining selects/segments; `font-size → text-*` hint).

**Architecture:** Client-panel work stacked on M-A. `SegmentField` gains per-option `ariaLabel` (icon-label support); the wrap control moves from a two-option segment in `layout-side` into a toggle button on the Direction row; remove-auto-layout and baseline are new `createButton`-factory buttons wired through the existing drafts/refresh cycle; the request builder gains one intent line for the `display: flex → block` case so the agent removes flex classes instead of adding `block`.

**Tech Stack:** TypeScript, vitest + jsdom (unit), real-browser E2E on the demo app (jsdom cannot see computed layout — repo gotcha).

## Global Constraints

- **Stacked branch:** create `designer-panel-m-b` off `designer-panel-m-a` HEAD (`1aad3ca`), NOT off `main` — M-A (PR #13) is unmerged. If PR #13 gains review commits, rebase this branch on it before continuing.
- Zero new runtime dependencies (CLAUDE.md hard constraint).
- Panel/overlay CSS class names are test hooks — extend, don't rename. New classes introduced here: `wrap-toggle`; new data hooks: `data-wrap-toggle`, `data-remove-layout`, `data-align-baseline`.
- **New buttons go through `src/client/ui/` factories** (`createButton`) — never raw `document.createElement('button')` (repo convention). `SegmentField`/`AlignMatrix` internals are pre-existing exceptions.
- Why-comments are load-bearing — preserve verbatim.
- All work from `packages/the-forge/`; single-file runs `npx vitest run tests/client/<file>.test.ts`; milestone gate is root `npm test`.
- Line numbers below are approximate (M-A shifted things) — each is paired with a search anchor; trust the anchor.
- The layout cluster stays **single-select only** (ratified decision B6) — all three new controls live inside the Layout section, which is already hidden in multi-select; do not add multi handling.

---

### Task 1: M-A deferrals — complete the CSS-hint coverage

**Files:**
- Modify: `packages/the-forge/src/client/panel-specs.ts` (`cssHintFor`, anchor: `export function cssHintFor`)
- Modify: `packages/the-forge/src/client/panel.ts` (typography family/weight selects, anchor: `className: 'type-family'` / `'type-weight'`; stroke style select in `buildStrokeSection`, anchor: `STROKE_STYLES.map`; align-self segment options in `buildFlexChildControls`, anchor: `label: 'Align'` or the options `{ value: 'flex-start', label: 'Start' }`)
- Modify: `packages/the-forge/src/client/layout-controls.ts` (`makeDot`, anchor: `private makeDot`)
- Test: `packages/the-forge/tests/client/panel-specs.test.ts`, `packages/the-forge/tests/client/panel.test.ts`, `packages/the-forge/tests/client/layout-controls.test.ts`

**Interfaces:**
- Consumes: `cssHintFor(spec: { props: string[] }): string` (M-A), `createSelect` (has no title opt — set `.title` on the returned element), SegmentField per-option `title` (M-A).
- Produces: `cssHintFor` special-cases font-size; no new exports.

- [ ] **Step 1: Write failing tests.** In `tests/client/panel-specs.test.ts`, add to the `cssHintFor` describe:

```ts
it('special-cases font-size to the text-* utility (mirrors request-path mapping in tokens.ts)', () => {
  expect(cssHintFor({ props: ['font-size'] })).toBe('font-size → text-*')
})
```

In `tests/client/layout-controls.test.ts`, in the AlignMatrix describe (mirror its existing construction):

```ts
it('dots carry a CSS-hint title', () => {
  const m = new AlignMatrix({ onInput: () => {} })
  m.set('flex-start', 'flex-start', 'row', false)
  const dot = m.root.querySelector('.am-dot') as HTMLElement
  expect(dot.title).toBe('justify-content: flex-start · align-items: flex-start')
})
```

- [ ] **Step 2: Run them** — `npx vitest run tests/client/panel-specs.test.ts tests/client/layout-controls.test.ts`. Expected: FAIL (bare `font-size` hint; empty dot title).

- [ ] **Step 3: Implement.**
  - `panel-specs.ts`, first line of `cssHintFor`'s body (mirroring the request path's `prop === 'font-size' ? 'text' : …` special case in tokens.ts):

```ts
// font-size maps to text-* on the request path via a special case in tokens.ts (the 'text'
// prefix is shared with color utilities, so it can't live in UTILITY_PREFIXES) — mirror it
// here so the S field's tooltip names the utility the request will actually emit.
if (spec.props.includes('font-size')) return 'font-size → text-*'
```

  - `layout-controls.ts` `makeDot`, after `dot.dataset.a = a`: `dot.title = ` + template `` `justify-content: ${j} · align-items: ${a}` ``.
  - `panel.ts`: after each `createSelect` call, set a title on the returned element:
    - family select: `familySelect.title = 'font-family'`
    - weight select: `weightSelect.title = 'font-weight → font-*'`
    - stroke style select (in `buildStrokeSection`, the `STROKE_STYLES` one): `styleSelect.title = 'border-style → border-solid / border-dashed / border-dotted'` (adapt the local variable name to the code).
  - `panel.ts` `buildFlexChildControls` align-self segment options — add per-option titles:

```ts
{ value: 'flex-start', label: 'Start', title: 'align-self: flex-start → self-start' },
{ value: 'center', label: 'Center', title: 'align-self: center → self-center' },
{ value: 'flex-end', label: 'End', title: 'align-self: flex-end → self-end' },
```

- [ ] **Step 4: Add a wiring test** in `tests/client/panel.test.ts` (same panel setup as the M-A hint test, anchor: `it('field labels carry CSS/Tailwind hint tooltips'`):

```ts
it('typography and stroke selects carry CSS-hint titles', () => {
  expect((panel.root.querySelector('.type-weight') as HTMLElement).title).toBe('font-weight → font-*')
  expect((panel.root.querySelector('.type-family') as HTMLElement).title).toBe('font-family')
})
```

(Note: this test needs an element with direct text so Typography renders — mirror the setup of the existing typography tests in the file.)

- [ ] **Step 5: Run** — `npx vitest run tests/client/panel-specs.test.ts tests/client/layout-controls.test.ts tests/client/panel.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(client): complete CSS-hint coverage — font-size text-*, selects, align controls"
```

---

### Task 2: Direction icons + wrap toggle joins the row

**Files:**
- Modify: `packages/the-forge/src/client/layout-controls.ts` (SegmentFieldOpts option type + button construction, anchor: `button.title = option.title ?? option.label`)
- Modify: `packages/the-forge/src/client/panel.ts` (`buildLayoutSection` direction/wrap, anchors: `label: 'Horizontal'`, `this.wrapField = new SegmentField`; `refreshLayoutSection`, anchor: `this.wrapField?.set`; member declarations, anchor: `private wrapField`; teardown null-out, anchor: `this.wrapField = null`)
- Modify: `packages/the-forge/src/client/overlay.ts` (CSS string const — add a `.wrap-toggle` rule near the existing `.seg` rules)
- Modify: `packages/the-forge/stories/segment-field.stories.ts` (add an icon-variant story)
- Test: `packages/the-forge/tests/client/layout-controls.test.ts`, `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Consumes: `createButton({ label })` from `src/client/ui/button.ts`; `this.currentValue(el, prop, computed)` (existing private drafts-aware reader used by `refreshLayoutSection`).
- Produces: `SegmentFieldOpts.options[].ariaLabel?: string` (sets `aria-label` on the option button). Panel member `wrapToggle: HTMLButtonElement | null` replaces `wrapField: SegmentField | null`. Direction row DOM: `.seg-field[data-flex-direction]` containing label + `.seg-track` (two icon buttons) + the wrap toggle button (`.wrap-toggle[data-wrap-toggle]`) appended after the track.

- [ ] **Step 1: Write the failing SegmentField test** in `tests/client/layout-controls.test.ts`:

```ts
it('applies per-option aria-labels for icon options', () => {
  const f = new SegmentField({
    label: 'Direction',
    options: [
      { value: 'row', label: '→', ariaLabel: 'Horizontal', title: 'flex-direction: row → flex-row' },
      { value: 'column', label: '↓', ariaLabel: 'Vertical' },
    ],
    onInput: () => {},
  })
  const btns = [...f.root.querySelectorAll('.seg')] as HTMLElement[]
  expect(btns[0].getAttribute('aria-label')).toBe('Horizontal')
  expect(btns[0].textContent).toBe('→')
  expect(btns[1].getAttribute('aria-label')).toBe('Vertical')
})
```

- [ ] **Step 2: Run it** — `npx vitest run tests/client/layout-controls.test.ts`. Expected: FAIL (aria-label null).

- [ ] **Step 3: Implement SegmentField support.** In `layout-controls.ts`: option type becomes `Array<{ value: string; label: string; title?: string; ariaLabel?: string }>`; in the options loop, after the title assignment: `if (option.ariaLabel) button.setAttribute('aria-label', option.ariaLabel)`.

- [ ] **Step 4: Write the failing panel tests.** In `tests/client/panel.test.ts`, replace the two wrap-segment tests (anchors: `layout-side contains Gap (a .nf) then Wrap (a .seg-field)` comment, and `it('wrap segment field drafts flex-wrap'`) with:

```ts
it('direction row is icon pair + wrap toggle; layout-side holds only Gap', () => {
  // flex element setup — same as the existing direction-segment tests (flexSetup)
  const dirField = [...panel.root.querySelectorAll('.seg-field')].find(
    (n) => n.querySelector('.seg-field-label')?.textContent === 'Direction'
  ) as HTMLElement
  const segs = [...dirField.querySelectorAll('.seg-track .seg')] as HTMLElement[]
  expect(segs.map((b) => b.textContent)).toEqual(['→', '↓'])
  expect(segs.map((b) => b.getAttribute('aria-label'))).toEqual(['Horizontal', 'Vertical'])
  const wrapBtn = dirField.querySelector('[data-wrap-toggle]') as HTMLElement
  expect(wrapBtn).toBeTruthy()
  expect(wrapBtn.getAttribute('aria-label')).toBe('Wrap')
  const side = panel.root.querySelector('.layout-side') as HTMLElement
  expect(side.querySelector('.seg-field')).toBeNull() // old Wrap segment gone
  expect(side.querySelector('.nf')).toBeTruthy() // Gap stays
})

it('wrap toggle drafts flex-wrap and reflects state', () => {
  // flex element setup — same as above
  const wrapBtn = panel.root.querySelector('[data-wrap-toggle]') as HTMLButtonElement
  wrapBtn.click()
  expect(el.style.getPropertyValue('flex-wrap')).toBe('wrap')
  expect(wrapBtn.classList.contains('seg-active')).toBe(true)
  expect(wrapBtn.getAttribute('aria-pressed')).toBe('true')
  wrapBtn.click()
  expect(el.style.getPropertyValue('flex-wrap')).toBe('nowrap')
  expect(wrapBtn.classList.contains('seg-active')).toBe(false)
})
```

(Fill the setup lines from the file's existing direction-segment tests — same `flexSetup`/`show` pattern and `el` variable; the draft assertions mirror how the old wrap test asserted `flex-wrap`.)

- [ ] **Step 5: Run** — `npx vitest run tests/client/panel.test.ts -t 'wrap'`. Expected: FAIL.

- [ ] **Step 6: Implement in panel.ts.**
  - Member: replace `private wrapField: SegmentField | null = null` with `private wrapToggle: HTMLButtonElement | null = null`; update the teardown null-out (`this.wrapField = null` → `this.wrapToggle = null`).
  - `buildLayoutSection`: Direction options become icon options (titles kept from M-A):

```ts
options: [
  { value: 'row', label: '→', ariaLabel: 'Horizontal', title: 'flex-direction: row → flex-row' },
  { value: 'column', label: '↓', ariaLabel: 'Vertical', title: 'flex-direction: column → flex-col' },
],
```

  - Delete the whole `this.wrapField = new SegmentField({...})` block and its `side.append(this.wrapField.root)`; in its place (right after `controls.append(this.directionField.root)` — the toggle is part of the Direction row):

```ts
// Wrap lives on the Direction row (Figma UI3 grouping) as an independent toggle —
// it is NOT part of the exclusive direction segment, so it's a sibling of the track.
const wrapBtn = createButton({ label: '↩' })
wrapBtn.classList.add('seg', 'wrap-toggle')
wrapBtn.setAttribute('data-wrap-toggle', '')
wrapBtn.setAttribute('aria-label', 'Wrap')
wrapBtn.title = 'flex-wrap: wrap → flex-wrap'
wrapBtn.addEventListener('click', () => {
  if (!this.el) return
  this.onBeforeEdit(this.el)
  const current = this.currentValue(this.el, 'flex-wrap', getComputedStyle(this.el))
  this.drafts.apply(this.el, 'flex-wrap', current === 'wrap' ? 'nowrap' : 'wrap')
  this.refresh()
  this.onEdited()
})
this.wrapToggle = wrapBtn
this.directionField.root.append(wrapBtn)
```

  - `refreshLayoutSection`: replace `this.wrapField?.set(wrap === 'wrap' ? 'wrap' : 'nowrap')` with:

```ts
const wrapping = wrap === 'wrap'
this.wrapToggle?.classList.toggle('seg-active', wrapping)
this.wrapToggle?.setAttribute('aria-pressed', String(wrapping))
```

  - If `createButton` forces a class or type of its own, keep them and add ours (check `src/client/ui/button.ts` — one-line factory; do not bypass it).
  - `overlay.ts`: add a `.wrap-toggle` rule near the `.seg` rules (small left margin so it reads as attached-but-separate from the track, e.g. `margin-left: 6px`). Extend the CSS string const; rename nothing.

- [ ] **Step 7: Add the icon story.** In `stories/segment-field.stories.ts`, add alongside the existing stories:

```ts
export const IconSegments = () =>
  storyFrame(
    new SegmentField({
      label: 'Direction',
      options: [
        { value: 'row', label: '→', ariaLabel: 'Horizontal', title: 'flex-direction: row → flex-row' },
        { value: 'column', label: '↓', ariaLabel: 'Vertical', title: 'flex-direction: column → flex-col' },
      ],
      onInput: () => {},
    }).root
  )
```

(Adapt to the file's actual story-export/frame pattern — copy the shape of the existing `ActiveSegment` story.)

- [ ] **Step 8: Full client run** — `npx vitest run tests/client/`. Expected: PASS (watch for other tests that referenced the old Wrap segment — the Task 4-era `layout-side contains Gap then Wrap` order test was replaced in Step 4; fix any further stragglers found by `grep -n "'Wrap'" tests/client/*.test.ts` the same way).

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(client): icon direction pair with wrap toggle on the Direction row"
```

---

### Task 3: − Remove auto layout

**Files:**
- Modify: `packages/the-forge/src/client/panel.ts` (buildBody Layout-section title, anchor: `custom === 'layout'` branch / where the section `title` element is created; `buildLayoutSection` is NOT the place — the button lives in the section header; `refreshLayoutSection`, anchor: `this.addLayoutBtn.hidden = flex`; member declarations near `addLayoutBtn`)
- Modify: `packages/the-forge/src/client/request.ts` (`renderMarkdown` per-change line building, anchor: `c.tokenExact ? '' :`)
- Test: `packages/the-forge/tests/client/panel.test.ts`, `packages/the-forge/tests/client/request.test.ts`

**Interfaces:**
- Consumes: `createButton`, `DraftStore.current/apply/discard(el, props?)` (targeted discard restores recorded originals), `this.drafts`.
- Produces: panel member `removeLayoutBtn: HTMLButtonElement | null`; module const `FLEX_CONTAINER_PROPS = ['flex-direction', 'gap', 'justify-content', 'align-items', 'flex-wrap']` in panel.ts; intent sentence in request markdown (exact text below) that Task 5's E2E asserts.

- [ ] **Step 1: Write failing panel tests** in `tests/client/panel.test.ts` (same flex/non-flex setups as the add-auto-layout tests, anchor: `data-add-layout`):

```ts
describe('remove auto layout', () => {
  it('remove button is visible only when the element is flex (mirror of add)', () => {
    // non-flex element: [data-remove-layout] hidden, [data-add-layout] visible
    // flex element: [data-remove-layout] visible, [data-add-layout] hidden
  })

  it('added-this-session: remove is a pure undo (discards drafts, nothing left to send)', () => {
    // non-flex element → click [data-add-layout] → set a gap via the Gap field
    // → click [data-remove-layout]
    // expect el.style display and gap to be '' (drafts discarded, inline styles restored)
    // expect buildChangeRequest(drafts).elements to contain no entry for el
  })

  it('stylesheet flex: remove drafts display block and discards other flex drafts', () => {
    // element whose stylesheet/inline ORIGINAL display is flex (set el.style.display='flex'
    // BEFORE panel.show so DraftStore records it as the original — mirror how flexSetup does it)
    // → draft a justify via the matrix → click [data-remove-layout]
    // expect drafts.current(el, 'display') === 'block'
    // expect drafts.current(el, 'justify-content') === null (discarded)
  })
})
```

Fill the bodies with the file's existing helpers (`flexSetup`, `fieldInput(panel, P.GAP)`, matrix dot clicks are already exercised in the align tests). The assertions shown are the contract; keep them.

- [ ] **Step 2: Run** — `npx vitest run tests/client/panel.test.ts -t 'remove auto layout'`. Expected: FAIL (no `[data-remove-layout]`).

- [ ] **Step 3: Implement in panel.ts.**
  - Module-level const near the top (after imports):

```ts
// The container-side flex props the panel can draft — the set 'remove auto layout' must
// clean up alongside display (child props like align-self/flex-grow belong to the CHILD's
// own remove story, not the container's).
const FLEX_CONTAINER_PROPS = ['flex-direction', 'gap', 'justify-content', 'align-items', 'flex-wrap']
```

  - Member next to `addLayoutBtn`: `private removeLayoutBtn: HTMLButtonElement | null = null` (+ null-out in teardown next to the others).
  - In `buildBody`, in the Layout-section branch, right after the section `title` element exists:

```ts
const removeBtn = createButton({ label: '−' })
removeBtn.setAttribute('data-remove-layout', '')
removeBtn.setAttribute('aria-label', 'Remove auto layout')
removeBtn.title = 'Remove auto layout — the request tells the agent to drop flex/flex-col/gap-*/justify-*/items-* classes'
removeBtn.hidden = true
removeBtn.addEventListener('click', () => {
  if (!this.el) return
  this.onBeforeEdit(this.el)
  if (this.drafts.current(this.el, 'display') !== null) {
    // Auto layout was added (or display re-drafted) this session — pure undo: targeted
    // discard restores the recorded originals, so the element returns to its stylesheet
    // reality and there is nothing to send.
    this.drafts.discard(this.el, ['display', ...FLEX_CONTAINER_PROPS])
  } else {
    // Flex comes from the app's own CSS: draft display:block as the deterministic preview,
    // and discard any container-prop drafts so the request is just the removal.
    this.drafts.discard(this.el, FLEX_CONTAINER_PROPS)
    this.drafts.apply(this.el, 'display', 'block')
  }
  this.refresh()
  this.onEdited()
})
this.removeLayoutBtn = removeBtn
title.append(removeBtn)
```

(Adapt `title` to the actual variable name in that scope; the expand-button `title.append(btn)` pattern lower in buildBody shows the shape.)
  - `refreshLayoutSection`, next to the add-button line:

```ts
if (this.removeLayoutBtn) this.removeLayoutBtn.hidden = !flex
```

- [ ] **Step 4: Run** — same command. Expected: PASS.

- [ ] **Step 5: Write the failing request test** in `tests/client/request.test.ts` (mirror the file's existing builder-test setup — create element, `drafts.apply`, `buildChangeRequest`, `renderMarkdown`):

```ts
it('display flex→block carries the remove-auto-layout intent line', () => {
  // element whose original display is flex; drafts.apply(el, 'display', 'block')
  const md = renderMarkdown(buildChangeRequest(drafts))
  expect(md).toContain('remove auto layout (flexbox) from this element')
  expect(md).toContain('remove flex/flex-col/gap-*/justify-*/items-* classes rather than adding `display: block`')
})
```

- [ ] **Step 6: Run** — `npx vitest run tests/client/request.test.ts -t 'remove-auto-layout'`. Expected: FAIL.

- [ ] **Step 7: Implement in request.ts** — in `renderMarkdown`'s per-change loop (where `line` is assembled; anchor `c.tokenExact ? '' :`), add after the existing suffix logic:

```ts
// 'display: flex → block' is never the literal ask — it is the panel's deterministic
// preview of REMOVING auto layout. Spell the intent out so the agent edits classes
// (removes the flex family) instead of faithfully adding a block utility.
if (c.prop === 'display' && (c.beforeCss === 'flex' || c.beforeCss === 'inline-flex') && c.afterCss === 'block') {
  line += ' — intent: remove auto layout (flexbox) from this element; remove flex/flex-col/gap-*/justify-*/items-* classes rather than adding `display: block`'
}
```

(Adapt field names to `ChangeItem`'s actual shape — `prop`/`beforeCss`/`afterCss` per the interface at the top of the file.)

- [ ] **Step 8: Run** — `npx vitest run tests/client/request.test.ts tests/client/panel.test.ts`. Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(client): remove auto layout — undo when session-added, intent-phrased request when stylesheet flex"
```

---

### Task 4: Baseline alignment toggle

**Files:**
- Modify: `packages/the-forge/src/client/panel.ts` (`buildLayoutSection` matrix tile area, anchor: `tile.append(this.alignMatrix.root)`; `refreshLayoutSection`, anchor: `this.alignMatrix?.set`; members/teardown)
- Test: `packages/the-forge/tests/client/panel.test.ts`, `packages/the-forge/tests/client/panel-readers.test.ts`

**Interfaces:**
- Consumes: `createButton`, `normalizeAlign` (already passes `baseline` through — its keyword map only rewrites normal/start/''/end; add the pinning test, no code change), `AlignMatrix.set` (no change: an active dot requires BOTH justify and align to match, so `align === 'baseline'` already lights no dot).
- Produces: panel member `baselineToggle: HTMLButtonElement | null`; `[data-align-baseline]` hook.

- [ ] **Step 1: Pin the passthrough** in `tests/client/panel-readers.test.ts`:

```ts
it('normalizeAlign passes baseline through untouched (baseline is a real matrix-less state)', () => {
  expect(normalizeAlign('baseline')).toBe('baseline')
})
```

Run `npx vitest run tests/client/panel-readers.test.ts` — expected: PASS immediately (documents existing behavior; keep it as a regression pin).

- [ ] **Step 2: Write failing panel tests** in `tests/client/panel.test.ts` (flex setup as usual):

```ts
describe('baseline alignment', () => {
  it('toggle drafts align-items baseline and carries active state; matrix has no active dot', () => {
    // flex element setup
    const btn = panel.root.querySelector('[data-align-baseline]') as HTMLButtonElement
    btn.click()
    expect(el.style.getPropertyValue('align-items')).toBe('baseline')
    expect(btn.classList.contains('seg-active')).toBe(true)
    expect(panel.root.querySelector('.am-dot.am-active')).toBeNull()
  })

  it('clicking active toggle releases baseline (targeted discard of the session draft)', () => {
    // flex element setup; click once (baseline on), click again
    // expect el.style align-items '' (draft discarded → stylesheet reality)
    // expect btn.classList seg-active false
  })

  it('clicking a matrix dot exits baseline', () => {
    // flex element; toggle baseline on; click a matrix dot
    // expect drafts.current(el, 'align-items') to be the dot keyword, toggle inactive
  })
})
```

Fill bodies from the file's existing matrix tests (they already click `.am-dot`s and assert drafted justify/align).

- [ ] **Step 3: Run** — `npx vitest run tests/client/panel.test.ts -t 'baseline'`. Expected: FAIL.

- [ ] **Step 4: Implement in panel.ts.**
  - Member `private baselineToggle: HTMLButtonElement | null = null` (+ teardown null-out).
  - In `buildLayoutSection`, after `tile.append(this.alignMatrix.root)`:

```ts
// Figma keeps baseline out of the 9-dot matrix (it's an 'align text baseline' extra) —
// a small toggle under the matrix drafts it. Toggling OFF discards the session draft
// (stylesheet reality returns); if baseline came from the app's own CSS there is no
// draft to discard, so OFF drafts flex-start (the normalize default) instead.
const baselineBtn = createButton({ label: 'Baseline' })
baselineBtn.classList.add('seg')
baselineBtn.setAttribute('data-align-baseline', '')
baselineBtn.title = 'align-items: baseline → items-baseline'
baselineBtn.addEventListener('click', () => {
  if (!this.el) return
  this.onBeforeEdit(this.el)
  const active = this.currentValue(this.el, 'align-items', getComputedStyle(this.el)) === 'baseline'
  if (!active) {
    this.drafts.apply(this.el, 'align-items', 'baseline')
  } else if (this.drafts.current(this.el, 'align-items') !== null) {
    this.drafts.discard(this.el, ['align-items'])
  } else {
    this.drafts.apply(this.el, 'align-items', 'flex-start')
  }
  this.refresh()
  this.onEdited()
})
this.baselineToggle = baselineBtn
tile.append(baselineBtn)
```

  - `refreshLayoutSection`, after the `alignMatrix?.set(...)` call (which already receives the raw normalized align):

```ts
this.baselineToggle?.classList.toggle('seg-active', normalizeAlign(align) === 'baseline')
```

(Adapt to the local variable already holding align in that scope — it's read for the matrix call; import of `normalizeAlign` already exists in panel.ts.)

- [ ] **Step 5: Run** — `npx vitest run tests/client/panel.test.ts tests/client/panel-readers.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(client): baseline alignment toggle beside the align matrix"
```

---

### Task 5: Real-browser E2E + spec sync + gate

**Files:**
- Modify (only if E2E reveals wording drift): `docs/specs/2026-07-05-designer-forward-panel-design.md` M-B section
- No fixture change expected (the demo app has stylesheet-flex containers already; the M-A `mt-6` card remains for regression)

- [ ] **Step 1: Build + fresh dev server** (stale-server gotcha):

```bash
npm run build
lsof -iTCP:5173 -sTCP:LISTEN -n -P || true   # kill any listed pid first
npm run dev -w demo-app
```

(Fresh-worktree gotcha: if the served bundle lacks the new controls, run `npm install` in the worktree and restart — Vite otherwise resolves `the-forge` to the main checkout's stale build.)

- [ ] **Step 2: Browser pass** (playwright MCP, shadow root via the design-mode host):
  a. Select a stylesheet-flex element → Direction row shows `→`/`↓` buttons (aria-labels Horizontal/Vertical) + wrap toggle; old Wrap segment gone from layout-side.
  b. Click `↓` → computed `flex-direction` becomes `column`; matrix orientation follows (existing behavior).
  c. Click wrap toggle twice → computed `flex-wrap` goes `wrap` then `nowrap`; `seg-active`/`aria-pressed` track it.
  d. `−` remove button visible on the flex element, hidden on a non-flex element (where `+ Add auto layout` shows instead).
  e. On a NON-flex element: `+ Add auto layout` → set a gap → `−` remove → element back to original computed display, gap gone, Changes list shows no pending draft for it.
  f. On the stylesheet-flex element: `−` remove → computed display `block`; Send → queue markdown contains `remove auto layout (flexbox) from this element` and the `rather than adding \`display: block\`` clause.
  g. Baseline toggle: click → computed `align-items: baseline`, no active matrix dot, toggle highlighted; click a matrix dot → baseline exits.
  h. Hover checks (getAttribute('title')): S label shows `font-size → text-*`; weight select shows `font-weight → font-*`; a matrix dot shows its `justify-content: … · align-items: …` title.
- Kill the dev server when done. Record evidence per item (selector + observed value) in the report.

- [ ] **Step 3: Spec sync** — if any shipped detail differs from the M-B spec section (e.g. baseline toggle OFF semantics, which the spec doesn't define — document the shipped rule in one sentence), update the spec the way M-A's Task 5 did. If nothing drifted, state so explicitly.

- [ ] **Step 4: Full gate** — from repo root: `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: M-B spec sync; E2E-verified icon cluster, remove auto layout, baseline"
```

---

## Self-review notes (run after drafting — resolved)

- **Spec coverage:** M-B spec items — direction icons w/ aria+title (Task 2), wrap joins row (Task 2), remove auto layout both semantics + `data-remove-layout` + intent-phrased request (Task 3), baseline toggle + `data-align-baseline` + normalizeAlign passthrough + no-active-dot (Task 4), M-A deferrals (Task 1). ✓
- **Deliberate deviations from spec text:** (1) spec says "`normalizeAlign` learns to pass baseline through" — it already does; Task 4 pins it with a test instead of changing code. (2) Spec leaves baseline toggle-OFF undefined — Task 4 defines it (discard session draft, else draft flex-start) and Task 5 syncs the spec. (3) Icons are unicode glyphs (`→`, `↓`, `↩`), not SVG — matches the codebase's existing `⋯` button precedent; revisit only if the user wants Figma-exact glyphs.
- **Type consistency:** `SegmentFieldOpts.options[].ariaLabel?` (Task 2) is what Task 2's panel code and story use; `FLEX_CONTAINER_PROPS` defined and consumed only in panel.ts (Task 3); `removeLayoutBtn`/`wrapToggle`/`baselineToggle` all `HTMLButtonElement | null` matching the existing `addLayoutBtn` pattern.
- **Known judgment calls for the executor:** exact local variable names at the anchors (section `title` var, stroke style select), and mirroring existing test setups (`flexSetup`, matrix-dot clicks) rather than inventing new scaffolding.
