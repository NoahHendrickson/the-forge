# Panel Input Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the four 2026-07-07 panel refinements — comma per-side values in multi-prop number fields, a disabled align-self preview when its toggle is off, the W/H sizing chevron moved inside the input box, and removal of the Baseline toggle.

**Architecture:** All changes live in the browser overlay client (`packages/the-forge/src/client/`). Pure shorthand helpers + a new `'values'` display state land in `controls.ts` (NumberField); the panel wires them per multi-prop RowSpec in `panel.ts`; the align preview touches `layout-controls.ts` (SegmentField) + `panel-layout.ts`; the chevron and baseline changes are `panel.ts`/`panel-layout.ts` markup + `overlay.ts` CSS. No server, request-builder, or MCP changes.

**Tech Stack:** TypeScript, vanilla DOM (no React in the overlay), vitest + jsdom, tsup build.

**Spec:** [docs/specs/2026-07-07-panel-input-polish-design.md](../specs/2026-07-07-panel-input-polish-design.md)

## Global Constraints

- Zero new runtime dependencies (`@babel/parser` + `magic-string` only, and those are build-side).
- Panel/overlay CSS class names are test hooks — **extend, don't rename** (`.nf`, `.size-row`, `.menu-btn`, `[data-align-self]`, `.seg-*` all survive).
- CSS-string comments in `overlay.ts` are bundle bytes (guard-tested) — why-comments go in JS comments BETWEEN string segments, never inside the strings.
- Why-comments are load-bearing project memory — preserve verbatim when moving code.
- Package budget: 250KB (`./scripts/check-prod-clean.sh`); merged tree is ~233KB.
- jsdom cannot see flex layout or real computed styles — Task 7's real-browser E2E is part of the merge gate, not optional.
- All commands run from `packages/the-forge/` unless noted. Full gate is `npm test` at the **repo root**.
- Single test file: `npx vitest run tests/client/controls.test.ts` (from `packages/the-forge/`).
- New buttons/selects go through `src/client/ui/` factories — this plan adds none (the menu button already exists).

---

### Task 1: Shorthand helpers (`expandShorthand` / `compressShorthand`)

**Files:**
- Modify: `packages/the-forge/src/client/controls.ts` (add two exported functions, near `evaluateExpression`)
- Test: `packages/the-forge/tests/client/controls.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `expandShorthand(values: number[], count: number): number[] | null` and `compressShorthand(values: number[]): number[]` — Task 2 calls both from inside NumberField; Task 1 exports them from `controls.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/controls.test.ts` (imports at top become `import { NumberField, evaluateExpression, expandShorthand, compressShorthand } from '../../src/client/controls'`):

```ts
describe('expandShorthand', () => {
  it('fills a single value to the prop count', () => {
    expect(expandShorthand([16], 2)).toEqual([16, 16])
    expect(expandShorthand([16], 4)).toEqual([16, 16, 16, 16])
  })

  it('passes a full-length list through', () => {
    expect(expandShorthand([16, 8], 2)).toEqual([16, 8])
    expect(expandShorthand([16, 8, 4, 2], 4)).toEqual([16, 8, 4, 2])
  })

  it('expands 2 and 3 values on a 4-prop row per CSS shorthand rules', () => {
    expect(expandShorthand([16, 8], 4)).toEqual([16, 8, 16, 8])
    expect(expandShorthand([16, 8, 4], 4)).toEqual([16, 8, 4, 8])
  })

  it('rejects empty, over-length, and 3-on-2 lists', () => {
    expect(expandShorthand([], 2)).toBeNull()
    expect(expandShorthand([1, 2, 3], 2)).toBeNull()
    expect(expandShorthand([1, 2, 3, 4, 5], 4)).toBeNull()
  })
})

