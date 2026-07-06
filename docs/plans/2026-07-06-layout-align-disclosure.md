# Layout Section Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement [docs/specs/2026-07-06-layout-align-disclosure-design.md](../specs/2026-07-06-layout-align-disclosure-design.md) — align-self behind an off-by-default toggle at the bottom of the Layout section, a labeled one-line Padding row, and the wide-panel centering fix.

**Architecture:** All client-side (`packages/the-forge/src/client/`). A new pure predicate in `panel-readers.ts`; DOM recomposition in `panel.ts` `buildBody`'s layout branch; toggle state + behavior in `panel-layout.ts` (`LayoutSection`); CSS in `overlay.ts`'s style string. No server, MCP, or transform changes.

**Tech Stack:** TypeScript, vanilla DOM in a shadow root, vitest + jsdom (behavior), real-browser E2E via the demo app (layout — jsdom cannot see flex).

## Global Constraints

- Zero new runtime dependencies; zero production footprint (client is dev-serve only).
- Package budget: `check-prod-clean.sh` enforces 250KB unpacked; currently at 247KB — verify before merge.
- Panel/overlay CSS class names are test hooks — extend, don't rename (`data-align-self`, `.flex-child-controls` must survive).
- New buttons go through `src/client/ui/` factories (`createButton`), never raw `document.createElement('button')`.
- Why-comments are load-bearing — preserve verbatim when moving code.
- jsdom can't see flex layout — CSS changes are verified by the real-browser E2E task, not unit tests.
- Run single suites from `packages/the-forge/`: `npx vitest run tests/client/<file>.test.ts`. Root `npm test` is the merge gate.
- Work happens on the current worktree branch `claude/heuristic-moore-8716aa`.

---

### Task 1: `alignSelfRowOn` predicate

**Files:**
- Modify: `packages/the-forge/src/client/panel-readers.ts` (add export after `minMaxRowVisible`, ~line 91)
- Test: `packages/the-forge/tests/client/panel-readers.test.ts`

**Interfaces:**
- Produces: `alignSelfRowOn(computed: string, hasDraft: boolean, opened: boolean): boolean` — Task 2 imports it from `./panel-readers` in `panel-layout.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/panel-readers.test.ts` (it already imports from `../../src/client/panel-readers`; add `alignSelfRowOn` to that import):

```ts
describe('alignSelfRowOn', () => {
  it('is on when manually opened, regardless of value', () => {
    expect(alignSelfRowOn('auto', false, true)).toBe(true)
  })
  it('is on when a draft is live', () => {
    expect(alignSelfRowOn('auto', true, false)).toBe(true)
  })
  it('is off for default computed values (jsdom empty string counts as default)', () => {
    expect(alignSelfRowOn('', false, false)).toBe(false)
    expect(alignSelfRowOn('auto', false, false)).toBe(false)
    expect(alignSelfRowOn('normal', false, false)).toBe(false)
  })
  it('auto-reveals a non-default computed align-self (app CSS or Fill-written stretch)', () => {
    expect(alignSelfRowOn('stretch', false, false)).toBe(true)
    expect(alignSelfRowOn('center', false, false)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/the-forge && npx vitest run tests/client/panel-readers.test.ts`
Expected: FAIL — `alignSelfRowOn` is not exported.

- [ ] **Step 3: Implement**

Add to `src/client/panel-readers.ts`, directly below `minMaxRowVisible` (same disclosure-predicate family — keep them adjacent):

```ts
/**
 * Align-self row disclosure (2026-07-06 layout-polish spec): the row's toggle reads ON when
 * the user opened it this selection, a draft is live, or the computed value is non-default —
 * an off toggle must never mask a real align-self from the app's CSS or from cross-axis
 * size-mode Fill (which writes align-self: stretch). Defaults: '', 'auto', 'normal'
 * (jsdom '' counts as default, same convention as minMaxRowVisible).
 */
export function alignSelfRowOn(computed: string, hasDraft: boolean, opened: boolean): boolean {
  if (opened || hasDraft) return true
  return !['', 'auto', 'normal'].includes(computed)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/the-forge && npx vitest run tests/client/panel-readers.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/panel-readers.ts packages/the-forge/tests/client/panel-readers.test.ts
git commit -m "feat(client): alignSelfRowOn disclosure predicate"
```

---

### Task 2: Layout body recomposition — padding block, align block to the bottom

