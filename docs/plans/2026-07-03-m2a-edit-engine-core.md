# M2a: Edit Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the M1 inspector into an editor: retained selection, a draft engine that previews edits as inline styles, scrubbing numeric controls, panel sections for Size / Spacing / Radius / Opacity, and a before/after compare toggle.

**Architecture:** Three new client modules — `drafts.ts` (DraftStore: per-element original/value records, compare/discard), `controls.ts` (NumberField with drag-to-scrub), `panel.ts` (config-driven editable sections) — plus reworks of `overlay.ts` (persistent selection outline, status strip) and `index.ts` (retained `selected`, scroll re-measure, wiring). Spec: `docs/specs/2026-07-03-design-companion-design.md` §3.2, §5 (Draft state + toggle), §6 (v1 rows: size, padding/margin, radius incl. per-corner, opacity), §10.

**Tech Stack:** unchanged — TypeScript strict, vanilla DOM in shadow root, vitest + jsdom. No new dependencies.

## Global Constraints

- No new runtime dependencies. TypeScript `strict: true`; `npm test` (typecheck + vitest) must stay green.
- Previews are inline styles only — never touch React state or trigger re-renders (spec §10).
- Idle overhead stays zero: ALL document/window listeners (including new scroll/resize) exist only while design mode is active, and are removed on deactivate.
- Draft lifecycle (spec §5): first edit records the element's ORIGINAL inline value for that property (usually `''`); compare = restore originals; un-compare = reapply values; discard = restore originals and forget. Compare is O(1) per property, exact.
- Applying an edit while comparing auto-exits compare (for that scope) so the user always sees what they just did.
- Escape: first press deselects, second press exits design mode; both call `stopPropagation()` so app Escape handlers don't fire (final-review item).
- Selection outline persists across scroll/resize (re-measured via rAF, passive listeners, active-only).
- Units: px only (integers) in M2a; `auto`/unset shown as empty field. Opacity is a percent field (0–100) mapped to CSS 0–1.
- Interfaces from M1 that must not break: `TaggedElement`, `findTaggedElement` (source.ts); `buildInspectorData`, `InspectorData` (inspector.ts); plugin/transform untouched.
- Scrub interactions use mouse events (mousedown on label + window mousemove/mouseup), NOT pointer capture — jsdom has no PointerEvent.

---

### Task 1: DraftStore

**Files:**
- Create: `packages/vite-plugin/src/client/drafts.ts`
- Test: `packages/vite-plugin/tests/client/drafts.test.ts`

**Interfaces:**
- Consumes: `TaggedElement` from `./source`.
- Produces (later tasks rely on these exact signatures):
  - `class DraftStore`
  - `apply(el: TaggedElement, prop: string, value: string): void`
  - `current(el: TaggedElement, prop: string): string | null`
  - `hasDrafts(el: TaggedElement): boolean`, `elementCount(): number`
  - `compare(el: TaggedElement, on: boolean): void`, `compareAll(on: boolean): void`
  - `isComparing(el: TaggedElement): boolean`, `isComparingAll(): boolean`
  - `discard(el: TaggedElement): void`, `discardAll(): void`
  - `onChange: (() => void) | null` — fired after any mutation (apply/compare/discard), for the status strip.

- [ ] **Step 1: Write the failing tests**

`packages/vite-plugin/tests/client/drafts.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DraftStore } from '../../src/client/drafts'

function el(): HTMLElement {
  const d = document.createElement('div')
  document.body.appendChild(d)
  return d
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('DraftStore', () => {
  it('applies a draft as inline style and records the original', () => {
    const store = new DraftStore()
    const d = el()
    store.apply(d, 'padding-top', '12px')
    expect(d.style.getPropertyValue('padding-top')).toBe('12px')
    expect(store.current(d, 'padding-top')).toBe('12px')
    expect(store.hasDrafts(d)).toBe(true)
    expect(store.elementCount()).toBe(1)
  })

  it('preserves a pre-existing inline value as the original', () => {
    const store = new DraftStore()
    const d = el()
    d.style.setProperty('padding-top', '4px')
    store.apply(d, 'padding-top', '12px')
    store.apply(d, 'padding-top', '16px') // second edit must not clobber original
    store.discard(d)
    expect(d.style.getPropertyValue('padding-top')).toBe('4px')
  })

  it('discard removes properties that had no inline original', () => {
    const store = new DraftStore()
    const d = el()
    store.apply(d, 'border-radius', '8px')
    store.discard(d)
    expect(d.style.getPropertyValue('border-radius')).toBe('')
    expect(store.hasDrafts(d)).toBe(false)
    expect(store.elementCount()).toBe(0)
  })

  it('compare(el) flips between original and draft values', () => {
    const store = new DraftStore()
    const d = el()
    store.apply(d, 'width', '200px')
    store.compare(d, true)
    expect(d.style.getPropertyValue('width')).toBe('')
    expect(store.isComparing(d)).toBe(true)
    store.compare(d, false)
    expect(d.style.getPropertyValue('width')).toBe('200px')
  })

  it('compareAll flips every drafted element', () => {
    const store = new DraftStore()
    const a = el()
    const b = el()
    store.apply(a, 'width', '10px')
    store.apply(b, 'height', '20px')
    store.compareAll(true)
    expect(a.style.getPropertyValue('width')).toBe('')
    expect(b.style.getPropertyValue('height')).toBe('')
    expect(store.isComparingAll()).toBe(true)
    store.compareAll(false)
    expect(a.style.getPropertyValue('width')).toBe('10px')
    expect(b.style.getPropertyValue('height')).toBe('20px')
  })

  it('applying an edit while comparing auto-exits compare for that element', () => {
    const store = new DraftStore()
    const d = el()
    store.apply(d, 'width', '100px')
    store.compare(d, true)
    store.apply(d, 'width', '120px')
    expect(store.isComparing(d)).toBe(false)
    expect(d.style.getPropertyValue('width')).toBe('120px')
  })

  it('discardAll restores every element and empties the store', () => {
    const store = new DraftStore()
    const a = el()
    const b = el()
    store.apply(a, 'width', '10px')
    store.apply(b, 'height', '20px')
    store.discardAll()
    expect(a.style.getPropertyValue('width')).toBe('')
    expect(b.style.getPropertyValue('height')).toBe('')
    expect(store.elementCount()).toBe(0)
  })

  it('fires onChange after apply, compare, and discard', () => {
    const store = new DraftStore()
    const d = el()
    const spy = vi.fn()
    store.onChange = spy
    store.apply(d, 'width', '10px')
    store.compare(d, true)
    store.discard(d)
    expect(spy).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `Cannot find module '../../src/client/drafts'`

- [ ] **Step 3: Write the implementation**

`packages/vite-plugin/src/client/drafts.ts`:

```ts
import type { TaggedElement } from './source'