describe('compressShorthand', () => {
  it('keeps fully-distinct values', () => {
    expect(compressShorthand([16, 8, 4, 2])).toEqual([16, 8, 4, 2])
    expect(compressShorthand([16, 8])).toEqual([16, 8])
  })

  it('drops trailing redundancy in CSS shorthand order', () => {
    expect(compressShorthand([16, 8, 4, 8])).toEqual([16, 8, 4])
    expect(compressShorthand([16, 8, 16, 8])).toEqual([16, 8])
    expect(compressShorthand([16, 16, 16, 16])).toEqual([16])
    expect(compressShorthand([16, 16])).toEqual([16])
  })

  it('round-trips through expandShorthand', () => {
    for (const v of [[16, 8, 4, 2], [16, 8, 16, 8], [16, 8, 4, 8], [7, 7, 7, 7]]) {
      expect(expandShorthand(compressShorthand(v), 4)).toEqual(v)
    }
    for (const v of [[16, 8], [9, 9]]) {
      expect(expandShorthand(compressShorthand(v), 2)).toEqual(v)
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/controls.test.ts`
Expected: FAIL — `expandShorthand` is not exported.

- [ ] **Step 3: Implement the helpers**

In `src/client/controls.ts`, after the `ExprParser` class (before `const MIXED_TEXT`):

```ts
/**
 * CSS-shorthand expansion for comma-entered per-side values (2026-07-07 panel-input-polish
 * spec). `count` is the row's prop count (2 or 4). Returns null when the list can't expand:
 * empty, longer than count, or a 3-value list on a 2-prop row (only 4-prop rows have CSS
 * 3-value semantics). 4-prop rules match the border-radius shorthand:
 * [a] → a,a,a,a · [a,b] → a,b,a,b · [a,b,c] → a,b,c,b.
 */
export function expandShorthand(values: number[], count: number): number[] | null {
  if (values.length === 0 || values.length > count) return null
  if (values.length === count) return [...values]
  if (values.length === 1) return new Array(count).fill(values[0])
  if (count === 4 && values.length === 2) return [values[0], values[1], values[0], values[1]]
  if (count === 4 && values.length === 3) return [values[0], values[1], values[2], values[1]]
  return null
}

/**
 * Shortest round-trippable comma form of per-side values — the display half of the same
 * grammar (whatever this renders, expandShorthand restores). Drops trailing redundancy in
 * CSS shorthand order: last==2nd, then 3rd==1st, then 2nd==1st.
 */
export function compressShorthand(values: number[]): number[] {
  const out = [...values]
  if (out.length === 4 && out[3] === out[1]) out.pop()
  if (out.length === 3 && out[2] === out[0]) out.pop()
  if (out.length === 2 && out[1] === out[0]) out.pop()
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/controls.test.ts`
Expected: PASS (all new + existing).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/controls.ts packages/the-forge/tests/client/controls.test.ts
git commit -m "feat(client): CSS-shorthand expand/compress helpers for per-side comma values"
```

---

### Task 2: NumberField `'values'` display state + comma entry

**Files:**
- Modify: `packages/the-forge/src/client/controls.ts` (NumberFieldOpts, NumberField)
- Test: `packages/the-forge/tests/client/controls.test.ts`

**Interfaces:**
- Consumes: `expandShorthand` / `compressShorthand` from Task 1.
- Produces (Task 3 relies on these exact names):
  - `NumberFieldOpts.valuesCount?: number`
  - `NumberFieldOpts.onValuesInput?: (values: number[]) => void`
  - `NumberField.setValues(values: number[]): void`

Behavior contract: `setValues` renders the compressed comma form and reports `get() === null`; a typed comma list expands + clamps and fires `onValuesInput` with the FULL per-prop list; invalid comma entry reverts to the prior comma display; arrows and label-scrub step each side independently (single-select path — the multi-select `onRelative` path is untouched and takes precedence); any `set/setMixed/setAuto/bindToken` clears the values state.

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/controls.test.ts`. Note `make()` spreads opts into the NumberField constructor, so `valuesCount`/`onValuesInput` pass through once added to its Partial type — extend the `make` helper's opts type with `valuesCount: number` and `onValuesInput: (values: number[]) => void`.

```ts
describe('NumberField values state (comma per-side)', () => {
  function makeValues(count: number, extra: Parameters<typeof make>[0] = {}) {
    const onValuesInput = vi.fn()
    const made = make({ min: 0, valuesCount: count, onValuesInput, ...extra })
    return { ...made, onValuesInput }
  }

  it('setValues renders the compressed comma form and get() reports null', () => {
    const { nf, input } = makeValues(4)
    nf.setValues([16, 8, 16, 8])
    expect(input.value).toBe('16,8')
    expect(nf.get()).toBeNull()
  })

  it('typed comma list expands, clamps, re-renders, and fires onValuesInput', () => {
    const { onValuesInput, onInput, input } = makeValues(4)
    input.value = '16,8,4'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onValuesInput).toHaveBeenCalledWith([16, 8, 4, 8])
    expect(onInput).not.toHaveBeenCalled()
    expect(input.value).toBe('16,8,4')
  })

  it('clamps each side to min/max', () => {
    const { onValuesInput, input } = makeValues(2)
    input.value = '-4,8'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onValuesInput).toHaveBeenCalledWith([0, 8]) // min: 0
  })

  it('accepts negative literals when min allows (margins)', () => {
    const onValuesInput = vi.fn()
    const { input } = make({ valuesCount: 2, onValuesInput })
    input.value = '-4,8'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onValuesInput).toHaveBeenCalledWith([-4, 8])
  })

  it('invalid comma entry reverts to the prior comma display', () => {
    const { nf, onValuesInput, input } = makeValues(2)
    nf.setValues([16, 8])
    input.value = '1,2,3' // 3-on-2: invalid
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onValuesInput).not.toHaveBeenCalled()
    expect(input.value).toBe('16,8')
    input.value = '16,abc'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(input.value).toBe('16,8')
  })

  it('expressions are rejected inside comma lists', () => {
    const { nf, onValuesInput, input } = makeValues(2)
    nf.setValues([16, 8])
    input.value = '+4,8'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onValuesInput).not.toHaveBeenCalled()
    expect(input.value).toBe('16,8')
  })

  it('a comma in a field without valuesCount stays garbage → revert', () => {
    const { nf, onInput, input } = make()
    nf.set(10)
    input.value = '16,8'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).not.toHaveBeenCalled()
    expect(input.value).toBe('10')
  })

  it('ArrowUp/ArrowDown step each side independently in values state', () => {
    const { nf, onValuesInput, input } = makeValues(2)
    nf.setValues([16, 8])
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(onValuesInput).toHaveBeenCalledWith([17, 9])
    expect(input.value).toBe('17,9')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }))
    expect(onValuesInput).toHaveBeenLastCalledWith([7, 0]) // 17-10, max(0, 9-10)
  })

  it('label scrub moves each side by the drag delta from its own start value', () => {
    const { nf, onValuesInput, label } = makeValues(2)
    nf.setValues([16, 8])
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 110 }))
    expect(onValuesInput).toHaveBeenLastCalledWith([26, 18])
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 90 })) // replaces, not accumulates
    expect(onValuesInput).toHaveBeenLastCalledWith([6, 0])
    window.dispatchEvent(new MouseEvent('mouseup', {}))
  })

  it('an unedited blur of the comma text keeps the display', () => {
    const { nf, onValuesInput, input } = makeValues(2)
    nf.setValues([16, 8])
    input.dispatchEvent(new Event('change', { bubbles: true })) // value untouched
    expect(onValuesInput).not.toHaveBeenCalled()
    expect(input.value).toBe('16,8')
  })

  it('set() clears the values state (stale per-side baselines cannot leak)', () => {
    const { nf, onValuesInput, input, label } = makeValues(2)
    nf.setValues([16, 8])
    nf.set(12)
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 105 }))
    window.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(onValuesInput).not.toHaveBeenCalled() // absolute scrub path used instead
    expect(input.value).toBe('17')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/controls.test.ts`
Expected: FAIL — `setValues is not a function` (and TS errors on the new opts until implemented).

- [ ] **Step 3: Implement in `controls.ts`**

3a. Add to `NumberFieldOpts` (after `onTokenOpen`/`noTokenButton`):

```ts
  /** Number of per-side props behind this field (2 or 4 — 2026-07-07 panel-input-polish
   * spec). Enables comma-list entry (lists expand CSS-shorthand-style to this count via
   * expandShorthand) and the setValues display state. Single-prop callers leave it unset —
   * a comma there stays garbage → revert. */
  valuesCount?: number
  /** Fired with the FULLY EXPANDED, clamped per-prop list (one entry per prop, in the
   * row's props order) after a comma entry, per-side arrow step, or per-side scrub —
   * the caller never re-derives shorthand. */
  onValuesInput?: (values: number[]) => void