Structural only: the align strip still shows whenever the parent is flex (toggle behavior is Task 3). A reviewer can approve this ordering/labeling change independently.

**Files:**
- Modify: `packages/the-forge/src/client/panel.ts` (buildBody layout branch, lines ~501–528)
- Modify: `packages/the-forge/src/client/panel-layout.ts` (`buildFlexChildControls` gets the Align header)
- Test: `packages/the-forge/tests/client/panel.test.ts` (composition test ~line 293, flex-child tests ~610–649)

**Interfaces:**
- Consumes: existing `buildRow`, `PADDING_ROWS`, `LayoutSection.buildBodyInto/buildFlexChildControls`.
- Produces DOM contract for Tasks 3–5: `.padding-block[data-padding-row]` > `span.group-label` ("Padding") + `.padding-fields` > two `.nf`s; `.flex-child-controls` > `.align-head` (`span.group-label` "Align" + `button[data-align-toggle]`) + `[data-align-self]` strip. In-section order: size rows → cluster → padding block → align block.

- [ ] **Step 1: Update the composition test to the new order (failing first)**

In `tests/client/panel.test.ts`, replace the body of the test `'unified Layout body composes W/H, flex-child strip, cluster, padding in order (spec M-C)'` with (rename it too):

```ts
it('unified Layout body composes W/H, cluster, padding, align in order (2026-07-06 layout-polish spec)', () => {
  const { panel } = flexSetup()
  const body = panel.root.querySelector('.layout-section') as HTMLElement
  const kinds = [...body.children].map((c) =>
    c.classList.contains('size-row')
      ? 'size'
      : c.hasAttribute('data-minmax-row')
        ? (c as HTMLElement).dataset.propsRow?.startsWith('min')
          ? 'minmax-min'
          : 'minmax-max'
        : c.classList.contains('flex-child-controls')
          ? 'align'
          : c.classList.contains('layout-controls') || c.hasAttribute('data-add-layout')
            ? 'cluster'
            : c.hasAttribute('data-padding-row')
              ? 'padding'
              : c.className
  )
  expect(kinds).toEqual([
    'size',
    'minmax-min',
    'minmax-max',
    'size',
    'minmax-min',
    'minmax-max',
    'cluster',
    'cluster',
    'padding',
    'align',
  ])
})
```

Also add, in the same describe block:

```ts
it('padding block carries a group label and one line with both H/V fields', () => {
  const { panel } = setup()
  const block = panel.root.querySelector('[data-padding-row]') as HTMLElement
  expect(block).toBeTruthy()
  expect((block.querySelector('.group-label') as HTMLElement).textContent).toBe('Padding')
  const fields = [...block.querySelectorAll('.padding-fields .nf')] as HTMLElement[]
  expect(fields.map((f) => f.dataset.props)).toEqual([
    'padding-left padding-right',
    'padding-top padding-bottom',
  ])
})

it('align block carries a group label and the toggle button', () => {
  const { panel } = setup()
  const wrap = panel.root.querySelector('.flex-child-controls') as HTMLElement
  expect((wrap.querySelector('.group-label') as HTMLElement).textContent).toBe('Align')
  expect(wrap.querySelector('[data-align-toggle]')).toBeTruthy()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/the-forge && npx vitest run tests/client/panel.test.ts`
Expected: FAIL — old order `['size', …, 'flex-child', 'cluster', 'cluster', 'padding', 'padding']`, no `[data-padding-row]`, no `[data-align-toggle]`.

- [ ] **Step 3: Recompose buildBody's layout branch in panel.ts**

Replace lines 520–524 (currently: flex-child strip append, `buildBodyInto`, `PADDING_ROWS` loop) with — keep the existing why-comment about `buildBodyInto` appending directly onto rowWrap verbatim above the `buildBodyInto` call:

