# Size Pair + Sizing Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** W and H side by side under a "Size" group label, the Fixed/Hug/Fill modes + min/max + variable binding consolidated behind a chevron popover menu on each field, and a Hug/Fill whisper label shown with the real measured number.

**Architecture:** A new `ui/menu.ts` popover factory replaces the native size-mode `<select>`; `panel.ts`'s layout branch wraps the W/H rows in a `size-block` mirroring the padding block; `panel-layout.ts`'s `BoundSizeMode` registry swaps `select` for `menuBtn + mode`, and its `updateSizeMode` read half gains the auto-is-not-Fixed fix plus whisper/number display. `NumberField` grows `setWhisper` and a token-button suppression option.

**Tech Stack:** TypeScript, vitest + jsdom, Storybook, zero runtime deps. Spec: `docs/specs/2026-07-06-size-pair-sizing-menu-design.md`.

## Global Constraints

- Zero new runtime dependencies; zero idle overhead (menu document listeners attach on open, detach on close).
- Bundle budget: `./scripts/check-prod-clean.sh` enforces 250KB unpacked; client is at ~244KB — run the budget check at the Task 1 and Task 7 checkpoints.
- Overlay CSS class names are test hooks — extend, never rename (`.size-row`, `data-minmax-row`, `data-props-row` survive).
- CSS-string comments in `overlay.ts` are bundle bytes (guard-tested): why-comments go BETWEEN template-literal segments, never inside them.
- `#panel .panel-rows` has (1,0,1) specificity — any nested-row CSS that must override it needs the `#panel` prefix (see the existing `#panel .layout-section .panel-rows` comment).
- New buttons go through `src/client/ui/` factories; buttons internal to a composite control (menu items) stay local by design (see `ui/button.ts` header comment).
- Preserve all existing why-comments verbatim when moving code.
- Run all tests from `packages/the-forge/` (`npx vitest run tests/client/<file>.test.ts`); root `npm test` is the merge gate.

---

### Task 1: `ui/menu.ts` popover factory + CSS + story

**Files:**
- Create: `packages/the-forge/src/client/ui/menu.ts`
- Modify: `packages/the-forge/src/client/overlay.ts` (append CSS segments near `.size-mode` / popover styles)
- Create: `packages/the-forge/stories/menu.stories.ts`
- Test: `packages/the-forge/tests/client/ui.test.ts` (extend — it already covers `ui/`)

**Interfaces:**
- Consumes: `createButton` from `./button`.
- Produces (Tasks 4–6 rely on these exact names):

```ts
export interface MenuItem {
  value: string
  label: string
  /** Renders a trailing ✓ — the currently-applied mode. */
  checked?: boolean
  /** Renders a divider line above this item. */
  separator?: boolean
}
export interface MenuButtonOpts {
  title?: string
  /** Computed fresh on every open — checkmarks and gated items are dynamic. */
  items: () => MenuItem[]
  onSelect: (value: string) => void
  /** Positioned ancestor the popover appends to — the panel body (`.panel-body`,
   * position: relative), the same host Panel hands to TokenPicker/ColorPicker. */
  popoverHost: HTMLElement
}
export interface MenuButton {
  button: HTMLButtonElement // the '▾' chevron, class 'menu-btn'
  close: () => void
}
export function createMenuButton(opts: MenuButtonOpts): MenuButton
```

- [ ] **Step 1: Write the failing tests** — append a `describe('createMenuButton', ...)` block to `tests/client/ui.test.ts`:

```ts
import { createMenuButton } from '../../src/client/ui/menu'

describe('createMenuButton', () => {
  function setup(items = () => [
    { value: 'fixed', label: 'Fixed', checked: true },
    { value: 'hug', label: 'Hug' },
    { value: 'add-min', label: 'Min…', separator: true },
  ]) {
    document.body.innerHTML = '<div id="host" style="position: relative"></div>'
    const host = document.getElementById('host')!
    const onSelect = vi.fn()
    const mb = createMenuButton({ title: 'Sizing', items, onSelect, popoverHost: host })
    host.append(mb.button)
    return { host, onSelect, mb }
  }

  it('renders a menu-btn chevron and no popover until clicked', () => {
    const { host, mb } = setup()
    expect(mb.button.className).toContain('menu-btn')
    expect(mb.button.title).toBe('Sizing')
    expect(host.querySelector('.menu-popover')).toBeNull()
  })

  it('click opens a popover with items, checkmark, and separator', () => {
    const { host, mb } = setup()
    mb.button.click()
    const pop = host.querySelector('.menu-popover') as HTMLElement
    expect(pop).toBeTruthy()
    const labels = [...pop.querySelectorAll('.menu-item')].map((b) => (b as HTMLElement).textContent)
    expect(labels[0]).toContain('Fixed')
    expect(labels[0]).toContain('✓') // checked item carries the mark
    expect(labels[1]).toContain('Hug')
    expect(pop.querySelector('.menu-sep')).toBeTruthy() // separator before Min…
  })

  it('item click fires onSelect with the value and closes', () => {
    const { host, onSelect, mb } = setup()
    mb.button.click()
    const items = [...host.querySelectorAll('.menu-item')] as HTMLElement[]
    items[1].click()
    expect(onSelect).toHaveBeenCalledWith('hug')
    expect(host.querySelector('.menu-popover')).toBeNull()
  })

  it('outside mousedown and Escape both close without selecting', () => {
    const { host, onSelect, mb } = setup()
    mb.button.click()
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(host.querySelector('.menu-popover')).toBeNull()

    mb.button.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(host.querySelector('.menu-popover')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('items() is re-invoked on every open (dynamic checkmarks)', () => {
    let mode = 'fixed'
    const { host, mb } = setup(() => [
      { value: 'fixed', label: 'Fixed', checked: mode === 'fixed' },
      { value: 'hug', label: 'Hug', checked: mode === 'hug' },
    ])
    mb.button.click()
    mb.close()
    mode = 'hug'
    mb.button.click()
    const labels = [...host.querySelectorAll('.menu-item')].map((b) => (b as HTMLElement).textContent)
    expect(labels[1]).toContain('✓')
    expect(labels[0]).not.toContain('✓')
  })

  it('reopening the same button while open just closes (toggle)', () => {
    const { host, mb } = setup()
    mb.button.click()
    mb.button.click()
    expect(host.querySelector('.menu-popover')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/client/ui.test.ts` from `packages/the-forge/`. Expected: FAIL, cannot resolve `../../src/client/ui/menu`.