```

3b. Add state fields next to `displayState`:

```ts
  private displayState: 'number' | 'mixed' | 'auto' | 'values' = 'number'
  // Per-side values behind a 'values' display — the baseline for per-side arrows/scrub.
  private lastValues: number[] | null = null
  // Snapshot of lastValues at scrub mousedown (same frozen-baseline contract as scrubStartValue).
  private scrubStartValues: number[] | null = null
```

3c. In the `keydown` handler, after `const step = ...` and before `const base = ...`:

```ts
      if (this.displayState === 'values' && this.lastValues && this.opts.onValuesInput) {
        // Per-side stepping — the absolute path below would parseFloat('16,8') → 16 and
        // collapse the variance to one number for every side.
        const stepped = this.lastValues.map((v) => this.clamp(v + step))
        this.setValues(stepped)
        this.opts.onValuesInput(stepped)
        return
      }
```

3d. In the label `mousedown` handler, after `this.scrubStartValue = this.lastValid ?? 0`:

```ts
      this.scrubStartValues = this.displayState === 'values' && this.lastValues ? [...this.lastValues] : null
```

3e. In `onScrub`, after the `if (this.opts.onRelative) { ... return }` block (the multi-select relative path keeps precedence) and before the absolute `this.commit(...)` line:

```ts
    if (this.scrubStartValues && this.opts.onValuesInput) {
      // Values-state scrub: each side moves by the same drag delta from ITS OWN frozen
      // start value — the absolute commit below would overwrite every side with one number.
      const moved = this.scrubStartValues.map((v) => this.clamp(v + (e.clientX - this.scrubStartX)))
      this.setValues(moved)
      this.opts.onValuesInput(moved)
      return
    }
```

3f. In `handleChange`, add an unedited-blur guard after the existing mixed/auto guards:

```ts
    if (this.displayState === 'values' && this.lastValues && trimmed === compressShorthand(this.lastValues).join(',')) {
      return
    }