```ts
        // buildBodyInto appends the add-button + controls wrap directly onto rowWrap, so the
        // section body stays a single flat .panel-rows (CSS contract) with no carrier to drain.
        this.layoutSection.buildBodyInto(rowWrap)

        // Padding block (2026-07-06 layout-polish spec): a "Padding" group label above ONE
        // line holding the H (left/right) and V (top/bottom) fields side by side — Margin's
        // H|V shorthand explained by its section title; padding's is explained here.
        const padBlock = document.createElement('div')
        padBlock.className = 'padding-block'
        padBlock.setAttribute('data-padding-row', '')
        const padLabel = document.createElement('span')
        padLabel.className = 'group-label'
        padLabel.textContent = 'Padding'
        const padFields = document.createElement('div')
        padFields.className = 'padding-fields'
        for (const row of PADDING_ROWS) padFields.append(this.buildRow(row))
        padBlock.append(padLabel, padFields)
        rowWrap.append(padBlock)

        // Align block LAST (2026-07-06 layout-polish spec): the per-child override is the
        // exception, not the default surface — designers think container-first (9-dot matrix
        // on the parent), so align-self sits at the bottom, behind Task 3's toggle.
        rowWrap.append(this.layoutSection.buildFlexChildControls())
```

Also update the order note comment at the top of the branch (lines ~498–500) to say `W/H rows -> auto-layout cluster -> padding block -> align block`, and the matching comment in `panel-specs.ts` SECTIONS (~line 228).

- [ ] **Step 4: Add the align header in panel-layout.ts**

In `LayoutSection`, add a widget ref beside `alignSelfField` (~line 65):

```ts
  private alignToggle: HTMLButtonElement | null = null
```

Replace `buildFlexChildControls` (lines 229–252) with — SegmentField options and onInput are UNCHANGED, copy them verbatim; the label moves out of the SegmentField into the header so the toggle can sit beside it:

```ts
  /** The flex-child align block (2026-07-06 layout-polish spec): "Align" group label + the
   * disclosure toggle, then the align-self segment strip. Off = follow the parent's 9-dot
   * alignment; the toggle's behavior lands in onAlignToggle (Task 3). */
  buildFlexChildControls(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'flex-child-controls'
    this.flexChildControlsWrap = wrap

    const head = document.createElement('div')
    head.className = 'align-head'
    const label = document.createElement('span')
    label.className = 'group-label'
    label.textContent = 'Align'
    const toggle = createButton({ label: '' })
    toggle.classList.add('align-toggle')
    toggle.setAttribute('data-align-toggle', '')
    toggle.setAttribute('aria-label', 'Align independently of parent')
    toggle.title = "align-self — override the parent container's alignment for this element"
    this.alignToggle = toggle
    head.append(label, toggle)
    wrap.append(head)

    this.alignSelfField = new SegmentField({
      label: '',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'flex-start', label: 'Start', title: 'align-self: flex-start → self-start' },
        { value: 'center', label: 'Center', title: 'align-self: center → self-center' },
        { value: 'flex-end', label: 'End', title: 'align-self: flex-end → self-end' },
        { value: 'stretch', label: 'Stretch' },
      ],
      onInput: (value) => {
        this.withEdit((el) => {
          this.deps.drafts.apply(el, 'align-self', value)
        })
      },
    })
    this.alignSelfField.root.setAttribute('data-align-self', '')
    this.alignSelfWrap = this.alignSelfField.root
    wrap.append(this.alignSelfField.root)
    return wrap
  }
```

Add `this.alignToggle = null` to `teardown()`.

- [ ] **Step 5: Run to verify pass**

Run: `cd packages/the-forge && npx vitest run tests/client/panel.test.ts tests/client/design-mode.test.ts`
Expected: PASS. (The old `'flex-child controls appear when parent is flex'` test at ~line 634 still passes — the strip is still always-shown until Task 3.)

- [ ] **Step 6: Commit**

```bash
git add packages/the-forge/src/client/panel.ts packages/the-forge/src/client/panel-layout.ts packages/the-forge/src/client/panel-specs.ts packages/the-forge/tests/client/panel.test.ts
git commit -m "feat(client): layout body recomposition — labeled one-line padding block, align block at the bottom"
```

---

### Task 3: Align toggle behavior (off by default, auto-on, discard-vs-auto on off)

**Files:**
- Modify: `packages/the-forge/src/client/panel-layout.ts`
- Test: `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Consumes: `alignSelfRowOn` (Task 1), Task 2's DOM (`[data-align-toggle]`, `[data-align-self]`).
- Produces: `LayoutSection.onAlignToggle(): void` (private, wired to the toggle's click); `refreshFlexChild` drives `aria-pressed` + strip visibility. Toggle state readable in tests via `[data-align-toggle]`'s `aria-pressed`.

- [ ] **Step 1: Write the failing tests**

In `tests/client/panel.test.ts`, REPLACE the two existing strip tests (`'flex-child controls appear when parent is flex'` ~line 634 and `'align-self segment field drafts align-self'` ~line 643) with the suite below (childSetup already exists at ~line 621; note its `#t` has no align-self):