interface DraftProp {
  original: string
  value: string
}

function writeInline(el: TaggedElement, prop: string, css: string): void {
  if (css) el.style.setProperty(prop, css)
  else el.style.removeProperty(prop)
}

export class DraftStore {
  onChange: (() => void) | null = null

  private drafts = new Map<TaggedElement, Map<string, DraftProp>>()
  private showingOriginal = new Set<TaggedElement>()

  apply(el: TaggedElement, prop: string, value: string): void {
    let props = this.drafts.get(el)
    if (!props) {
      props = new Map()
      this.drafts.set(el, props)
    }
    const existing = props.get(prop)
    if (existing) existing.value = value
    else props.set(prop, { original: el.style.getPropertyValue(prop), value })

    if (this.showingOriginal.has(el)) {
      // auto-exit compare so the user sees the edit they just made
      this.showingOriginal.delete(el)
      this.writeAll(el, 'value')
    }
    el.style.setProperty(prop, value)
    this.emit()
  }

  current(el: TaggedElement, prop: string): string | null {
    return this.drafts.get(el)?.get(prop)?.value ?? null
  }

  hasDrafts(el: TaggedElement): boolean {
    return this.drafts.has(el)
  }

  elementCount(): number {
    return this.drafts.size
  }

  compare(el: TaggedElement, on: boolean): void {
    if (!this.drafts.has(el) || on === this.showingOriginal.has(el)) return
    if (on) this.showingOriginal.add(el)
    else this.showingOriginal.delete(el)
    this.writeAll(el, on ? 'original' : 'value')
    this.emit()
  }

  compareAll(on: boolean): void {
    for (const el of this.drafts.keys()) {
      if (on) this.showingOriginal.add(el)
      else this.showingOriginal.delete(el)
      this.writeAll(el, on ? 'original' : 'value')
    }
    this.emit()
  }

  isComparing(el: TaggedElement): boolean {
    return this.showingOriginal.has(el)
  }

  isComparingAll(): boolean {
    return this.drafts.size > 0 && this.showingOriginal.size === this.drafts.size
  }

  discard(el: TaggedElement): void {
    const props = this.drafts.get(el)
    if (!props) return
    for (const [prop, d] of props) writeInline(el, prop, d.original)
    this.drafts.delete(el)
    this.showingOriginal.delete(el)
    this.emit()
  }

  discardAll(): void {
    for (const el of [...this.drafts.keys()]) {
      const props = this.drafts.get(el)!
      for (const [prop, d] of props) writeInline(el, prop, d.original)
      this.showingOriginal.delete(el)
    }
    this.drafts.clear()
    this.emit()
  }

  private writeAll(el: TaggedElement, side: 'original' | 'value'): void {
    const props = this.drafts.get(el)
    if (!props) return
    for (const [prop, d] of props) writeInline(el, prop, d[side])
  }

  private emit(): void {
    this.onChange?.()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @design-companion/vite`
Expected: PASS (43 tests: 35 + 8 new)

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/client/drafts.ts packages/vite-plugin/tests/client/drafts.test.ts
git commit -m "feat: draft store — inline-style previews with compare and discard"
```

---

### Task 2: NumberField control

**Files:**
- Create: `packages/vite-plugin/src/client/controls.ts`
- Test: `packages/vite-plugin/tests/client/controls.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface NumberFieldOpts { label: string; min?: number; max?: number; onInput: (value: number) => void }`
  - `class NumberField { root: HTMLElement; constructor(opts: NumberFieldOpts); set(value: number | null): void; get(): number | null }`
  - `set(null)` renders an empty field (auto/mixed); user typing/scrubbing always emits integers via `onInput`.
  - Root layout: `<div class="nf"><span class="nf-label">…</span><input></div>`; the label is the scrub handle.

- [ ] **Step 1: Write the failing tests**

`packages/vite-plugin/tests/client/controls.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NumberField } from '../../src/client/controls'

beforeEach(() => {
  document.body.innerHTML = ''
})

function make(opts: Partial<{ min: number; max: number }> = {}) {
  const onInput = vi.fn()
  const nf = new NumberField({ label: 'W', onInput, ...opts })
  document.body.appendChild(nf.root)
  const input = nf.root.querySelector('input')!
  const label = nf.root.querySelector('.nf-label')! as HTMLElement
  return { nf, onInput, input, label }
}

describe('NumberField', () => {
  it('renders label and reflects set()', () => {
    const { nf, input } = make()
    nf.set(24)
    expect(input.value).toBe('24')
    expect(nf.get()).toBe(24)
    nf.set(null)
    expect(input.value).toBe('')
    expect(nf.get()).toBeNull()
  })

  it('commits typed values on change and emits integers', () => {
    const { onInput, input } = make()
    input.value = '18.7'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).toHaveBeenCalledWith(19)
    expect(input.value).toBe('19')
  })

  it('reverts to last valid value on garbage input', () => {
    const { nf, onInput, input } = make()
    nf.set(10)
    input.value = 'abc'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).not.toHaveBeenCalled()
    expect(input.value).toBe('10')
  })

  it('ArrowUp/ArrowDown step by 1, Shift steps by 10, clamped to min', () => {
    const { onInput, input } = make({ min: 0 })
    input.value = '5'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    expect(onInput).toHaveBeenLastCalledWith(6)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true }))
    expect(onInput).toHaveBeenLastCalledWith(0) // 6 - 10 clamped to min 0
  })

  it('label drag scrubs the value by horizontal delta', () => {
    const { nf, onInput, label } = make({ min: 0 })
    nf.set(20)
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 115 }))
    expect(onInput).toHaveBeenLastCalledWith(35)
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 90 }))
    expect(onInput).toHaveBeenLastCalledWith(10)
    window.dispatchEvent(new MouseEvent('mouseup', {}))
    // after mouseup, moves do nothing
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }))
    expect(onInput).toHaveBeenLastCalledWith(10)
  })

  it('scrubbing from an empty (auto) value starts at 0', () => {
    const { onInput, label } = make({ min: 0 })
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 58 }))
    expect(onInput).toHaveBeenLastCalledWith(8)
    window.dispatchEvent(new MouseEvent('mouseup', {}))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `Cannot find module '../../src/client/controls'`

- [ ] **Step 3: Write the implementation**

`packages/vite-plugin/src/client/controls.ts`:

```ts
export interface NumberFieldOpts {
  label: string
  min?: number
  max?: number
  onInput: (value: number) => void
}

export class NumberField {
  root = document.createElement('div')

  private input = document.createElement('input')
  private labelEl = document.createElement('span')
  private lastValid: number | null = null
  private scrubStartX = 0
  private scrubStartValue = 0
  private scrubbing = false

  constructor(private opts: NumberFieldOpts) {
    this.root.className = 'nf'
    this.labelEl.className = 'nf-label'
    this.labelEl.textContent = opts.label
    this.input.type = 'text'
    this.input.inputMode = 'numeric'
    this.root.append(this.labelEl, this.input)

    this.input.addEventListener('change', () => {
      const n = Number.parseFloat(this.input.value)
      if (Number.isFinite(n)) this.commit(n)
      else this.render(this.lastValid)
    })

    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1)
      const base = Number.parseFloat(this.input.value)
      this.commit((Number.isFinite(base) ? base : 0) + step)
    })