```

…and the comma path after the `allowAuto` keyword block, BEFORE the plain-number fast path:

```ts
    // Comma list = per-side values (2026-07-07 spec). Segments are plain decimal literals
    // (negatives allowed — margins), never expressions; the list expands CSS-shorthand-style
    // to the row's prop count and clamps per side. Checked before the number/expression
    // paths so a comma never half-parses as either.
    if (this.opts.valuesCount !== undefined && this.opts.onValuesInput && trimmed.includes(',')) {
      const segments = trimmed.split(',').map((s) => s.trim())
      if (segments.every((s) => /^-?\d+(\.\d+)?$/.test(s))) {
        const expanded = expandShorthand(segments.map(Number.parseFloat), this.opts.valuesCount)
        if (expanded !== null) {
          const clamped = expanded.map((v) => this.clamp(v))
          this.setValues(clamped)
          this.opts.onValuesInput(clamped)
          return
        }
      }
      this.revert()
      return
    }
```

3g. Extend `revert()` (values branch before the render fallback):

```ts
  private revert(): void {
    if (this.displayState === 'mixed') this.setMixed()
    else if (this.displayState === 'auto') this.setAuto()
    else if (this.displayState === 'values' && this.lastValues) this.setValues(this.lastValues)
    else this.render(this.lastValid)
  }