```ts
  it('align strip is OFF by default when parent is flex and align-self is default', () => {
    const { panel } = childSetup()
    const toggle = panel.root.querySelector('[data-align-toggle]') as HTMLElement
    const strip = panel.root.querySelector('[data-align-self]') as HTMLElement
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(strip.hidden).toBe(true)
    // size-mode selects still shown for flex children — the toggle gates only the strip
    const modes = [...panel.root.querySelectorAll('.size-row .size-mode')] as HTMLElement[]
    expect(modes.every((m) => !m.hidden)).toBe(true)
  })

  it('toggling ON reveals the strip without drafting anything', () => {
    const { el, panel, drafts } = childSetup()
    ;(panel.root.querySelector('[data-align-toggle]') as HTMLElement).click()
    const strip = panel.root.querySelector('[data-align-self]') as HTMLElement
    expect(strip.hidden).toBe(false)
    expect(drafts.current(el, 'align-self')).toBeNull()
    // nothing to send: opening the row is not an edit (same contract as opening a min/max row)
    expect(buildChangeRequest(drafts).elements.find((e) => e.selector === '#t')).toBeUndefined()
  })

  it('picking a segment after toggling ON drafts align-self', () => {
    const { el, panel, drafts } = childSetup()
    ;(panel.root.querySelector('[data-align-toggle]') as HTMLElement).click()
    const seg = panel.root.querySelector('[data-align-self]')!
    const startBtn = [...seg.querySelectorAll('.seg')].find((b) => b.textContent === 'Start') as HTMLElement
    startBtn.click()
    expect(drafts.current(el, 'align-self')).toBe('flex-start')
    expect((panel.root.querySelector('[data-align-toggle]') as HTMLElement).getAttribute('aria-pressed')).toBe('true')
  })

  it('toggling OFF discards a session draft (pure undo, Baseline semantics)', () => {
    const { el, panel, drafts } = childSetup()
    const toggle = panel.root.querySelector('[data-align-toggle]') as HTMLElement
    toggle.click()
    const seg = panel.root.querySelector('[data-align-self]')!
    ;([...seg.querySelectorAll('.seg')].find((b) => b.textContent === 'Center') as HTMLElement).click()
    expect(drafts.current(el, 'align-self')).toBe('center')
    toggle.click()
    expect(drafts.current(el, 'align-self')).toBeNull()
    expect((panel.root.querySelector('[data-align-self]') as HTMLElement).hidden).toBe(true)
  })

  it('auto-ON when the app CSS sets align-self; toggling OFF drafts align-self: auto', () => {
    document.body.innerHTML = `<div id="parent" style="display: flex; flex-direction: row;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="align-self: center; width: 50px;"></div>
    </div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))
    const toggle = panel.root.querySelector('[data-align-toggle]') as HTMLElement
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect((panel.root.querySelector('[data-align-self]') as HTMLElement).hidden).toBe(false)
    toggle.click()
    expect(drafts.current(el, 'align-self')).toBe('auto')
  })

  it('cross-axis Fill turns the align toggle ON (stretch is real, never masked)', () => {
    const { panel } = childSetup()
    const hRow = fieldInput(panel, P.H).closest('.nf')!.parentElement!
    const select = hRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect((panel.root.querySelector('[data-align-toggle]') as HTMLElement).getAttribute('aria-pressed')).toBe('true')
    expect((panel.root.querySelector('[data-align-self]') as HTMLElement).hidden).toBe(false)
  })

  it('manual-open latch clears on selection change', () => {
    const { panel } = childSetup()
    ;(panel.root.querySelector('[data-align-toggle]') as HTMLElement).click()
    expect((panel.root.querySelector('[data-align-self]') as HTMLElement).hidden).toBe(false)
    // reselect the same element: buildBody rebuilds, latch must not survive
    const el = document.getElementById('t')! as HTMLElement
    panel.show(el, buildInspectorData(el))
    expect((panel.root.querySelector('[data-align-self]') as HTMLElement).hidden).toBe(true)
  })