- [ ] **Step 3: Implement `src/client/ui/menu.ts`:**

```ts
import { createButton } from './button'

export interface MenuItem {
  value: string
  label: string
  /** Renders a trailing ✓ — the currently-applied mode. */
  checked?: boolean
  /** Renders a divider line above this item. */
  separator?: boolean
}

export interface MenuButtonOpts {
  title?: string
  /** Computed fresh on every open — checkmarks and gated items are dynamic. */
  items: () => MenuItem[]
  onSelect: (value: string) => void
  /** Positioned ancestor the popover appends to — the panel body, same host as TokenPicker. */
  popoverHost: HTMLElement
}

export interface MenuButton {
  button: HTMLButtonElement
  close: () => void
}

const MENU_WIDTH = 120

/**
 * The '▾' chevron + popover menu — born here so every dropdown-menu affordance shares one
 * open/close contract (outside-mousedown + Escape, document listeners attached only while
 * open — zero idle overhead). The popover is rebuilt from opts.items() on every open so
 * checkmarks and context-gated items can't go stale.
 */
export function createMenuButton(opts: MenuButtonOpts): MenuButton {
  const button = createButton({ label: '▾', title: opts.title, className: 'menu-btn' })
  button.type = 'button'
  let popover: HTMLElement | null = null

  const close = (): void => {
    if (!popover) return
    popover.remove()
    popover = null
    document.removeEventListener('mousedown', onDocDown, true)
    document.removeEventListener('keydown', onDocKey, true)
  }

  // Shadow DOM retargets e.target to the host — composedPath()[0] sees the real node
  // (same convention as TokenPicker's outside-click handler).
  const onDocDown = (e: MouseEvent): void => {
    const target = (e.composedPath?.()[0] ?? e.target) as Node
    if (popover?.contains(target) || button.contains(target)) return
    close()
  }
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }

  const open = (): void => {
    popover = document.createElement('div')
    popover.className = 'menu-popover'
    for (const item of opts.items()) {
      if (item.separator) {
        const sep = document.createElement('div')
        sep.className = 'menu-sep'
        popover.append(sep)
      }
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'menu-item'
      btn.textContent = item.label
      if (item.checked) {
        const check = document.createElement('span')
        check.className = 'menu-check'
        check.textContent = '✓'
        btn.append(check)
      }
      btn.addEventListener('click', () => {
        close()
        opts.onSelect(item.value)
      })
      popover.append(btn)
    }
    // offsetTop/offsetLeft resolve against the popoverHost (the nearest positioned
    // ancestor) — nothing between the button and the host is positioned, by contract.
    popover.style.top = `${button.offsetTop + button.offsetHeight + 2}px`
    popover.style.left = `${Math.max(0, Math.min(button.offsetLeft, opts.popoverHost.clientWidth - MENU_WIDTH))}px`
    opts.popoverHost.append(popover)
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onDocKey, true)
  }

  button.addEventListener('click', () => {
    if (popover) close()
    else open()
  })

  return { button, close }
}
```

- [ ] **Step 4: Add CSS to `overlay.ts`** — append new segments right after the `.size-mode` block (line ~340), why-comments BETWEEN segments:

```ts
`.menu-btn {
  width: 16px; align-self: stretch; padding: 0; border: none; background: none; flex: none;
  color: var(--text-muted); font-size: 9px; cursor: pointer; border-radius: 4px;
}
.menu-btn:hover { color: var(--text); background: rgba(255,255,255,0.08); }`,
// The menu popover appends to .panel-body (position: relative) — same host and z plane
// as .token-popover, so it scrolls with the rows and never clips at the panel edge.
`.menu-popover {
  position: absolute; z-index: 20; min-width: 120px; padding: 4px;
  background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 6px;
  box-shadow: 0 5px 24px rgba(0,0,0,0.4); display: flex; flex-direction: column;
}
.menu-item {
  display: flex; align-items: center; gap: 6px; padding: 4px 8px; border: none;
  background: none; color: var(--text); font-size: 11px; text-align: left;
  cursor: pointer; border-radius: 4px;
}
.menu-item:hover { background: rgba(255,255,255,0.08); }
.menu-check { margin-left: auto; color: var(--accent); }
.menu-sep { height: 1px; background: var(--border-strong); margin: 3px 0; }`,
```

Match the surrounding file's exact segment/comma structure and copy `z-index`/`box-shadow` values from the existing `.token-popover` segment if they differ from the above.