```

3h. Add `setValues` next to `setMixed`, and clear `lastValues` in every other display mutation — add `this.lastValues = null` inside `render()`, `setMixed()`, and `setAuto()` (bindToken keeps pill semantics; it calls none of these, so also add `this.lastValues = null` to `bindToken()`):

```ts
  /** Displays per-side values in shortest shorthand form (e.g. '16,8' — see
   * compressShorthand); internal value is null (get() reports null), per-side baselines
   * live in lastValues for arrows/scrub. */
  setValues(values: number[]): void {
    this.setWhisper(null)
    this.unbindPill()
    this.lastValid = null
    this.lastValues = [...values]
    this.input.value = compressShorthand(values).join(',')
    this.displayState = 'values'
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/controls.test.ts`
Expected: PASS. Then `npm run typecheck -w the-forge` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/controls.ts packages/the-forge/tests/client/controls.test.ts
git commit -m "feat(client): NumberField values display state + comma per-side entry"
```

---

### Task 3: Panel wiring — comma display in refresh, per-side commit

**Files:**
- Modify: `packages/the-forge/src/client/panel.ts` (`refresh()` mixed branch ~line 392; `buildField` ~line 980)
- Test: `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Consumes: `NumberField.setValues`, `NumberFieldOpts.valuesCount`/`onValuesInput` (Task 2).
- Produces: no new exports — behavior only. Every multi-prop RowSpec (Padding H/V, Margin H/V, Radius R, Stroke W — Stroke's field is built by this same `buildField` via the dep factory in `panel-fillstroke.ts`) gains comma display + entry automatically.

- [ ] **Step 1: Write the failing tests**

Add to `tests/client/panel.test.ts` (inside `describe('Panel')`, near the existing padding/margin tests):

```ts
  describe('comma per-side values (2026-07-07 panel-input-polish spec)', () => {
    it('differing sides display as a comma list, equal sides as one number', () => {
      const { panel } = setup(
        `<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px 16px 8px 4px; width: 200px;"></div>`
      )
      expect(fieldInput(panel, P.PX).value).toBe('4,16') // props order: left, right
      expect(fieldInput(panel, P.PY).value).toBe('8')
    })

    it('typing a comma pair drafts each side individually', () => {
      const { el, panel, drafts } = setup()
      commit(fieldInput(panel, P.PX), '16,8')
      expect(drafts.current(el, 'padding-left')).toBe('16px')
      expect(drafts.current(el, 'padding-right')).toBe('8px')
      expect(fieldInput(panel, P.PX).value).toBe('16,8')
    })

    it('radius accepts CSS 3-value shorthand and re-displays compressed', () => {
      const { el, panel, drafts } = setup()
      commit(fieldInput(panel, P.R), '16,8,4')
      expect(drafts.current(el, 'border-top-left-radius')).toBe('16px')
      expect(drafts.current(el, 'border-top-right-radius')).toBe('8px')
      expect(drafts.current(el, 'border-bottom-right-radius')).toBe('4px')
      expect(drafts.current(el, 'border-bottom-left-radius')).toBe('8px')
      expect(fieldInput(panel, P.R).value).toBe('16,8,4')
    })

    it('multi-element selection keeps Mixed but a typed comma applies per-side to every element', () => {
      const { a, b, panel, drafts } = multiSetup('padding: 10px;', 'padding: 20px;')
      expect(fieldInput(panel, P.PX).value).toBe('Mixed')
      commit(fieldInput(panel, P.PX), '16,8')
      for (const el of [a, b]) {
        expect(drafts.current(el, 'padding-left')).toBe('16px')
        expect(drafts.current(el, 'padding-right')).toBe('8px')
      }
    })
  })
```

Note: `multiSetup` is defined inside a later `describe` block — if it's out of scope where you add this, place the multi-element test inside the existing multi-select `describe` that owns `multiSetup` instead. Don't duplicate the helper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/panel.test.ts -t 'comma per-side'`
Expected: FAIL — first test sees `Mixed`, second sees no `padding-right` draft distinct from left.

- [ ] **Step 3: Implement in `panel.ts`**

3a. `refresh()` — replace the two-line mixed branch:

```ts
      const mixed = values.some((v) => v !== values[0])
      if (mixed) field.setMixed()
      else field.set(values[0])
```

with:

```ts
      const mixed = values.some((v) => v !== values[0])
      // Per-side comma display (2026-07-07 spec) is a single-element, differing-SIDES
      // affair; across ELEMENTS the field keeps the ratified Mixed text (user-ratified).
      // Non-finite reads (jsdom can't compute some values) also stay Mixed — never 'NaN,8'.
      if (mixed && !multi && spec.props.length > 1 && values.every((v) => Number.isFinite(v))) {
        field.setValues(values)
      } else if (mixed) {
        field.setMixed()
      } else {
        field.set(values[0])
      }
```

3b. `buildField` — add a per-side commit next to the existing `commit`:

```ts
    // Per-side sibling of `commit` (comma entry, 2026-07-07 spec): values arrives fully
    // expanded (one entry per prop, props order) from NumberField; each side drafts its own
    // css. Applies to EVERY element in the selection (user-ratified multi behavior).
    const commitValues = (values: number[]): void => {
      if (!this.el) return
      for (const el of this.els) {
        this.onBeforeEdit(el)
        for (let i = 0; i < spec.props.length; i++) {
          spec.onBeforeApply?.(el, spec.props[i], this.drafts)
          this.drafts.apply(el, spec.props[i], (spec.toCss ?? px)(values[i]))
        }
      }
      this.refresh()
      this.onEdited()
    }
```

…and wire it in the `new NumberField({...})` opts (after `onInput: commit,`):

```ts
      valuesCount: spec.props.length > 1 ? spec.props.length : undefined,
      onValuesInput: spec.props.length > 1 ? commitValues : undefined,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/panel.test.ts`
Expected: PASS — new tests green, no existing regressions (the old always-`setMixed` tests at the multi-select block still pass because `multi` keeps Mixed).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/panel.ts packages/the-forge/tests/client/panel.test.ts
git commit -m "feat(client): comma per-side display + entry on multi-prop panel rows"
```

---

### Task 4: Align strip disabled preview

**Files:**
- Modify: `packages/the-forge/src/client/layout-controls.ts` (SegmentField)
- Modify: `packages/the-forge/src/client/panel-layout.ts` (`refreshFlexChild`, ~lines 480–484)
- Modify: `packages/the-forge/src/client/overlay.ts` (one CSS rule after `.seg-active`)
- Test: `packages/the-forge/tests/client/layout-controls.test.ts`, `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Consumes: `normalizeAlign` (already imported in `panel-layout.ts` from `panel-readers.ts`).
- Produces: `SegmentField.setDisabled(disabled: boolean): void` — toggles `.seg-disabled` on the field root and the `disabled` attribute on track buttons.

- [ ] **Step 1: Write the failing tests**

In `tests/client/layout-controls.test.ts`, add to the SegmentField describe:

```ts
  it('setDisabled toggles .seg-disabled and disables the track buttons', () => {
    const field = new SegmentField({ label: 'A', options: [{ value: 'x', label: 'X' }], onInput: vi.fn() })
    field.setDisabled(true)
    expect(field.root.classList.contains('seg-disabled')).toBe(true)
    expect((field.root.querySelector('.seg') as HTMLButtonElement).disabled).toBe(true)
    field.setDisabled(false)
    expect(field.root.classList.contains('seg-disabled')).toBe(false)
    expect((field.root.querySelector('.seg') as HTMLButtonElement).disabled).toBe(false)
  })
```

In `tests/client/panel.test.ts`, add near the align-toggle tests (they use `childSetup()`):

```ts
  it('toggle OFF shows a disabled preview of the parent align-items (2026-07-07 spec)', () => {
    document.body.innerHTML = `<div id="parent" style="display: flex; align-items: center;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="width: 50px;"></div>
    </div>`
    const el = document.getElementById('t')! as HTMLElement
    const panel = new Panel(new DraftStore(), vi.fn())
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))
    const strip = panel.root.querySelector('[data-align-self]') as HTMLElement
    expect(strip.hidden).toBe(false)
    expect(strip.classList.contains('seg-disabled')).toBe(true)
    expect((strip.querySelector('.seg-active') as HTMLElement).dataset.value).toBe('center')
    // follows the parent live (the 9-dot matrix drafts inline styles → computed changes)
    document.getElementById('parent')!.style.alignItems = 'flex-end'
    panel.refresh()
    expect((strip.querySelector('.seg-active') as HTMLElement).dataset.value).toBe('flex-end')
  })

  it('disabled preview never lights Auto; default parent reads flex-start (matrix mapping)', () => {
    const { panel } = childSetup()
    const strip = panel.root.querySelector('[data-align-self]') as HTMLElement
    expect(strip.classList.contains('seg-disabled')).toBe(true)
    const active = strip.querySelector('.seg-active') as HTMLElement
    expect(active.dataset.value).toBe('flex-start')
  })
```

Then update the existing assertions that expected the strip HIDDEN when the toggle is off — the meaning flips to visible-but-disabled:

- `'align strip is OFF by default…'` (~line 697): replace `expect(strip.hidden).toBe(true)` with
  `expect(strip.hidden).toBe(false)` and `expect(strip.classList.contains('seg-disabled')).toBe(true)`.
- `'toggling ON reveals the strip…'` (~line 707): after the existing `expect(strip.hidden).toBe(false)`, add `expect(strip.classList.contains('seg-disabled')).toBe(false)`.
- `'toggling OFF discards a session draft…'` (~line 732): replace `expect((…'[data-align-self]'…).hidden).toBe(true)` with `expect((panel.root.querySelector('[data-align-self]') as HTMLElement).classList.contains('seg-disabled')).toBe(true)`.
- `'auto-ON when the app CSS sets align-self…'` (~line 752): same replacement as above.
- `'manual-open latch clears on selection change'` (~line 783): replace `expect(…hidden).toBe(true)` with `expect((panel.root.querySelector('[data-align-self]') as HTMLElement).classList.contains('seg-disabled')).toBe(true)`.
- `'flex-child controls are hidden when parent is not flex'` (~line 663) is UNCHANGED — a non-flex parent still hides the whole block (early return leaves the strip's initial `hidden = true`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/layout-controls.test.ts tests/client/panel.test.ts`
Expected: FAIL — `setDisabled is not a function`; the updated panel assertions fail on `hidden`.

- [ ] **Step 3: Implement**

3a. `layout-controls.ts` — add to SegmentField after `set()`:

```ts
  /** Disabled preview mode (2026-07-07 panel-input-polish spec): dims the track and blocks
   * input while the value stays driveable via set() — used by the align strip to show the
   * child's effective (parent-derived) alignment when the align-self toggle is off. */
  setDisabled(disabled: boolean): void {
    this.root.classList.toggle('seg-disabled', disabled)
    for (const button of this.buttons) (button as HTMLButtonElement).disabled = disabled
  }
```

3b. `panel-layout.ts` — in `refreshFlexChild`, replace:

```ts
    const alignSelf = this.deps.currentValue(el, 'align-self', computed)
    const on = this.alignOn(el, computed)
    this.alignToggle?.setAttribute('aria-pressed', String(on))
    if (this.alignSelfWrap) this.alignSelfWrap.hidden = !on
    if (on) this.alignSelfField?.set(alignSelf || 'auto')
```

with:

```ts
    const alignSelf = this.deps.currentValue(el, 'align-self', computed)
    const on = this.alignOn(el, computed)
    this.alignToggle?.setAttribute('aria-pressed', String(on))
    // Toggle OFF no longer hides the strip (2026-07-07 spec): it shows a DISABLED preview
    // of the child's effective alignment — the parent's align-items, which is what
    // align-self: auto resolves to and exactly what the parent's 9-dot matrix sets, so a
    // matrix edit refreshes this live. normalizeAlign keeps the preview consistent with
    // the matrix's own active-dot mapping (default/'normal' reads flex-start like the dot,
    // not CSS's effective stretch). 'baseline' (app-CSS only) matches no segment → null.
    // The Auto segment lights only when the toggle is ON with a genuine auto value.
    if (this.alignSelfWrap) this.alignSelfWrap.hidden = false
    if (on) {
      this.alignSelfField?.setDisabled(false)
      this.alignSelfField?.set(alignSelf || 'auto')
    } else {
      this.alignSelfField?.setDisabled(true)
      const parentAlign = normalizeAlign(getComputedStyle(parent as TaggedElement).getPropertyValue('align-items'))
      this.alignSelfField?.set(
        ['flex-start', 'center', 'flex-end', 'stretch'].includes(parentAlign) ? parentAlign : null
      )
    }
```

3c. `overlay.ts` — after the `.seg-active` rule (line ~277), extend that same template segment:

```
.seg-active { background: var(--control-active); color: #fff; }
.seg-disabled .seg-track { opacity: 0.5; pointer-events: none; }
```

(One added line inside the existing string — no new comment bytes needed; `disabled` on the buttons is the real gate, `pointer-events` just kills hover affordances.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/layout-controls.test.ts tests/client/panel.test.ts tests/client/design-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/layout-controls.ts packages/the-forge/src/client/panel-layout.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/layout-controls.test.ts packages/the-forge/tests/client/panel.test.ts
git commit -m "feat(client): align strip shows disabled parent-derived preview when toggle is off"
```

---

### Task 5: Sizing chevron inside the W/H input box

**Files:**
- Modify: `packages/the-forge/src/client/panel.ts` (`buildRow`, ~line 974)
- Modify: `packages/the-forge/src/client/overlay.ts` (`.nf-has-menu` rule near `.menu-btn`)
- Test: `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `.nf-has-menu` class on W/H field roots (new test hook); `.menu-btn` now lives INSIDE `.nf` (existing `openSizeMenu` helper keeps working — it queries `.menu-btn` under `.size-row`, which still contains the field).

**CRITICAL constraint:** `ui/menu.ts` positions its popover via `button.offsetTop`/`offsetLeft` resolved against `popoverHost` as the nearest positioned ancestor ("nothing between the button and the host is positioned, by contract" — menu.ts:86-89). Do NOT add `position: relative` (or any position) to `.nf`/`.nf-has-menu` — the field would become the offsetParent and strand the popover at the field's local coordinates. The chevron goes inside the box as a plain FLEX CHILD; `.nf`'s border box already IS the visual input, so no positioning is needed at all.

- [ ] **Step 1: Write the failing test**

Add to `tests/client/panel.test.ts` near the size-block tests:

```ts
  it('sizing chevron lives inside the field box (2026-07-07 panel-input-polish spec)', () => {
    const { panel } = setup()
    for (const props of [P.W, P.H]) {
      const nf = [...panel.root.querySelectorAll('.nf')].find(
        (n) => (n as HTMLElement).dataset.props === props
      ) as HTMLElement
      expect(nf.classList.contains('nf-has-menu')).toBe(true)
      expect(nf.querySelector('.menu-btn')).toBeTruthy()
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/panel.test.ts -t 'chevron lives inside'`
Expected: FAIL — no `.nf-has-menu`, `.menu-btn` is a `.size-row` sibling.

- [ ] **Step 3: Implement**

3a. `panel.ts` `buildRow` — replace `row.append(menu.button)` with:

```ts
    // Inside the field box (2026-07-07 spec): .nf's border box IS the visual input, so the
    // chevron becomes its last flex child — [label][input][whisper][chevron] — with zero
    // positioning. Load-bearing: ui/menu.ts positions the popover via offsetTop/offsetLeft
    // against popoverHost as the nearest positioned ancestor; a position on .nf would
    // silently become the offsetParent and strand the popover at the field's local coords.
    bound.field.root.classList.add('nf-has-menu')
    bound.field.root.append(menu.button)
```

3b. `overlay.ts` — extend the `.menu-btn` template segment (line ~354):

```
.nf-has-menu { padding-right: 2px; }
.nf-has-menu .menu-btn { height: 18px; align-self: center; }
```

(`.nf` pads `0 6px`; trimming the right side lets the 16px chevron nestle at the input's edge instead of floating 6px inside it. The height/align keeps the hover pill inside the 24px field instead of stretching to its full height.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/panel.test.ts`
Expected: PASS — including all existing `openSizeMenu`-based menu tests (helper still resolves `.menu-btn` under `.size-row`) and the multi-select `menuBtn.hidden` tests (the `hidden` attribute still removes it from the flex row).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/panel.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/panel.test.ts
git commit -m "feat(client): move W/H sizing chevron inside the input box"
```

---

### Task 6: Remove the Baseline toggle

**Files:**
- Modify: `packages/the-forge/src/client/panel-layout.ts` (delete toggle creation ~202–223, refresh lines ~464–466, field decl line 64, teardown line ~648, and the "baseline toggle" mention in the file's header comment)
- Modify: `packages/the-forge/src/client/overlay.ts` (delete `.baseline-toggle` rule + its comment ~283–286; update the `.matrix-tile` comment ~292–295)
- Modify: `packages/the-forge/tests/client/panel.test.ts` (delete `describe('baseline alignment')` ~565–615; add one regression test)
- Modify: `docs/research/2026-07-04-panel-patterns.md` (amendment section)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — pure deletion. `normalizeAlign` KEEPS its `baseline` vocabulary (readers stay honest; Task 4's preview maps it to no-segment).

- [ ] **Step 1: Update tests first (they define the new contract)**

Delete the whole `describe('baseline alignment', …)` block in `panel.test.ts` and add in its place:

```ts
  it('app-CSS baseline alignment lights no matrix dot (baseline is read-only since 2026-07-07)', () => {
    const { panel } = flexSetup('align-items: baseline;')
    expect(panel.root.querySelector('.am-dot.am-active')).toBeNull()
    expect(panel.root.querySelector('[data-align-baseline]')).toBeNull()
  })
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npx vitest run tests/client/panel.test.ts -t 'baseline'`
Expected: FAIL — `[data-align-baseline]` still renders.

- [ ] **Step 3: Delete the toggle**

In `panel-layout.ts`:
- Line 64: delete `private baselineToggle: HTMLButtonElement | null = null`.
- Lines 202–223: delete the whole block from the `// Figma keeps baseline out of the 9-dot matrix…` comment through `tile.append(baselineBtn)`.
- Lines 463–466: keep the `this.alignMatrix?.set(...)` line; delete the three `baselineOn`/`baselineToggle` lines after it.
- Teardown: delete `this.baselineToggle = null`.
- File header comment (line 4): drop the words "baseline toggle, " from the module description.

In `overlay.ts`:
- Delete the `.baseline-toggle` template segment AND its preceding JS comment (lines ~283–286).
- Replace the `.matrix-tile` JS comment (lines ~292–295) with:

```ts
// The tile is a centered column card around the 64px matrix (width pinned at 88px,
// height content-driven). Column layout predates the Baseline toggle's 2026-07-07
// removal and stays — a centered 88px flex ROW overflowed both edges (centered
// overflow), pushing the matrix's left dot column outside the tile (user-reported).
```

- [ ] **Step 4: Run the full client suite**

Run: `npx vitest run tests/client/`
Expected: PASS — no other suite references the toggle (verified: `data-align-baseline`/`baseline-toggle` appear only in `panel.test.ts`).

- [ ] **Step 5: Amend the ratified panel-patterns doc**

Append to `docs/research/2026-07-04-panel-patterns.md`:

```md
## Amendment — 2026-07-07 (panel-input-polish)

The Baseline toggle under the 9-dot matrix is **removed** (user-ratified, 2026-07-07
brainstorm — see docs/specs/2026-07-07-panel-input-polish-design.md). `align-items:
baseline` stays readable (`normalizeAlign` keeps the vocabulary; app-CSS baseline lights
no matrix dot and previews as no-segment in the align strip) but is no longer writable
from the panel — picking any matrix dot drafts over it.
```

- [ ] **Step 6: Commit**

```bash
git add packages/the-forge/src/client/panel-layout.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/panel.test.ts docs/research/2026-07-04-panel-patterns.md
git commit -m "feat(client): remove Baseline toggle from the matrix tile (ratified 2026-07-07)"
```

---

### Task 7: Full gate, budget, and real-browser E2E

**Files:**
- No source changes expected (fix-forward if the gate finds anything).

**Interfaces:** none — verification only.

- [ ] **Step 1: Full test + typecheck gate**

Run from the **repo root**: `npm test`
Expected: typecheck clean + full vitest suite green.

- [ ] **Step 2: Build + budget check**

```bash
npm run build
./scripts/check-prod-clean.sh
```

Expected: build succeeds; prod-clean passes; package size ≤ 250KB (baseline was ~233KB — comma/disabled additions are partially offset by the baseline-toggle deletion; report the number).

- [ ] **Step 3: Real-browser E2E on the demo app**

Kill stale dev servers first (phantom-bug gotcha; server often binds IPv6):

```bash
lsof -iTCP:5173 -sTCP:LISTEN
# kill any PID found, then start fresh (Claude Preview or:)
npm run dev -w demo-app
```

**Remember:** a dev server started before `npm run build` serves the OLD client bundle — build first, then start.

Verify in the running app (toggle Design mode bottom-right, select a card):

1. **Comma values:** select an element, type `16,8` into Padding H — both sides preview immediately (left 16 / right 8 inline styles), field re-displays `16,8`. Type `12,6,3` into Appearance's R field — corners land per CSS shorthand. Scrub the Padding H label — sides move in lockstep preserving the 8px offset.
2. **Align preview:** select a flex child with the toggle off — strip visible, dimmed, non-clickable, segment matching the parent's alignment. Select the parent, move the 9-dot matrix, reselect the child — preview follows.
3. **Chevron:** W/H fields show the chevron INSIDE the input at its right edge; text never runs under it; Hug/Fill whisper sits left of it; the menu still opens ANCHORED to the button (popover-position regression check — the offsetParent contract) and still closes on outside click/selection change.
4. **Baseline:** no Baseline button under the matrix; the tile is just the 9 dots.
5. Send one comma-produced change and confirm the queue item's markdown carries per-side utilities (e.g. `pl-4` / `pr-2`), not a single collapsed value.

- [ ] **Step 4: Screenshot + report**

Capture a screenshot of the panel showing the comma display, disabled align strip, and inset chevrons. Report budget number + E2E outcomes.

- [ ] **Step 5: Final commit (if any fixes landed)**

```bash
git add -A && git commit -m "fix(client): panel-input-polish E2E findings"
```