```

Note: the test `'align-self segment field drafts align-self'` is superseded by `'picking a segment after toggling ON…'`. The existing `'flex-child controls are hidden when parent is not flex'` (~line 610) and `'cross-axis Fixed preserves a user-drafted align-self…'` (~line 719) tests stay AS IS — they must keep passing.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/the-forge && npx vitest run tests/client/panel.test.ts`
Expected: FAIL — no toggle behavior; strip visible whenever parent is flex.

- [ ] **Step 3: Implement in panel-layout.ts**

Import the predicate (extend the existing `./panel-readers` import at line 17):

```ts
import { fromPx, isFlex, normalizeJustify, normalizeAlign, mainAxisProp, minMaxRowVisible, alignSelfRowOn } from './panel-readers'
```

Add state beside `openedMinMax` (~line 75), with the lifecycle note:

```ts
  // Align-self disclosure latch — same per-selection lifecycle as openedMinMax (cleared in
  // teardown): toggling ON without a draft latches the row open; the ON state itself is the
  // canonical alignSelfRowOn predicate (opened ∪ live-draft ∪ non-default-computed).
  private alignOpened = false
```

Add the ON-state reader and the toggle handler (below `openMinMax`, ~line 283):

```ts
  private alignOn(el: TaggedElement, computed: CSSStyleDeclaration): boolean {
    const draft = this.deps.drafts.isComparing(el) ? null : this.deps.drafts.current(el, 'align-self')
    return alignSelfRowOn(computed.getPropertyValue('align-self'), draft !== null, this.alignOpened)
  }

  /** Align toggle. OFF→ON latches the row open and drafts nothing (openMinMax's non-withEdit
   * shape — there is nothing to send yet). ON→OFF composes both undo stories in one click:
   * discard any session draft, and if the stylesheet STILL asserts a non-default align-self
   * after the discard, draft `auto` so the change request says "follow the parent" — without
   * the second half, an app-CSS value would auto-reveal the row right back ON. */
  private onAlignToggle(): void {
    const el = this.deps.getEl()
    if (!el) return
    if (!this.alignOn(el, getComputedStyle(el))) {
      this.alignOpened = true
      this.deps.refresh()
      return
    }
    this.alignOpened = false
    this.withEdit((elm) => {
      if (this.deps.drafts.current(elm, 'align-self') !== null) {
        this.deps.drafts.discard(elm, ['align-self'])
      }
      const css = getComputedStyle(elm).getPropertyValue('align-self')
      if (!['', 'auto', 'normal'].includes(css)) {
        this.deps.drafts.apply(elm, 'align-self', 'auto')
      }
    })
  }
```

Wire the click in `buildFlexChildControls` (Task 2 left the toggle inert) — after `this.alignToggle = toggle`:

```ts
    toggle.addEventListener('click', () => this.onAlignToggle())
```

Update `refreshFlexChild` (lines 369–387): keep the parent-flex gate and size-mode lines untouched, then replace the two align lines with:

```ts
    const alignSelf = this.deps.currentValue(el, 'align-self', computed)
    const on = this.alignOn(el, computed)
    this.alignToggle?.setAttribute('aria-pressed', String(on))
    if (this.alignSelfWrap) this.alignSelfWrap.hidden = !on
    if (on) this.alignSelfField?.set(alignSelf || 'auto')
```

The strip must be born hidden (off is the default state, and the pre-existing test `'flex-child controls are hidden when parent is not flex'` asserts `[data-align-self]` is hidden before any refresh reaches it). In `buildFlexChildControls`, right after `this.alignSelfField.root.setAttribute('data-align-self', '')`, add:

```ts
    this.alignSelfField.root.hidden = true
```

Do NOT add per-widget hiding to `refreshFlexChild`'s `!visible` early-return path — the existing `flexChildControlsWrap.hidden = !visible` already hides the whole align block when the parent isn't flex.

Add to `teardown()`:

```ts
    this.alignOpened = false
```