    this.labelEl.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.scrubbing = true
      this.scrubStartX = e.clientX
      this.scrubStartValue = this.lastValid ?? 0
      window.addEventListener('mousemove', this.onScrub)
      window.addEventListener('mouseup', this.endScrub)
    })
  }

  private onScrub = (e: MouseEvent): void => {
    if (!this.scrubbing) return
    this.commit(this.scrubStartValue + (e.clientX - this.scrubStartX))
  }

  private endScrub = (): void => {
    this.scrubbing = false
    window.removeEventListener('mousemove', this.onScrub)
    window.removeEventListener('mouseup', this.endScrub)
  }

  private commit(raw: number): void {
    let n = Math.round(raw)
    if (this.opts.min !== undefined) n = Math.max(this.opts.min, n)
    if (this.opts.max !== undefined) n = Math.min(this.opts.max, n)
    this.render(n)
    this.opts.onInput(n)
  }

  private render(value: number | null): void {
    this.lastValid = value
    this.input.value = value === null ? '' : String(value)
  }

  set(value: number | null): void {
    this.render(value)
  }

  get(): number | null {
    return this.lastValid
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @design-companion/vite`
Expected: PASS (49 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/client/controls.ts packages/vite-plugin/tests/client/controls.test.ts
git commit -m "feat: NumberField control with drag-to-scrub, keyboard steps, and clamping"
```

---

### Task 3: Editable panel (Size / Spacing / Radius / Opacity)

**Files:**
- Create: `packages/vite-plugin/src/client/panel.ts`
- Test: `packages/vite-plugin/tests/client/panel.test.ts`

**Interfaces:**
- Consumes: `DraftStore` (Task 1), `NumberField` (Task 2), `TaggedElement` (source.ts), `InspectorData` (inspector.ts, header only).
- Produces:
  - `class Panel { root: HTMLElement; constructor(drafts: DraftStore, onEdited: () => void); show(el: TaggedElement, data: InspectorData): void; hide(): void; refresh(): void; compareButton: HTMLButtonElement; resetButton: HTMLButtonElement }`
  - `onEdited` fires after every applied edit (DesignMode uses it to re-measure the selection outline).
  - Rows (px integer fields unless noted), reading initial values from draft-current ?? computed style:
    - **Size:** W (`width`), H (`height`)
    - **Padding:** X (`padding-left`+`padding-right` linked), Y (`padding-top`+`padding-bottom` linked), expandable to T/R/B/L
    - **Margin:** same shape as Padding
    - **Radius:** all (`border-radius` linked → writes 4 corner longhands), expandable to TL/TR/BR/BL (`border-top-left-radius` etc.)
    - **Opacity:** percent 0–100 → css `opacity` 0–1
  - Linked rows: when sides differ, field shows empty (mixed); editing a linked field writes ALL its longhands.
  - Header: `<tag> — file:line:col`, plus per-element Compare (toggles `drafts.compare(el, …)`) and Reset (`drafts.discard(el)`) buttons.

- [ ] **Step 1: Write the failing tests**

`packages/vite-plugin/tests/client/panel.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Panel } from '../../src/client/panel'
import { DraftStore } from '../../src/client/drafts'
import { buildInspectorData } from '../../src/client/inspector'

function setup(html = `<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px; width: 200px;"></div>`) {
  document.body.innerHTML = html
  const el = document.getElementById('t')! as HTMLElement
  const drafts = new DraftStore()
  const onEdited = vi.fn()
  const panel = new Panel(drafts, onEdited)
  document.body.appendChild(panel.root)
  panel.show(el, buildInspectorData(el))
  return { el, drafts, panel, onEdited }
}

function fieldInput(panel: Panel, label: string): HTMLInputElement {
  const nf = [...panel.root.querySelectorAll('.nf')].find(
    (n) => n.querySelector('.nf-label')!.textContent === label
  )
  if (!nf) throw new Error(`no field labeled ${label}`)
  return nf.querySelector('input')!
}