- [ ] **Step 5: Run tests** — `npx vitest run tests/client/ui.test.ts` and `npx vitest run tests/client/overlay.test.ts` (the no-comment-prose CSS guard). Expected: PASS.

- [ ] **Step 6: Story** — create `stories/menu.stories.ts` mirroring `select.stories.ts`'s structure (default export with `title: 'UI/Menu'`, use `stories/mount.ts` helpers the other stories use). One story rendering the real control pre-opened with the sizing item set:

```ts
// Sample items mirror the real sizing menu: modes with a checkmark, separated actions.
const items = () => [
  { value: 'fixed', label: 'Fixed', checked: true },
  { value: 'hug', label: 'Hug' },
  { value: 'fill', label: 'Fill' },
  { value: 'add-min', label: 'Min…', separator: true },
  { value: 'add-max', label: 'Max…' },
  { value: 'variable', label: 'Variable…', separator: true },
]
```

Read `stories/select.stories.ts` and `stories/mount.ts` first and copy their mount pattern exactly.

- [ ] **Step 7: Budget checkpoint** — `npm run build` at repo root, then `./scripts/check-prod-clean.sh`. Expected: all gates pass, size within 250KB. If over: the menu CSS/factory must shrink (shorten class bodies), not the budget.

- [ ] **Step 8: Commit**

```bash
git add packages/the-forge/src/client/ui/menu.ts packages/the-forge/src/client/overlay.ts packages/the-forge/stories/menu.stories.ts packages/the-forge/tests/client/ui.test.ts
git commit -m "feat(client): ui/menu.ts chevron popover factory (checkmarks, separators, dynamic items)"
```

---

### Task 2: `NumberField.setWhisper` + token-button suppression

**Files:**
- Modify: `packages/the-forge/src/client/controls.ts`
- Modify: `packages/the-forge/src/client/overlay.ts` (one `.nf-whisper` segment)
- Test: `packages/the-forge/tests/client/controls.test.ts`