In `refresh`'s multi branch (~line 298), no change — `flexChildControlsWrap.hidden = true` already hides the whole align block.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/the-forge && npx vitest run tests/client/panel.test.ts tests/client/design-mode.test.ts tests/client/request.test.ts`
Expected: PASS, including the untouched `'cross-axis Fixed preserves a user-drafted align-self…'` and multi-select suites.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/panel-layout.ts packages/the-forge/tests/client/panel.test.ts
git commit -m "feat(client): align-self disclosure toggle — off by default, auto-on, discard-vs-auto on off"
```

---

### Task 4: CSS — wide-panel fix, group labels, padding line, toggle switch; story

jsdom cannot verify any of this — Task 5's real-browser pass is the gate. This task only needs the existing suites to stay green (overlay.test.ts parses the style string).

**Files:**
- Modify: `packages/the-forge/src/client/overlay.ts`
- Modify: `packages/the-forge/stories/button.stories.ts`

**Interfaces:**
- Consumes: Task 2/3 DOM (`.group-label`, `.padding-block`, `.padding-fields`, `.align-head`, `.align-toggle`).

- [ ] **Step 1: Root-cause fix + new rules in overlay.ts**

At the `.layout-section, .flex-child-controls` rule (~line 314), add the stretch override with its why-comment:

```css
.layout-section, .flex-child-controls { display: flex; flex-direction: column; gap: 6px; width: 100%; align-items: stretch; }
/* ^ align-items: stretch overrides .panel-rows's align-items: center, which in THIS column
 * context means horizontal centering — every non-full-width child floated toward the middle,
 * invisible at the 280px default and a mess at 700px (2026-07-06 layout-polish spec). */
/* Nested .panel-rows (the min/max disclosure rows) inherit the outer 12px gutter from
 * .layout-section's own .panel-rows padding — zero theirs or the rows double-indent. */