function commit(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('Panel', () => {
  it('shows header with source location and populates fields from computed styles', () => {
    const { panel } = setup()
    expect(panel.root.textContent).toContain('src/Card.tsx:4:7')
    expect(fieldInput(panel, 'W').value).toBe('200')
    expect(fieldInput(panel, 'PX').value).toBe('8')
    expect(fieldInput(panel, 'PY').value).toBe('8')
  })

  it('editing a linked padding field writes both longhands as drafts', () => {
    const { el, panel, drafts, onEdited } = setup()
    commit(fieldInput(panel, 'PX'), '16')
    expect(drafts.current(el, 'padding-left')).toBe('16px')
    expect(drafts.current(el, 'padding-right')).toBe('16px')
    expect(el.style.getPropertyValue('padding-left')).toBe('16px')
    expect(onEdited).toHaveBeenCalled()
  })

  it('shows mixed linked values as empty field', () => {
    const { panel } = setup(
      `<div data-dc-source="src/a.tsx:1:1" id="t" style="padding-left: 4px; padding-right: 12px;"></div>`
    )
    expect(fieldInput(panel, 'PX').value).toBe('')
  })

  it('expanding padding reveals per-side fields that edit one longhand', () => {
    const { el, panel, drafts } = setup()
    ;(panel.root.querySelector('[data-expand="padding"]') as HTMLElement).click()
    commit(fieldInput(panel, 'PT'), '20')
    expect(drafts.current(el, 'padding-top')).toBe('20px')
    expect(drafts.current(el, 'padding-bottom')).toBeNull()
  })

  it('radius linked field writes all four corner longhands', () => {
    const { el, panel, drafts } = setup()
    commit(fieldInput(panel, 'R'), '10')
    for (const c of ['top-left', 'top-right', 'bottom-right', 'bottom-left']) {
      expect(drafts.current(el, `border-${c}-radius`)).toBe('10px')
    }
  })

  it('opacity field maps percent to 0-1 css', () => {
    const { el, panel, drafts } = setup()
    commit(fieldInput(panel, 'O'), '60')
    expect(drafts.current(el, 'opacity')).toBe('0.6')
  })

  it('per-element compare and reset buttons drive the store', () => {
    const { el, panel, drafts } = setup()
    commit(fieldInput(panel, 'W'), '300')
    panel.compareButton.click()
    expect(drafts.isComparing(el)).toBe(true)
    panel.compareButton.click()
    expect(drafts.isComparing(el)).toBe(false)
    panel.resetButton.click()
    expect(drafts.hasDrafts(el)).toBe(false)
    expect(fieldInput(panel, 'W').value).toBe('200') // refreshed back to computed
  })

  it('hide clears the panel', () => {
    const { panel } = setup()
    panel.hide()
    expect(panel.root.hidden).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `Cannot find module '../../src/client/panel'`

- [ ] **Step 3: Write the implementation**

`packages/vite-plugin/src/client/panel.ts`:

```ts
import type { TaggedElement } from './source'
import type { InspectorData } from './inspector'
import { DraftStore } from './drafts'
import { NumberField } from './controls'

interface RowSpec {
  label: string
  props: string[]
  min?: number
  max?: number
  toCss?: (n: number) => string
  fromCss?: (css: string) => number
}

interface SectionSpec {
  title: string
  rows: RowSpec[]
  expandKey?: string
  expandRows?: RowSpec[]
}

const px = (n: number): string => `${n}px`
const fromPx = (css: string): number => Math.round(Number.parseFloat(css) || 0)

const RADIUS = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']

const SECTIONS: SectionSpec[] = [
  {
    title: 'Size',
    rows: [
      { label: 'W', props: ['width'], min: 0 },
      { label: 'H', props: ['height'], min: 0 },
    ],
  },
  {
    title: 'Padding',
    expandKey: 'padding',
    rows: [
      { label: 'PX', props: ['padding-left', 'padding-right'], min: 0 },
      { label: 'PY', props: ['padding-top', 'padding-bottom'], min: 0 },
    ],
    expandRows: [
      { label: 'PT', props: ['padding-top'], min: 0 },
      { label: 'PR', props: ['padding-right'], min: 0 },
      { label: 'PB', props: ['padding-bottom'], min: 0 },
      { label: 'PL', props: ['padding-left'], min: 0 },
    ],
  },
  {
    title: 'Margin',
    expandKey: 'margin',
    rows: [
      { label: 'MX', props: ['margin-left', 'margin-right'] },
      { label: 'MY', props: ['margin-top', 'margin-bottom'] },
    ],
    expandRows: [
      { label: 'MT', props: ['margin-top'] },
      { label: 'MR', props: ['margin-right'] },
      { label: 'MB', props: ['margin-bottom'] },
      { label: 'ML', props: ['margin-left'] },
    ],
  },
  {
    title: 'Appearance',
    expandKey: 'radius',
    rows: [
      { label: 'R', props: RADIUS, min: 0 },
      {
        label: 'O',
        props: ['opacity'],
        min: 0,
        max: 100,
        toCss: (n) => String(n / 100),
        fromCss: (css) => Math.round((Number.parseFloat(css) || 1) * 100),
      },
    ],
    expandRows: [
      { label: 'TL', props: ['border-top-left-radius'], min: 0 },
      { label: 'TR', props: ['border-top-right-radius'], min: 0 },
      { label: 'BR', props: ['border-bottom-right-radius'], min: 0 },
      { label: 'BL', props: ['border-bottom-left-radius'], min: 0 },
    ],
  },
]

interface BoundField {
  field: NumberField
  spec: RowSpec
}

export class Panel {
  root = document.createElement('div')
  compareButton = document.createElement('button')
  resetButton = document.createElement('button')

  private head = document.createElement('div')
  private body = document.createElement('div')
  private fields: BoundField[] = []
  private el: TaggedElement | null = null

  constructor(
    private drafts: DraftStore,
    private onEdited: () => void
  ) {
    this.root.id = 'panel'
    this.root.hidden = true
    this.head.className = 'panel-head'
    this.compareButton.textContent = 'Compare'
    this.resetButton.textContent = 'Reset'
    this.compareButton.addEventListener('click', () => {
      if (!this.el) return
      this.drafts.compare(this.el, !this.drafts.isComparing(this.el))
      this.refresh()
    })
    this.resetButton.addEventListener('click', () => {
      if (!this.el) return
      this.drafts.discard(this.el)
      this.refresh()
      this.onEdited()
    })
    this.root.append(this.head, this.compareButton, this.resetButton, this.body)
  }

  show(el: TaggedElement, data: InspectorData): void {
    this.el = el
    this.root.hidden = false
    this.head.textContent = data.source
      ? `<${data.tag}> — ${data.source.file}:${data.source.line}:${data.source.col}`
      : `<${data.tag}>`
    this.buildBody()
    this.refresh()
  }

  hide(): void {
    this.el = null
    this.root.hidden = true
  }

  refresh(): void {
    if (!this.el) return
    const computed = getComputedStyle(this.el)
    for (const { field, spec } of this.fields) {
      const values = spec.props.map((p) => this.readValue(this.el!, p, computed, spec))
      const mixed = values.some((v) => v !== values[0])
      field.set(mixed ? null : values[0])
    }
  }

  private readValue(el: TaggedElement, prop: string, computed: CSSStyleDeclaration, spec: RowSpec): number {
    const draft = this.drafts.current(el, prop)
    const css = draft ?? computed.getPropertyValue(prop)
    return (spec.fromCss ?? fromPx)(css)
  }

  private buildBody(): void {
    this.body.replaceChildren()
    this.fields = []
    for (const section of SECTIONS) {
      const title = document.createElement('div')
      title.className = 'panel-section'
      title.textContent = section.title
      this.body.append(title)
      const rowWrap = document.createElement('div')
      rowWrap.className = 'panel-rows'
      this.body.append(rowWrap)
      for (const row of section.rows) rowWrap.append(this.buildField(row))

      if (section.expandRows && section.expandKey) {
        const expandWrap = document.createElement('div')
        expandWrap.className = 'panel-rows'
        expandWrap.hidden = true
        const btn = document.createElement('button')
        btn.textContent = '⋯'
        btn.setAttribute('data-expand', section.expandKey)
        btn.addEventListener('click', () => {
          expandWrap.hidden = !expandWrap.hidden
        })
        rowWrap.append(btn)
        for (const row of section.expandRows) expandWrap.append(this.buildField(row))
        this.body.append(expandWrap)
      }
    }
  }

  private buildField(spec: RowSpec): HTMLElement {
    const field = new NumberField({
      label: spec.label,
      min: spec.min,
      max: spec.max,
      onInput: (n) => {
        if (!this.el) return
        const css = (spec.toCss ?? px)(n)
        for (const prop of spec.props) this.drafts.apply(this.el, prop, css)
        this.refresh()
        this.onEdited()
      },
    })
    this.fields.push({ field, spec })
    return field.root
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @design-companion/vite`
Expected: PASS (57 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/client/panel.ts packages/vite-plugin/tests/client/panel.test.ts
git commit -m "feat: editable panel — size, padding, margin, radius, opacity with linked rows"
```

---

### Task 4: Overlay rework — selection outline, status strip, panel host

**Files:**
- Modify: `packages/vite-plugin/src/client/overlay.ts`
- Test: `packages/vite-plugin/tests/client/overlay.test.ts` (new; existing design-mode tests updated in Task 5)

**Interfaces:**
- Consumes: nothing new.
- Produces (additions to `Overlay`; existing members `host`, `toggle`, `mount()`, `contains()`, `setActive()`, `showOutline()`, `hideOutline()` keep their exact signatures; `showPanel(data)`/`hidePanel()` are REMOVED — Panel owns the panel now):
  - `attachPanel(panelRoot: HTMLElement): void` — appends the Panel's root into the shadow root (Panel keeps `id="panel"`, so existing CSS applies).
  - `showSelectOutline(rect: DOMRect): void`, `hideSelectOutline(): void` — persistent 2px outline, distinct element `#select-outline`.
  - `updateStatus(draftCount: number, comparingAll: boolean): void` — status strip `#status` near the toggle: hidden when count is 0; otherwise shows `${n} draft${s}` plus two buttons: `compareAllButton` ("Before"/"After" label flips with state) and `resetAllButton` ("Reset all").
  - `compareAllButton: HTMLButtonElement`, `resetAllButton: HTMLButtonElement` — wired by DesignMode in Task 5.
  - `setActive(false)` also hides the select outline and status strip.

- [ ] **Step 1: Write the failing tests**

`packages/vite-plugin/tests/client/overlay.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { Overlay } from '../../src/client/overlay'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('Overlay (M2 additions)', () => {
  it('attachPanel mounts an external panel root into the shadow root', () => {
    const overlay = new Overlay()
    overlay.mount()
    const panelRoot = document.createElement('div')
    panelRoot.id = 'panel'
    overlay.attachPanel(panelRoot)
    expect(overlay.host.shadowRoot!.getElementById('panel')).toBe(panelRoot)
  })

  it('selection outline is separate from hover outline and persists', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showSelectOutline(new DOMRect(10, 20, 100, 50))
    overlay.showOutline(new DOMRect(0, 0, 5, 5))
    overlay.hideOutline()
    const sel = overlay.host.shadowRoot!.getElementById('select-outline') as HTMLElement
    expect(sel.hidden).toBe(false)
    overlay.hideSelectOutline()
    expect(sel.hidden).toBe(true)
  })

  it('status strip shows draft count and flips compare label', () => {
    const overlay = new Overlay()
    overlay.mount()
    const status = overlay.host.shadowRoot!.getElementById('status') as HTMLElement
    overlay.updateStatus(0, false)
    expect(status.hidden).toBe(true)
    overlay.updateStatus(3, false)
    expect(status.hidden).toBe(false)
    expect(status.textContent).toContain('3 drafts')
    expect(overlay.compareAllButton.textContent).toBe('Before')
    overlay.updateStatus(3, true)
    expect(overlay.compareAllButton.textContent).toBe('After')
  })

  it('setActive(false) hides selection outline and status', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showSelectOutline(new DOMRect(0, 0, 1, 1))
    overlay.updateStatus(2, false)
    overlay.setActive(false)
    expect((overlay.host.shadowRoot!.getElementById('select-outline') as HTMLElement).hidden).toBe(true)
    expect((overlay.host.shadowRoot!.getElementById('status') as HTMLElement).hidden).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `attachPanel is not a function` (and related)

- [ ] **Step 3: Rework the overlay**

Replace `packages/vite-plugin/src/client/overlay.ts` with:

```ts
const CSS = `
:host { all: initial; }
button {
  font: 500 12px system-ui, sans-serif; border-radius: 999px;
  border: 1px solid #d0d0cb; background: #fff; color: #1a1a18;
  cursor: pointer; padding: 6px 12px;
}
#toggle { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; padding: 8px 14px; }
#toggle.active { background: #1a1a18; color: #fff; }
#status {
  position: fixed; right: 16px; bottom: 60px; z-index: 2147483647;
  display: flex; gap: 6px; align-items: center;
  font: 400 12px system-ui, sans-serif; color: #1a1a18;
  background: #fff; border: 1px solid #d0d0cb; border-radius: 999px; padding: 5px 8px 5px 12px;
}
#outline {
  position: fixed; z-index: 2147483645; pointer-events: none;
  border: 1.5px solid #4a90e2; border-radius: 2px;
}
#select-outline {
  position: fixed; z-index: 2147483646; pointer-events: none;
  border: 2px solid #4a90e2; border-radius: 2px;
}
#panel {
  position: fixed; right: 16px; top: 16px; z-index: 2147483647;
  width: 260px; max-height: 80vh; overflow-y: auto;
  font: 400 12px system-ui, sans-serif; background: #fff; color: #1a1a18;
  border: 1px solid #d0d0cb; border-radius: 10px; padding: 12px;
}
#panel .panel-head { font-weight: 500; margin-bottom: 8px; word-break: break-all; }
#panel .panel-section { color: #6b6b66; margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
#panel .panel-rows { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
#panel button { border-radius: 6px; padding: 4px 10px; }
.nf { display: flex; align-items: center; gap: 4px; border: 1px solid #e3e3de; border-radius: 6px; padding: 2px 6px; }
.nf-label { color: #6b6b66; font-size: 11px; cursor: ew-resize; user-select: none; min-width: 16px; }
.nf input { width: 44px; border: none; outline: none; font: 400 12px system-ui, sans-serif; color: #1a1a18; background: transparent; }
`

export class Overlay {
  host = document.createElement('div')
  toggle = document.createElement('button')
  compareAllButton = document.createElement('button')
  resetAllButton = document.createElement('button')

  private outline = document.createElement('div')
  private selectOutline = document.createElement('div')
  private status = document.createElement('div')
  private statusLabel = document.createElement('span')

  constructor() {
    const root = this.host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = CSS
    this.toggle.id = 'toggle'
    this.toggle.textContent = 'Design'
    this.outline.id = 'outline'
    this.selectOutline.id = 'select-outline'
    this.status.id = 'status'
    this.resetAllButton.textContent = 'Reset all'
    this.status.append(this.statusLabel, this.compareAllButton, this.resetAllButton)
    this.outline.hidden = true
    this.selectOutline.hidden = true
    this.status.hidden = true
    root.append(style, this.toggle, this.status, this.outline, this.selectOutline)
  }

  mount(): void {
    document.body.appendChild(this.host)
  }

  attachPanel(panelRoot: HTMLElement): void {
    this.host.shadowRoot!.appendChild(panelRoot)
  }

  contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.host.contains(target)
  }

  setActive(on: boolean): void {
    this.toggle.classList.toggle('active', on)
    if (!on) {
      this.hideOutline()
      this.hideSelectOutline()
      this.status.hidden = true
    }
  }

  private place(box: HTMLElement, rect: DOMRect): void {
    box.hidden = false
    box.style.left = `${rect.left - 2}px`
    box.style.top = `${rect.top - 2}px`
    box.style.width = `${rect.width + 4}px`
    box.style.height = `${rect.height + 4}px`
  }

  showOutline(rect: DOMRect): void {
    this.place(this.outline, rect)
  }

  hideOutline(): void {
    this.outline.hidden = true
  }

  showSelectOutline(rect: DOMRect): void {
    this.place(this.selectOutline, rect)
  }

  hideSelectOutline(): void {
    this.selectOutline.hidden = true
  }

  updateStatus(draftCount: number, comparingAll: boolean): void {
    this.status.hidden = draftCount === 0
    this.statusLabel.textContent = `${draftCount} draft${draftCount === 1 ? '' : 's'}`
    this.compareAllButton.textContent = comparingAll ? 'After' : 'Before'
  }
}
```

Note: `InspectorData` import and `showPanel`/`hidePanel` are gone — Task 5 updates `index.ts` (its old `showPanel` call sites) and the M1 design-mode test that referenced the old panel.

- [ ] **Step 4: Run the new overlay tests (design-mode tests will fail until Task 5 — expected)**

Run: `npx vitest run tests/client/overlay.test.ts -w @design-companion/vite` — actually run from the package: `npm run test -w @design-companion/vite -- tests/client/overlay.test.ts`
Expected: overlay tests PASS. Do NOT run the full suite yet; `index.ts` still calls the removed `showPanel` and won't compile — that's Task 5's job. Commit only if the overlay file and its test compile in isolation; otherwise fold this commit into Task 5's (acceptable — note it in your report).

- [ ] **Step 5: Commit (or defer to Task 5 if the package doesn't build standalone)**

```bash
git add packages/vite-plugin/src/client/overlay.ts packages/vite-plugin/tests/client/overlay.test.ts
git commit -m "feat: overlay selection outline, status strip, and external panel host"
```

---

### Task 5: DesignMode wiring — retained selection, scroll tracking, Escape order

**Files:**
- Modify: `packages/vite-plugin/src/client/index.ts`
- Modify: `packages/vite-plugin/tests/client/design-mode.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (`DesignMode` additions; constructor becomes `constructor(overlay: Overlay, panel?: Panel, drafts?: DraftStore)` with panel/drafts defaulting to fresh instances so old two-arg-less tests still construct):
  - `selected: TaggedElement | null`
  - `select(el: TaggedElement): void`, `deselect(): void`
  - Behavior: click tagged → select (persistent outline + panel); click untagged/empty → deselect; Escape deselects first, exits mode on second press, and calls `stopPropagation()`; scroll/resize (capture, passive) re-measure both outlines via rAF while active; `drafts.onChange` drives `overlay.updateStatus`; compareAll/resetAll buttons wired; deactivating design mode keeps drafts applied (previews survive, spec §5) but hides all chrome.
  - Boot exposes the instance: `window.__DESIGN_COMPANION__ = { mode }` (typed via a `declare global` block) — the M4 dispatch layer and debugging need a handle.

- [ ] **Step 1: Update the design-mode tests**

In `packages/vite-plugin/tests/client/design-mode.test.ts`: delete the old click-select test (`click selects the nearest tagged element and prevents the app click`) and the old `Overlay` panel assertions; add the following (keep all listener-lifecycle, toggle, and rAF tests — update the listener test's expected event list):

```ts
// The activate/deactivate listener test now expects scroll + resize too:
// added/removed lists become:
// ['click', 'keydown', 'mousemove', 'resize', 'scroll'] (sorted)

import { DraftStore } from '../../src/client/drafts'
import { Panel } from '../../src/client/panel'

function fullSetup() {
  document.body.innerHTML = `<button data-dc-source="src/Button.tsx:42:8" class="btn">go</button>`
  const overlay = new Overlay()
  overlay.mount()
  const drafts = new DraftStore()
  const panel = new Panel(drafts, () => {})
  overlay.attachPanel(panel.root)
  const mode = new DesignMode(overlay, panel, drafts)
  return { overlay, drafts, panel, mode }
}

describe('DesignMode selection (M2)', () => {
  it('click selects: retained element, persistent outline, editable panel', () => {
    const { overlay, mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    const appHandler = vi.fn()
    btn.addEventListener('click', appHandler)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(appHandler).not.toHaveBeenCalled()
    expect(mode.selected).toBe(btn)
    const root = overlay.host.shadowRoot!
    expect((root.getElementById('select-outline') as HTMLElement).hidden).toBe(false)
    expect((root.getElementById('panel') as HTMLElement).hidden).toBe(false)
    expect(root.getElementById('panel')!.textContent).toContain('src/Button.tsx:42:8')
  })

  it('clicking an untagged area deselects', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(mode.selected).toBeNull()
  })

  it('Escape deselects first, exits on second press, and stops propagation', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const appEsc = vi.fn()
    document.body.addEventListener('keydown', appEsc)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mode.selected).toBeNull()
    expect(mode.active).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mode.active).toBe(false)
    expect(appEsc).not.toHaveBeenCalled()
  })

  it('drafts survive deactivation but chrome hides', () => {
    const { mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '20px')
    mode.setActive(false)
    expect(btn.style.getPropertyValue('padding-top')).toBe('20px')
  })

  it('draft changes drive the status strip and compare-all button', () => {
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'width', '100px')
    const status = overlay.host.shadowRoot!.getElementById('status') as HTMLElement
    expect(status.hidden).toBe(false)
    overlay.compareAllButton.click()
    expect(drafts.isComparingAll()).toBe(true)
    overlay.resetAllButton.click()
    expect(drafts.elementCount()).toBe(0)
    expect(status.hidden).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — constructor arity / `selected` undefined / listener list mismatch.

- [ ] **Step 3: Rework the controller**

Replace `packages/vite-plugin/src/client/index.ts` with:

```ts
import { Overlay } from './overlay'
import { findTaggedElement, type TaggedElement } from './source'
import { buildInspectorData } from './inspector'
import { DraftStore } from './drafts'
import { Panel } from './panel'

declare global {
  interface Window {
    __DESIGN_COMPANION__?: { mode: DesignMode }
  }
}

export class DesignMode {
  active = false
  selected: TaggedElement | null = null

  private rafId = 0
  private lastMove: MouseEvent | null = null
  private drafts: DraftStore
  private panel: Panel

  constructor(
    private overlay: Overlay,
    panel?: Panel,
    drafts?: DraftStore
  ) {
    this.drafts = drafts ?? new DraftStore()
    this.panel = panel ?? new Panel(this.drafts, () => this.remeasure())
    overlay.toggle.addEventListener('click', () => this.setActive(!this.active))
    overlay.compareAllButton.addEventListener('click', () => {
      this.drafts.compareAll(!this.drafts.isComparingAll())
      this.panel.refresh()
    })
    overlay.resetAllButton.addEventListener('click', () => {
      this.drafts.discardAll()
      this.panel.refresh()
      this.remeasure()
    })
    this.drafts.onChange = () => {
      this.overlay.updateStatus(this.drafts.elementCount(), this.drafts.isComparingAll())
    }
  }

  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    this.overlay.setActive(on)
    if (on) {
      document.addEventListener('mousemove', this.onMove, true)
      document.addEventListener('click', this.onClick, true)
      document.addEventListener('keydown', this.onKey, true)
      document.addEventListener('scroll', this.onReflow, { capture: true, passive: true })
      window.addEventListener('resize', this.onReflow, { passive: true })
      this.overlay.updateStatus(this.drafts.elementCount(), this.drafts.isComparingAll())
    } else {
      document.removeEventListener('mousemove', this.onMove, true)
      document.removeEventListener('click', this.onClick, true)
      document.removeEventListener('keydown', this.onKey, true)
      document.removeEventListener('scroll', this.onReflow, true)
      window.removeEventListener('resize', this.onReflow)
      if (this.rafId) cancelAnimationFrame(this.rafId)
      this.rafId = 0
      this.lastMove = null
      this.selected = null
      this.panel.hide()
    }
  }

  select(el: TaggedElement): void {
    this.selected = el
    this.overlay.showSelectOutline(el.getBoundingClientRect())
    this.panel.show(el, buildInspectorData(el))
  }

  deselect(): void {
    this.selected = null
    this.overlay.hideSelectOutline()
    this.panel.hide()
  }

  private remeasure(): void {
    if (this.selected) this.overlay.showSelectOutline(this.selected.getBoundingClientRect())
  }

  private onMove = (e: MouseEvent): void => {
    this.lastMove = e
    if (this.rafId) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0
      const ev = this.lastMove
      if (!this.active || !ev || this.overlay.contains(ev.target)) return
      const el = findTaggedElement(ev.target as Element)
      if (el && el !== this.selected) this.overlay.showOutline(el.getBoundingClientRect())
      else this.overlay.hideOutline()
    })
  }

  private onClick = (e: MouseEvent): void => {
    if (this.overlay.contains(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    const el = findTaggedElement(e.target as Element)
    if (el) this.select(el)
    else this.deselect()
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (this.selected) this.deselect()
    else this.setActive(false)
  }

  private onReflow = (): void => {
    if (this.rafId) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0
      if (!this.active) return
      this.remeasure()
      this.overlay.hideOutline()
    })
  }
}

function boot(): void {
  const overlay = new Overlay()
  overlay.mount()
  const drafts = new DraftStore()
  const panel = new Panel(drafts, () => mode['remeasure']?.())
  overlay.attachPanel(panel.root)
  const mode = new DesignMode(overlay, panel, drafts)
  window.__DESIGN_COMPANION__ = { mode }
}

if (typeof document !== 'undefined' && !import.meta.vitest) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
}
```

Note on `boot()`: the `mode['remeasure']` indirection is ugly and circular — clean it up by giving Panel's `onEdited` a mutable holder:

```ts
function boot(): void {
  const overlay = new Overlay()
  overlay.mount()
  const drafts = new DraftStore()
  let mode: DesignMode | null = null
  const panel = new Panel(drafts, () => mode?.select === undefined ? undefined : mode?.selected && overlay.showSelectOutline(mode.selected.getBoundingClientRect()))
  ...
}
```

Simpler and preferred: make `DesignMode`'s constructor create the Panel itself when not injected (it already does — `panel ?? new Panel(...)`), and have `boot()` construct only `overlay` + `drafts`, then `new DesignMode(overlay, undefined, drafts)`, then `overlay.attachPanel(mode.panelRoot)` where `DesignMode` exposes `get panelRoot(): HTMLElement { return this.panel.root }`. Implement THAT version (add the `panelRoot` getter; tests may keep injecting their own panel). Final `boot()`:

```ts
function boot(): void {
  const overlay = new Overlay()
  overlay.mount()
  const mode = new DesignMode(overlay)
  overlay.attachPanel(mode.panelRoot)
  window.__DESIGN_COMPANION__ = { mode }
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test` (root — typecheck + vitest)
Expected: typecheck clean; all tests pass (≈66: 57 + new selection tests, minus 1 removed).

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/client/index.ts packages/vite-plugin/tests/client/design-mode.test.ts
git commit -m "feat: retained selection, scroll-tracked outlines, escape order, draft status wiring"
```

---

### Task 6: Fixture polish + real-browser E2E verification

**Files:**
- Modify: `fixtures/demo-app/src/App.tsx` (add a second card so multi-element drafts are exercisable)
- Verification only otherwise.

**Interfaces:** none — this task proves the milestone end-to-end.

- [ ] **Step 1: Extend the fixture**

In `fixtures/demo-app/src/App.tsx`, duplicate the card with different content (wrap both in a flex row):

```tsx
export default function App() {
  return (
    <main className="min-h-screen bg-neutral-100 p-8 font-sans">
      <div className="mx-auto flex max-w-3xl gap-6">
        <div className="flex-1 rounded-xl bg-white p-6 shadow-sm">
          <h1 className="text-lg font-medium text-neutral-900">Vitality</h1>
          <p className="mt-1 text-sm text-neutral-500">Tier 7 · 173 total</p>
          <button
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2.5 text-sm text-white"
            onClick={() => alert('app click handler fired')}
          >
            Add mod
          </button>
        </div>
        <div className="flex-1 rounded-xl bg-white p-6 shadow-sm">
          <h1 className="text-lg font-medium text-neutral-900">Recovery</h1>
          <p className="mt-1 text-sm text-neutral-500">Tier 4 · 92 total</p>
          <button
            className="mt-4 rounded-lg bg-neutral-200 px-4 py-2.5 text-sm text-neutral-900"
            onClick={() => alert('second card click')}
          >
            Add mod
          </button>
        </div>
      </div>
    </main>
  )
}
```

- [ ] **Step 2: Run the automated gates**

Run: `npm test && ./scripts/check-prod-clean.sh`
Expected: typecheck clean, all tests pass, `PASS: production build is clean`

- [ ] **Step 3: Manual browser verification checklist (controller runs this in a real browser)**

`npm run dev -w demo-app`, open the URL, toggle Design mode:

1. Click the first button → panel appears with Size/Padding/Margin/Appearance sections populated with real px values.
2. Scrub the PY label left/right → button padding visibly changes live, 60fps-smooth, selection outline grows with it.
3. Type a radius value → corners change; expand ⋯ → set only TL → only that corner changes.
4. Opacity 50 → element goes half-transparent.
5. Edit both cards → status strip shows "2 drafts"; Before/After flips BOTH cards between original and drafted look; per-panel Compare flips only the selected one.
6. Reset (panel) restores the selected element; Reset all restores everything and hides the strip.
7. Scroll the page with an element selected → selection outline tracks it.
8. Escape once deselects, again exits; drafts remain visible after exit; re-entering design mode shows the strip again.
9. React HMR still works with drafts applied (edit App.tsx text; note: React may re-render and drop inline styles on the edited subtree — observe and record actual behavior; it informs M3's verifier design, not a bug to fix now).

- [ ] **Step 4: Commit**

```bash
git add fixtures/demo-app/src/App.tsx
git commit -m "feat: second fixture card for multi-element draft testing"
```

---

## Self-Review

- **Spec coverage:** §5 Draft state + before/after toggle (per-element and global) → Tasks 1, 3, 5; §6 v1 rows subset for M2a (size, padding, margin, per-corner radius, opacity; numeric scrubbing) → Tasks 2–3; §10 idle-zero + framework-bypass previews → Tasks 1, 5 (listener tests updated); final-review carry-overs (retained selection, Escape stopPropagation, scroll tracking, instance handle) → Task 5. Typography/fill/stroke/layout/min-max/multi-select → M2b by design.
- **Placeholder scan:** clean — every step has complete code; Task 5 Step 3 explicitly resolves its own boot-wiring alternative (the `panelRoot` getter version is the one to implement).
- **Type consistency:** `DraftStore` API used by Panel/DesignMode matches Task 1's exports; `NumberField` opts match Task 2; `Overlay` additions in Task 4 match Task 5's call sites; `TaggedElement` used throughout.