**Interfaces:**
- Produces (Tasks 4/6 rely on these exact names on `NumberField`):
  - `setWhisper(text: string | null): void` — dim right-side label inside the field; `null` hides it. `set()`, `setMixed()`, `setAuto()`, and `bindToken()` all clear it (whisper is re-asserted by each refresh, so it can never go stale across selection/mode changes).
  - `canOpenToken(): boolean` — whether `onTokenOpen` was wired.
  - `openToken(): void` — fires `onTokenOpen` (the menu's `Variable…` path).
  - New opt `noTokenButton?: boolean` — suppress the hover `{ }` button while keeping `onTokenOpen` reachable via `=` and `openToken()`.

- [ ] **Step 1: Write the failing tests** (append to `controls.test.ts`, matching its existing NumberField setup style):

```ts
it('setWhisper shows a dim label; null hides it', () => {
  const f = new NumberField({ label: 'W', onInput: () => {} })
  f.setWhisper('Hug')
  const w = f.root.querySelector('.nf-whisper') as HTMLElement
  expect(w.hidden).toBe(false)
  expect(w.textContent).toBe('Hug')
  f.setWhisper(null)
  expect(w.hidden).toBe(true)
})

it('set/setMixed/setAuto/bindToken each clear an active whisper', () => {
  const f = new NumberField({ label: 'W', onInput: () => {}, allowAuto: true })
  const w = () => (f.root.querySelector('.nf-whisper') as HTMLElement).hidden
  for (const clear of [() => f.set(4), () => f.setMixed(), () => f.setAuto(), () => f.bindToken('w-4')]) {
    f.setWhisper('Fill')
    expect(w()).toBe(false)
    clear()
    expect(w()).toBe(true)
  }
})

it('noTokenButton suppresses the { } button but openToken/= still fire onTokenOpen', () => {
  const onTokenOpen = vi.fn()
  const f = new NumberField({ label: 'W', onInput: () => {}, onTokenOpen, noTokenButton: true })
  expect(f.root.querySelector('.token-btn')).toBeNull()
  expect(f.canOpenToken()).toBe(true)
  f.openToken()
  expect(onTokenOpen).toHaveBeenCalledTimes(1)
})

it('canOpenToken is false when onTokenOpen is not wired', () => {
  const f = new NumberField({ label: 'W', onInput: () => {} })
  expect(f.canOpenToken()).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/client/controls.test.ts`. Expected: FAIL (`setWhisper` not a function).

- [ ] **Step 3: Implement in `controls.ts`:**
  - Add `noTokenButton?: boolean` to `NumberFieldOpts` with the doc comment from Interfaces above.
  - Add field `private whisperEl = document.createElement('span')`.
  - In the constructor, after `this.root.append(this.labelEl, this.input)`:

```ts
this.whisperEl.className = 'nf-whisper'
this.whisperEl.hidden = true
this.root.append(this.whisperEl)
```

  - Change the token-button condition to `if (opts.onTokenOpen && !opts.noTokenButton) {`.
  - Add the three methods:

```ts
/** Dim right-side context label (e.g. the applied Hug/Fill size mode). Any display
 * mutation (set/setMixed/setAuto/bindToken) clears it — the refresh that changed the
 * display is responsible for re-asserting it, so a whisper can never outlive its mode. */
setWhisper(text: string | null): void {
  this.whisperEl.textContent = text ?? ''
  this.whisperEl.hidden = text === null
}

/** Whether onTokenOpen was wired (menu callers gate their Variable… item on this). */
canOpenToken(): boolean {
  return !!this.opts.onTokenOpen
}

/** External trigger for the token picker — the sizing menu's Variable… item. */
openToken(): void {
  this.opts.onTokenOpen?.()
}
```

  - Add `this.setWhisper(null)` as the first line of `set()`, `setMixed()`, `setAuto()`, and `bindToken()`.

- [ ] **Step 4: Add CSS** — in `overlay.ts`, next to the existing `.nf` block:

```ts
`.nf-whisper { color: var(--text-muted); font-size: 10px; flex: none; padding-right: 4px; pointer-events: none; }`,
```

- [ ] **Step 5: Run tests** — `npx vitest run tests/client/controls.test.ts tests/client/overlay.test.ts`. Expected: PASS. Also run the full suite (`npm test` at root) — the whisper-clearing lines touch every field path.

- [ ] **Step 6: Commit**

```bash
git add packages/the-forge/src/client/controls.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/controls.test.ts
git commit -m "feat(client): NumberField whisper label + noTokenButton/openToken for menu-hosted variable binding"
```

---

### Task 3: Size block DOM — W|H side by side, min/max rows relocated + relabeled

The native select stays in place through this task; only the DOM composition changes.

**Files:**
- Modify: `packages/the-forge/src/client/panel-specs.ts` (`minMaxRowsFor` labels)
- Modify: `packages/the-forge/src/client/panel.ts` (buildBody layout branch, lines ~501–519)
- Modify: `packages/the-forge/src/client/overlay.ts` (`.size-block` / `.size-fields` segments)
- Test: `packages/the-forge/tests/client/panel.test.ts` (composition test ~line 293, new size-block test), `packages/the-forge/tests/client/panel-specs.test.ts` (if it asserts min/max labels)

**Interfaces:**
- Produces: `.size-block[data-size-block]` containing `.group-label` ("Size") + `.size-fields` (two `.size-row`s, W first); min/max rows unchanged in markup (`.panel-rows[data-minmax-row][data-props-row]`) but now AFTER the block, labels `Min W`, `Max W`, `Min H`, `Max H`.

- [ ] **Step 1: Amend the composition test** (panel.test.ts ~line 293) — add a `data-size-block` branch to the kinds mapper and change the expected order:

```ts
const kinds = [...body.children].map((c) =>
  c.hasAttribute('data-size-block')
    ? 'size'
    : c.hasAttribute('data-minmax-row')
      ? ((c as HTMLElement).dataset.propsRow?.startsWith('min') ? 'minmax-min' : 'minmax-max')
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
  'minmax-min',
  'minmax-max',
  'cluster',
  'cluster',
  'padding',
  'align',
])
```

Add a new test mirroring the padding-block test at ~line 326:

```ts
it('size block carries a group label and one line with W then H (2026-07-06 size-pair spec)', () => {
  const { panel } = setup()
  const block = panel.root.querySelector('[data-size-block]') as HTMLElement
  expect(block).toBeTruthy()
  expect((block.querySelector('.group-label') as HTMLElement).textContent).toBe('Size')
  const fields = [...block.querySelectorAll('.size-fields .nf')] as HTMLElement[]
  expect(fields.map((f) => f.dataset.props)).toEqual(['width', 'height'])
})

it('min/max rows carry axis-qualified labels below the size pair', () => {
  const { panel } = setup()
  const labels = [...panel.root.querySelectorAll('[data-minmax-row] .nf-label')].map((l) => l.textContent)
  expect(labels).toEqual(['Min W', 'Max W', 'Min H', 'Max H'])
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/client/panel.test.ts -t 'composes'` and the two new tests. Expected: FAIL (old interleaved order, bare Min/Max labels).

- [ ] **Step 3: Implement.** In `panel-specs.ts`, change `minMaxRowsFor` (keep its existing doc comment, append one sentence):

```ts
// ... existing comment ... Labels are axis-qualified (Min W / Max H) because the rows sit
// below the side-by-side W|H pair (2026-07-06 size-pair spec), no longer nested under their axis.
export function minMaxRowsFor(sizeSpec: RowSpec): RowSpec[] {
  const p = sizeSpec.props[0] // 'width' | 'height'
  return [
    { label: `Min ${sizeSpec.label}`, props: [`min-${p}`], min: 0, allowAuto: true, autoCss: 'auto' },
    { label: `Max ${sizeSpec.label}`, props: [`max-${p}`], min: 0, allowAuto: true, autoCss: 'none' },
  ]
}
```

In `panel.ts`'s layout branch, replace the current `for (const row of SIZE_ROWS) { ... }` loop (lines ~503–519) with:

```ts
// Size block (2026-07-06 size-pair spec): a "Size" group label above ONE line holding
// the W and H size-rows side by side — mirrors the padding block's structure below.
const sizeBlock = document.createElement('div')
sizeBlock.className = 'size-block'
sizeBlock.setAttribute('data-size-block', '')
const sizeLabel = document.createElement('span')
sizeLabel.className = 'group-label'
sizeLabel.textContent = 'Size'
const sizeFields = document.createElement('div')
sizeFields.className = 'size-fields'
for (const row of SIZE_ROWS) sizeFields.append(this.buildRow(row))
sizeBlock.append(sizeLabel, sizeFields)
rowWrap.append(sizeBlock)
// Min/max disclosure rows sit BELOW the pair (W's pair then H's) with axis-qualified
// labels — they can no longer nest under their own axis row now that W|H share a line.
// Hidden until LayoutSection.refresh discloses them (opened / drafted / non-default).
for (const row of SIZE_ROWS) {
  for (const mm of minMaxRowsFor(row)) {
    const mmBound = this.buildField(mm)
    const mmRow = document.createElement('div')
    mmRow.className = 'panel-rows'
    mmRow.setAttribute('data-minmax-row', '')
    mmRow.setAttribute('data-props-row', mm.props.join(' '))
    mmRow.hidden = true
    mmRow.append(mmBound.field.root)
    rowWrap.append(mmRow)
    this.layoutSection.registerMinMaxRow({ rowEl: mmRow, spec: mm, field: mmBound.field })
  }
}
```

In `overlay.ts`, next to `.padding-block`/`.padding-fields` (~line 320):

```ts
`.size-block { display: flex; flex-direction: column; gap: 4px; }
.size-fields { display: flex; gap: 6px; }`,
```

- [ ] **Step 4: Run the full panel suite** — `npx vitest run tests/client/panel.test.ts tests/client/panel-specs.test.ts`. Fix any other test that asserted the old interleaved order or bare `Min`/`Max` labels (grep the failures; the change is mechanical relabeling). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/panel.ts packages/the-forge/src/client/panel-specs.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/panel.test.ts packages/the-forge/tests/client/panel-specs.test.ts
git commit -m "feat(client): Size block — W|H side by side under a group label, min/max rows relocated with axis labels"
```

---

### Task 4: Menu swap — chevron replaces the size-mode select

**Files:**
- Modify: `packages/the-forge/src/client/panel.ts` (`buildRow`, ~line 992)
- Modify: `packages/the-forge/src/client/panel-layout.ts` (`BoundSizeMode`, `updateSizeMode` tail, `refresh` multi branch, `refreshFlexChild`, new `sizeMenuItems`)
- Modify: `packages/the-forge/stories/select.stories.ts` (retire the SIZE_MODES story)
- Test: `packages/the-forge/tests/client/panel.test.ts` (rewrite every `.size-mode`-driven site)

**Interfaces:**
- Consumes: `createMenuButton`/`MenuItem` (Task 1), `NumberField.canOpenToken()/openToken()` and `noTokenButton` (Task 2).
- Produces:
  - `BoundSizeMode` becomes `{ menuBtn: HTMLButtonElement; spec: RowSpec; field: NumberField; mode: 'fixed' | 'hug' | 'fill' }` (Task 5/6 read/write `sm.mode`).
  - `LayoutSection.sizeMenuItems(spec: RowSpec, hasVariable: boolean): MenuItem[]` — mode items (checkmark from `sm.mode`) only when the parent is flex; then `Min…` (`add-min`), `Max…` (`add-max`); `Variable…` (`variable`) only when `hasVariable`.
  - Test helpers `openSizeMenu(panel, props)` / `pickSizeMode(panel, props, label)` in panel.test.ts.

- [ ] **Step 1: Add the test helpers and rewrite one driving test first** (TDD the swap). Add next to `fieldInput`:

```ts
function openSizeMenu(panel: Panel, props: string): HTMLElement {
  const row = fieldInput(panel, props).closest('.size-row')!
  ;(row.querySelector('.menu-btn') as HTMLElement).click()
  return panel.root.querySelector('.menu-popover') as HTMLElement
}

function pickSizeMode(panel: Panel, props: string, label: string): void {
  const menu = openSizeMenu(panel, props)
  const item = [...menu.querySelectorAll('.menu-item')].find((b) => b.textContent?.startsWith(label)) as HTMLElement
  item.click()
}
```

Rewrite the Hug test (~line 770) to the menu path:

```ts
it('H sizing-menu Hug drafts height:auto', () => {
  const { el, panel, drafts } = childSetup()
  pickSizeMode(panel, P.H, 'Hug')
  expect(drafts.current(el, 'height')).toBe('auto')
})
```

Run `npx vitest run tests/client/panel.test.ts -t 'sizing-menu Hug'` — expected FAIL (no `.menu-btn`).

- [ ] **Step 2: Implement the swap.**

`panel.ts` `buildRow` — replace the `createSelect` block entirely:

```ts
private buildRow(spec: RowSpec): HTMLElement {
  const bound = this.buildField(spec)
  if (!spec.sizeMode) return bound.field.root

  const row = document.createElement('div')
  row.className = 'size-row'
  row.append(bound.field.root)

  // Figma UI3 keeps min/max in the sizing dropdown — action items, not modes. SIZE_MODES
  // itself stays a pure mode table (stories import it as the canonical catalog). The
  // variable binding also lives here (2026-07-06 size-pair spec) — W/H render no { } button.
  const menu = createMenuButton({
    title: 'Sizing — Fixed: exact px · Hug: fit-content · Fill: stretch / flex-1 · min/max · variable',
    popoverHost: this.body,
    items: () => this.layoutSection.sizeMenuItems(spec, bound.field.canOpenToken()),
    onSelect: (value) => {
      if (value === 'add-min' || value === 'add-max') {
        this.layoutSection.openMinMax(spec, value === 'add-min' ? 'min' : 'max')
        return
      }
      if (value === 'variable') {
        bound.field.openToken()
        return
      }
      this.layoutSection.onSizeModeChange(spec, value)
    },
  })
  row.append(menu.button)

  this.layoutSection.registerSizeMode({ menuBtn: menu.button, spec, field: bound.field, mode: 'fixed' })
  return row
}
```

Imports: add `createMenuButton` from `./ui/menu`; drop `createSelect` from this call site if now unused in panel.ts (it is still used by typography/stroke selects — check before removing the import). In `buildField`, add `noTokenButton: !!spec.sizeMode,` to the NumberField opts (keep `onTokenOpen` wiring untouched — `=` and `openToken()` still reach it).

`panel-layout.ts`:
- `BoundSizeMode` → `{ menuBtn: HTMLButtonElement; spec: RowSpec; field: NumberField; mode: 'fixed' | 'hug' | 'fill' }` (import `NumberField` type is already there).
- `updateSizeMode`: replace the three `sm.select.value = 'x'` writes with `sm.mode = 'x'`.
- `refresh` multi branch (~line 354): `sm.select.hidden = true` → `sm.menuBtn.hidden = true`.
- Single-select path: the chevron ALWAYS shows (its menu carries min/max/variable for every element) — in `refresh`, after the multi early-return, add:

```ts
// The sizing chevron renders for every single-selected element — min/max and variable
// apply universally; only the Fixed/Hug/Fill items inside the menu are flex-gated
// (sizeMenuItems). Before the menu, the whole select vanished for non-flex children.
for (const sm of this.sizeModes) sm.menuBtn.hidden = false
```

- `refreshFlexChild` (~line 428): DELETE `for (const sm of this.sizeModes) sm.select.hidden = !visible`.
- Add `sizeMenuItems` next to `registerSizeMode` (import `SIZE_MODES` from `./panel-specs` and `MenuItem` from `./ui/menu`):

```ts
/** Items for the sizing chevron menu, computed at open time. Mode items (checkmark on the
 * inferred current mode) only exist for flex children — Fill/Hug are flex concepts and
 * updateSizeMode only runs there. Min/Max/Variable are universal. */
sizeMenuItems(spec: RowSpec, hasVariable: boolean): MenuItem[] {
  const items: MenuItem[] = []
  const el = this.deps.getEl()
  const parent = el?.parentElement
  const sm = this.sizeModes.find((s) => s.spec === spec)
  if (el && parent && isFlex(parent as TaggedElement) && sm) {
    for (const [value, label] of SIZE_MODES) items.push({ value, label, checked: sm.mode === value })
  }
  items.push({ value: 'add-min', label: 'Min…', separator: items.length > 0 })
  items.push({ value: 'add-max', label: 'Max…' })
  if (hasVariable) items.push({ value: 'variable', label: 'Variable…', separator: true })
  return items
}
```

`stories/select.stories.ts`: remove the SIZE_MODES story block and the `SIZE_MODES` import (WEIGHTS/STROKE_STYLES stories stay). The menu story from Task 1 is its replacement.

- [ ] **Step 3: Rewrite the remaining select-driven tests.** Every `querySelector('.size-mode')` site in panel.test.ts (lines ~635, 660, 734, 754, 764, 773, 783, 797, 809, 828, 850, 908, 968, 1102, 2587) moves to the helpers:
  - Mode changes: `pickSizeMode(panel, P.W, 'Fill')` etc.
  - "Add min…" action (~line 908 area): `pickSizeMode(panel, P.W, 'Min…')`.
  - Select-value assertions (e.g. ~line 968 `expect(['fixed','hug','fill']).toContain(select.value)`): assert the checkmark instead —

```ts
const menu = openSizeMenu(panel, P.W)
const checked = [...menu.querySelectorAll('.menu-item')].filter((b) => b.querySelector('.menu-check'))
expect(checked.length).toBe(1)
```

  - Flex-child visibility tests (~635/660): the chevron is now ALWAYS visible in single-select; rewrite to assert `.menu-btn` not hidden, and add:

```ts
it('sizing chevron renders for non-flex children with only Min/Max/Variable items', () => {
  const { panel } = setup() // setup()'s element has a non-flex parent
  const menu = openSizeMenu(panel, P.W)
  const labels = [...menu.querySelectorAll('.menu-item')].map((b) => (b as HTMLElement).textContent)
  expect(labels.some((l) => l?.startsWith('Fixed'))).toBe(false)
  expect(labels.some((l) => l?.startsWith('Min…'))).toBe(true)
})
```

  - Multi-select test (~2585): `.size-row .menu-btn` all hidden.
  - New tests for the moved affordances:

```ts
it('W/H fields render no { } token button — variable binding lives in the menu', () => {
  const { panel } = childSetup()
  expect(fieldInput(panel, P.W).closest('.nf')!.querySelector('.token-btn')).toBeNull()
})

it('menu Variable… opens the token picker', () => {
  const { panel } = childSetup()
  pickSizeMode(panel, P.W, 'Variable…')
  expect(pickerOf(panel).root.hidden).toBe(false)
})
```

- [ ] **Step 4: Run the whole suite** — `npm test` at root (typecheck catches every missed `sm.select`). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/panel.ts packages/the-forge/src/client/panel-layout.ts packages/the-forge/stories/select.stories.ts packages/the-forge/tests/client/panel.test.ts
git commit -m "feat(client): sizing chevron menu replaces the W/H select — modes flex-gated, min/max + variable universal"
```

---

### Task 5: Inference fix — an `auto` draft/inline is not an explicit size

**Files:**
- Modify: `packages/the-forge/src/client/panel-layout.ts` (`updateSizeMode` ~line 461, `onSizeModeChange` hug branch ~line 535)
- Test: `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Consumes: `sm.mode`, `pickSizeMode`/`openSizeMenu` helpers (Task 4).
- Produces: after picking Hug, `sm.mode === 'hug'`; Fill→Hug retracts Fill's drafted mode props.

- [ ] **Step 1: Write the failing regression tests:**

```ts
it('after picking Hug the menu reads Hug back, not Fixed (auto draft is not an explicit size)', () => {
  const { panel } = childSetup()
  pickSizeMode(panel, P.H, 'Hug')
  const menu = openSizeMenu(panel, P.H)
  const hugItem = [...menu.querySelectorAll('.menu-item')].find((b) => b.textContent?.startsWith('Hug'))!
  expect(hugItem.querySelector('.menu-check')).toBeTruthy()
})

it('Fill then Hug retracts the drafted flex-grow/flex-basis (main axis)', () => {
  const { el, panel, drafts } = childSetup()
  pickSizeMode(panel, P.W, 'Fill')
  expect(drafts.current(el, 'flex-grow')).toBe('1')
  pickSizeMode(panel, P.W, 'Hug')
  expect(drafts.current(el, 'flex-grow')).toBeNull()
  expect(drafts.current(el, 'flex-basis')).toBeNull()
  expect(drafts.current(el, 'width')).toBe('auto')
})

it('Fill then Hug on the cross axis retracts only the stretch Fill wrote', () => {
  const { el, panel, drafts } = childSetup()
  pickSizeMode(panel, P.H, 'Fill')
  expect(drafts.current(el, 'align-self')).toBe('stretch')
  pickSizeMode(panel, P.H, 'Hug')
  expect(drafts.current(el, 'align-self')).toBeNull()
  expect(drafts.current(el, 'height')).toBe('auto')
})
```

Note: `childSetup`'s fixture has inline `width: 50px; height: 50px;` — picking Hug drafts `auto` over it, so the fix must look at the DRAFT value (`auto`), which wins over the inline px in `drafts.current`.

- [ ] **Step 2: Run to verify failure** — expected: first test FAILS (Fixed stays checked).

- [ ] **Step 3: Implement.** In `updateSizeMode`, replace lines 460–461:

```ts
const inline = el.style.getPropertyValue(prop)
// Hug's own `auto` keyword is NOT an explicit size — counting it made the mode read
// back Fixed immediately after the user picked Hug (latent select-era quirk, fixed by
// the 2026-07-06 size-pair spec: the whisper label sits on this inference).
const hasExplicitSize = (!!draft && draft !== 'auto') || (draft === null && !!inline && inline !== 'auto')
```

(The `draft === null` guard keeps a live `auto` draft authoritative over a stale inline px — drafts ARE inline styles, so when a draft exists it IS the inline value; the guard is for clarity, not behavior.)

In `onSizeModeChange`, replace the hug branch:

```ts
} else if (mode === 'hug') {
  // Leaving Fill must retract what Fill drafted (same cleanup contract as the Fixed
  // branch) — a retained flex-grow/stretch keeps the element filling, and the inference
  // would correctly read Fill right back. App-CSS-authored fill (stylesheet flex-grow)
  // is deliberately out of scope — the whisper then honestly reports Fill.
  const modeProps = isMain
    ? ['flex-grow', 'flex-basis']
    : this.deps.drafts.current(el, 'align-self') === 'stretch'
      ? ['align-self']
      : []
  this.deps.drafts.discard(el, modeProps)
  this.deps.drafts.apply(el, prop, 'auto')
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/client/panel.test.ts`, then root `npm test`. Expected: PASS (watch for any test that relied on Hug reading back as Fixed).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/panel-layout.ts packages/the-forge/tests/client/panel.test.ts
git commit -m "fix(client): auto draft is not an explicit size — Hug reads back as Hug; Fill→Hug retracts Fill's drafts"
```

---

### Task 6: Whisper display — Hug/Fill shown with the measured number

**Files:**
- Modify: `packages/the-forge/src/client/panel-layout.ts` (`updateSizeMode` tail)
- Test: `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Consumes: `NumberField.setWhisper` (Task 2), `sm.mode`/`sm.field` (Task 4), fixed inference (Task 5).
- Produces: final display contract — Fixed: plain number, no whisper; Hug/Fill: measured px (browser) or retained `auto` text (jsdom, where computed px is NaN) + whisper `Hug`/`Fill`.

- [ ] **Step 1: Write the failing tests:**

```ts
function whisperOf(panel: Panel, props: string): HTMLElement {
  return fieldInput(panel, props).closest('.nf')!.querySelector('.nf-whisper') as HTMLElement
}

it('picking Hug shows a Hug whisper on the field', () => {
  const { panel } = childSetup()
  pickSizeMode(panel, P.H, 'Hug')
  expect(whisperOf(panel, P.H).hidden).toBe(false)
  expect(whisperOf(panel, P.H).textContent).toBe('Hug')
})

it('picking Fill shows a Fill whisper; switching to Fixed clears it', () => {
  const { panel } = childSetup()
  pickSizeMode(panel, P.W, 'Fill')
  expect(whisperOf(panel, P.W).textContent).toBe('Fill')
  pickSizeMode(panel, P.W, 'Fixed')
  expect(whisperOf(panel, P.W).hidden).toBe(true)
})

it('typing a number into a Hug field flips it to Fixed and clears the whisper', () => {
  const { el, panel, drafts } = childSetup()
  pickSizeMode(panel, P.W, 'Hug')
  commit(fieldInput(panel, P.W), '120')
  expect(drafts.current(el, 'width')).toBe('120px')
  expect(whisperOf(panel, P.W).hidden).toBe(true)
})

it('no whisper for non-flex children (mode inference never runs)', () => {
  const { panel } = setup()
  expect(whisperOf(panel, P.W).hidden).toBe(true)
})
```

(Reuse the existing `commit(input, value)` helper.)

- [ ] **Step 2: Run to verify failure** — whispers stay hidden. Expected: FAIL.

- [ ] **Step 3: Implement.** In `updateSizeMode`, after `sm.mode = ...` is resolved (restructure the tail so mode lands in a local first):

```ts
sm.mode = mode
// Display half (2026-07-06 size-pair spec): Fixed shows a plain number; Hug/Fill show
// the MEASURED px with a whisper naming the applied mode — the field's set()-family
// clears whispers, so every refresh re-asserts (or drops) it here and staleness is
// structurally impossible. jsdom can't compute auto sizes (NaN) — keep the literal
// `auto` display the fields loop already rendered and still whisper the mode.
if (mode === 'fixed') {
  sm.field.setWhisper(null)
  return
}
const px = Math.round(Number.parseFloat(getComputedStyle(el).getPropertyValue(prop)))
if (Number.isFinite(px)) sm.field.set(px)
sm.field.setWhisper(mode === 'hug' ? 'Hug' : 'Fill')
```

Note `updateSizeMode` currently ends with plain `sm.select.value` assignments in three branches (Task 4 made them `sm.mode = ...` with early `return`s) — restructure to compute `const mode` through the branches, then run the block above once at the end.

- [ ] **Step 4: Check the pill-drop test still holds** (~line 1926: pill dropped when W switches to Hug display) — the fields-loop `setAuto`/`tokenUi.drop` path is untouched and `set(px)` also unbinds pills, so it should pass unchanged. Run `npx vitest run tests/client/panel.test.ts`, then root `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/panel-layout.ts packages/the-forge/tests/client/panel.test.ts
git commit -m "feat(client): Hug/Fill whisper on W/H fields with the measured px number"
```

---

### Task 7: Full gate + budget

**Files:** none new — verification only.

- [ ] **Step 1:** Root `npm test` (typecheck + full suite). Expected: PASS, zero skips.
- [ ] **Step 2:** `npm run build`, then `./scripts/check-prod-clean.sh`. Expected: all gates green, unpacked size ≤ 250KB. Record the new size in the commit message.
- [ ] **Step 3:** `npm run storybook -w the-forge` briefly — confirm the Menu story renders and the retired SIZE_MODES select story is gone. (Manual visual check; no commit artifact.)
- [ ] **Step 4:** Commit anything the gate surfaced; otherwise no commit.

---

### Task 8: Real-browser E2E on the demo app

jsdom cannot see flex layout or computed styles (CLAUDE.md gotcha) — this task is the merge gate for the visual behavior.

- [ ] **Step 1:** `npm run build` at root, then kill any stale dev server (`lsof -iTCP:5173` — it often binds `[::1]`) and start fresh (`.claude/launch.json` has the `demo-app` target). A running server keeps serving the OLD client bundle — it must be restarted after the build.
- [ ] **Step 2:** In the browser preview: toggle Design mode (bottom-right), select a card inside a flex parent. Verify, in order:
  1. "Size" group label with W and H side by side, W first; chevron visible on both fields.
  2. Chevron opens the menu: Fixed ✓ / Hug / Fill, separator, Min…, Max…, separator, Variable….
  3. Pick **Fill** → element stretches, field shows the measured px, dim `Fill` whisper on the right.
  4. Pick **Hug** → element hugs content, measured px + `Hug` whisper; reopen menu → Hug is checked (inference fix).
  5. Pick **Fixed** → whisper clears, px stays pinned.
  6. **Min…** → `Min W` row appears focused below the pair; type a value; **Max…** same.
  7. **Variable…** → token picker opens anchored to the field; pick a token → pill binds.
  8. Select an element whose parent is NOT flex → chevron still there; menu shows only Min…/Max…/Variable….
  9. Multi-select two elements → no chevrons, no whispers.
  10. Outside click and Escape close the menu.
- [ ] **Step 3:** Send one change request end-to-end (Send to agent) and confirm `.the-forge/queue.json` gets the item — guards against regressions in the request path from the W/H display changes.
- [ ] **Step 4:** Fix anything found (each fix: failing test where expressible → fix → `npm test` → commit).

---

## Self-review notes (already applied)

- Spec coverage: side-by-side pair (T3), menu + gating + variable (T4), whisper + number (T6), inference fix + Hug write-half companion (T5), budget (T1/T7), stories (T1/T4), E2E (T8). The spec's "no menu-based remove min/max" and "no non-flex Fill/Hug semantics" are absences — nothing to implement.
- Type consistency: `BoundSizeMode.mode: 'fixed' | 'hug' | 'fill'` (T4) is what T5 asserts and T6 reads; `MenuItem`/`createMenuButton` names match between T1 and T4; `setWhisper`/`canOpenToken`/`openToken` match between T2 and T4/T6.
- Known intentional scope cuts (documented in code comments): app-CSS-authored fill vs Hug (whisper honestly reports Fill); jsdom keeps the literal `auto` text under a Hug/Fill whisper.