.layout-section .panel-rows { padding: 0; }
```

Add the new blocks after the `.size-row` rules (~line 302):

```css
.group-label { color: var(--text-muted); font-size: 11px; }
.padding-block { display: flex; flex-direction: column; gap: 4px; }
.padding-fields { display: flex; gap: 6px; }
.align-head { display: flex; align-items: center; justify-content: space-between; }
/* Align toggle — a small switch (pill + knob); aria-pressed drives the on state. */
.align-toggle {
  width: 26px; height: 14px; border-radius: 999px; background: var(--control);
  position: relative; padding: 0; flex: none;
}
.align-toggle::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px;
  border-radius: 50%; background: var(--text-faint); transition: left 0.12s;
}
.align-toggle[aria-pressed="true"] { background: var(--accent); }
.align-toggle[aria-pressed="true"]::after { left: 14px; background: #fff; }
/* The align strip's SegmentField now gets its label from .align-head — collapse the empty span. */
[data-align-self] .seg-field-label:empty { display: none; }
```

Keep the existing `[data-align-self]` stacked-label rules (~lines 237–239) — harmless with an empty label and still a test hook.

- [ ] **Step 2: Story for the switch**

In `stories/button.stories.ts`, add a story rendering the real control through the shared shadow-mount helper (`mountInShadow` from `stories/mount.ts` — it injects the product's real `CSS` const; follow the file's existing story export shape for meta/typing):

```ts
export const AlignToggle = () => {
  const off = createButton({ label: '' })
  off.classList.add('align-toggle')
  off.setAttribute('aria-pressed', 'false')
  const on = createButton({ label: '' })
  on.classList.add('align-toggle')
  on.setAttribute('aria-pressed', 'true')
  return mountInShadow([off, on], 'panel')
}
```

The deliverable is the two switch states side by side, rendered by the same CSS the shipped overlay uses.

- [ ] **Step 3: Run gates**

Run: `cd packages/the-forge && npx vitest run tests/client/overlay.test.ts tests/client/panel.test.ts && npm run typecheck -w the-forge` (from repo root for the workspace flag)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/the-forge/src/client/overlay.ts packages/the-forge/stories/button.stories.ts
git commit -m "feat(client): wide-panel stretch fix, padding/align group labels, align toggle switch CSS"
```

---

### Task 5: Real-browser E2E verification

No new code — this is the acceptance gate jsdom can't provide. Fix-forward anything it catches (small CSS adjustments belong to this task; behavior bugs reopen Task 3).

**Files:**
- None (verification; screenshots to the session scratchpad)

- [ ] **Step 1: Build + restart the demo server**

```bash
npm run build && (lsof -tiTCP:5173 | xargs kill; sleep 1; npm run dev -w demo-app &)
```

(A running dev server keeps serving the OLD client bundle after a rebuild — the restart is mandatory, a browser reload is not enough.)

- [ ] **Step 2: Drive the demo app in a real browser (playwright MCP)**

At `http://localhost:5173`: toggle Design mode on, select the Vitality card (`[data-dc-source="src/App.tsx:5:9"]`).

Verify, at each of the three widths (set `--forge-dock-w` on the shadow host to `280px`, `450px`, `700px`; screenshot each):
1. No horizontal centering drift: W/H rows, Direction track, matrix tile, padding line, and align row all left-anchor; inputs/tracks stretch; matrix tile stays 88px.
2. Padding renders as: "Padding" label, then H and V side by side on ONE line.
3. Min/max disclosure rows sit flush with the other rows (no double indent).
4. Align row at the BOTTOM of the Layout section: "Align" label left, switch right, no strip visible by default.
5. Toggle the switch ON → strip appears; pick "Start" → card top-aligns in its row (live inline-style preview); switch shows on-state.
6. Toggle OFF → draft discarded, card returns to stylesheet reality, strip hides.
7. Set H size-mode to "Fill" → switch auto-ONs showing Stretch.
8. Select the outer flex container (`src/App.tsx:4:7`) → cluster renders; no align row visible (its parent isn't flex). Quick width-extremes sanity pass over Margin/Fill/Stroke/Appearance too.
9. Standard loop still works: edit → "Send to agent" writes a pending item to `.the-forge/queue.json` at the git root.

- [ ] **Step 3: Record the result**

Note pass/fail per item in the PR description (screenshots attached from the scratchpad). Any CSS fix found here amends Task 4's commit style: `fix(client): <what> (E2E finding)`.

---

### Task 6: Docs, gates, budget

**Files:**
- Modify: `docs/research/2026-07-04-panel-patterns.md`
- Modify: `docs/specs/2026-07-05-designer-forward-panel-design.md`

- [ ] **Step 1: Record the ratified amendment in panel-patterns**

Append to `docs/research/2026-07-04-panel-patterns.md`:

```markdown
## Amendment — 2026-07-06 (user-ratified in the layout-polish brainstorm)

- **align-self is disclosure, not default surface.** The flex-child Align strip moved to the
  BOTTOM of the Layout section behind an off-by-default toggle: designers think
  container-first (9-dot matrix on the parent); Figma has no per-child start/center/end
  override at all. Auto-on when a draft, the app's CSS, or cross-axis Fill already sets
  align-self — an off toggle never masks reality. Spec:
  [2026-07-06-layout-align-disclosure-design.md](../specs/2026-07-06-layout-align-disclosure-design.md).
- **Within-Layout order re-ratified:** W/H (+min/max) → auto-layout cluster → Padding
  (group label + one H|V line) → Align. Supersedes M-C's W/H → flex-child strip → cluster →
  padding order.
```

- [ ] **Step 2: Pointer in the M-C spec**

In `docs/specs/2026-07-05-designer-forward-panel-design.md`, find the flex-child strip / Layout-order passage (grep `flex-child strip`) and add one line beneath it:

```markdown
> Amended 2026-07-06: the flex-child Align strip moved to the bottom of the Layout section
> behind an off-by-default disclosure toggle, and padding gained a group label + one-line H|V
> row — see [2026-07-06-layout-align-disclosure-design.md](2026-07-06-layout-align-disclosure-design.md).
```

- [ ] **Step 3: Full gates**

```bash
npm test                        # root gate: typecheck + full vitest suite
./scripts/check-prod-clean.sh   # prod cleanliness + 250KB budget (was 247KB — verify headroom)
```

Expected: both PASS. If the budget trips, the CSS additions are the first place to trim (the switch/label rules are the only growth).

- [ ] **Step 4: Commit**

```bash
git add docs/research/2026-07-04-panel-patterns.md docs/specs/2026-07-05-designer-forward-panel-design.md
git commit -m "docs: record align-self disclosure + layout order amendment (2026-07-06 spec)"
```

---

## Self-review notes

- Spec coverage: align row semantics → Tasks 1–3; padding block → Task 2 (+CSS Task 4); wide-panel fix → Task 4 (+gate Task 5); tests → Tasks 1–3; non-goals need no tasks; gates/docs → Task 6.
- The `'flex-child controls are hidden when parent is not flex'` and `'cross-axis Fixed preserves a user-drafted align-self'` tests are deliberately untouched across tasks — they pin behavior that must survive.
- Type consistency: `alignSelfRowOn(computed, hasDraft, opened)` used identically in Tasks 1 and 3; `onAlignToggle` is private (wired in Task 2's DOM via Task 3's listener).
