// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NumberField, evaluateExpression } from '../../src/client/controls'

beforeEach(() => {
  document.body.innerHTML = ''
})

function make(
  opts: Partial<{
    min: number
    max: number
    allowAuto: boolean
    onKeyword: (kw: 'auto') => void
    onRelative: (apply: (current: number) => number) => void
    onScrubStart: () => void
    onDetach: () => void
    onTokenKey: () => void
  }> = {}
) {
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

  it('tracks the drag correctly when onInput feeds back into set() (panel refresh loop)', () => {
    const nf = new NumberField({
      label: 'W',
      min: 0,
      onInput: (v) => nf.set(v), // simulates Panel.refresh() round-tripping the committed value
    })
    document.body.appendChild(nf.root)
    const label = nf.root.querySelector('.nf-label')! as HTMLElement
    const input = nf.root.querySelector('input')!
    nf.set(20)
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 110 }))
    expect(input.value).toBe('30')
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 120 }))
    expect(input.value).toBe('40') // anchored to drag start — no snap-back, no double-count
    window.dispatchEvent(new MouseEvent('mouseup', {}))
  })
})

describe('evaluateExpression', () => {
  it('evaluates a standalone expression', () => {
    expect(evaluateExpression('60+12', null)).toBe(72)
  })

  it('applies a leading-operator expression to the current value', () => {
    expect(evaluateExpression('*2', 8)).toBe(16)
  })

  it('evaluates parens and precedence', () => {
    expect(evaluateExpression('(100/2)+6', null)).toBe(56)
  })

  it('leading-operator expression with null current returns null', () => {
    expect(evaluateExpression('+8', null)).toBeNull()
  })

  it('returns null for malformed expressions', () => {
    expect(evaluateExpression('2**3', null)).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(evaluateExpression('hello', null)).toBeNull()
  })

  it('returns null for division by zero', () => {
    expect(evaluateExpression('5/0', null)).toBeNull()
  })

  it('parses a plain number', () => {
    expect(evaluateExpression('42', null)).toBe(42)
  })

  it('tolerates surrounding whitespace in a standalone expression', () => {
    expect(evaluateExpression(' 60 + 12 ', null)).toBe(72)
  })
})

describe('NumberField v2 — math expressions', () => {
  it('typed expression commits the evaluated result via onInput', () => {
    const { onInput, input } = make()
    input.value = '12*2'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).toHaveBeenCalledWith(24)
    expect(input.value).toBe('24')
  })

  it('typed leading-operator expression applies to current value', () => {
    const { nf, onInput, input } = make()
    nf.set(10)
    input.value = '+8'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).toHaveBeenCalledWith(18)
    expect(input.value).toBe('18')
  })

  it('reverts on an expression that evaluates to null', () => {
    const { nf, onInput, input } = make()
    nf.set(10)
    input.value = '5/0'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).not.toHaveBeenCalled()
    expect(input.value).toBe('10')
  })
})

describe('NumberField v2 — Mixed and auto', () => {
  it('setMixed() displays literal Mixed and get() reports null', () => {
    const { nf, input } = make()
    nf.set(10)
    nf.setMixed()
    expect(input.value).toBe('Mixed')
    expect(nf.get()).toBeNull()
  })

  it('setAuto() displays literal auto when allowAuto', () => {
    const { nf, input } = make({ allowAuto: true })
    nf.setAuto()
    expect(input.value).toBe('auto')
    expect(nf.get()).toBeNull()
  })

  it('typing auto in an allowAuto field fires onKeyword and displays auto, without firing onInput', () => {
    const onKeyword = vi.fn()
    const { onInput, input } = make({ allowAuto: true, onKeyword })
    input.value = '  Auto  '
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onKeyword).toHaveBeenCalledWith('auto')
    expect(input.value).toBe('auto')
    expect(onInput).not.toHaveBeenCalled()
  })

  it('scrubbing from Mixed state starts at 0 (clamped by min)', () => {
    const { nf, onInput, label } = make({ min: 0 })
    nf.setMixed()
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 58 }))
    expect(onInput).toHaveBeenLastCalledWith(8)
    window.dispatchEvent(new MouseEvent('mouseup', {}))
  })

  it('scrubbing from auto state starts at 0 (clamped by min)', () => {
    const { nf, onInput, label } = make({ min: 0, allowAuto: true })
    nf.setAuto()
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 58 }))
    expect(onInput).toHaveBeenLastCalledWith(8)
    window.dispatchEvent(new MouseEvent('mouseup', {}))
  })

  it('Mixed and auto displays survive an unedited blur', () => {
    const { nf, input } = make({ allowAuto: true })
    nf.setMixed()
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(input.value).toBe('Mixed')
    nf.setAuto()
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(input.value).toBe('auto')
    expect(nf.get()).toBeNull()
  })

  it('garbage input from a Mixed field reverts back to "Mixed", not a blank field', () => {
    const { nf, onInput, input } = make()
    nf.setMixed()
    input.value = 'garbage'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).not.toHaveBeenCalled()
    expect(input.value).toBe('Mixed')
    expect(nf.get()).toBeNull()
  })

  it('a failed expression from an auto field reverts back to "auto", not a blank field', () => {
    const { nf, onInput, input } = make({ allowAuto: true })
    nf.setAuto()
    input.value = '+8' // leading-operator expression against a null current -> null result
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).not.toHaveBeenCalled()
    expect(input.value).toBe('auto')
    expect(nf.get()).toBeNull()
  })
})

describe('NumberField v3 — destroy()', () => {
  it('removes scrub window listeners; a mousemove/mouseup after destroy commits nothing', () => {
    const { nf, onInput, label } = make({ min: 0 })
    nf.set(20)
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    nf.destroy()
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150 }))
    expect(onInput).not.toHaveBeenCalled()
    window.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(onInput).not.toHaveBeenCalled()
  })

  it('is idempotent — calling destroy twice does not throw', () => {
    const { nf, label } = make()
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, bubbles: true }))
    expect(() => {
      nf.destroy()
      nf.destroy()
    }).not.toThrow()
  })
})

describe('NumberField v3 — Escape key', () => {
  it('blurs the input and stops propagation so a bubble-phase parent listener never sees it', () => {
    const { nf, input } = make()
    nf.set(10)
    input.focus()
    expect(document.activeElement).toBe(input)
    const parentHandler = vi.fn()
    // A bubble-phase listener on an ancestor is the achievable, in-scope contract: the
    // input's own stopPropagation() prevents the event from reaching listeners further up
    // the bubble path. (DesignMode's real Escape handler is registered on `document` in the
    // CAPTURE phase, which — per the DOM event model — always runs before any listener on a
    // descendant fires, so no amount of stopPropagation() at the input can suppress it; that
    // is a separate, pre-existing gap in index.ts's onKey, out of scope for this task.)
    input.parentElement!.addEventListener('keydown', parentHandler)
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(parentHandler).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(input)
  })

  it('reverts garbage text on Escape via the normal blur/change-revert path', () => {
    const { nf, input } = make()
    nf.set(10)
    input.focus()
    input.value = 'garbage'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(input.value).toBe('10')
  })
})

describe('NumberField v3 — onRelative', () => {
  it('leading-operator expression calls onRelative, not onInput; closure applies math with clamp at min', () => {
    const onRelative = vi.fn()
    const { onInput, input } = make({ min: 0, onRelative })
    input.value = '+8'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).not.toHaveBeenCalled()
    expect(onRelative).toHaveBeenCalledTimes(1)
    const apply = onRelative.mock.calls[0][0] as (c: number) => number
    expect(apply(10)).toBe(18)
    expect(apply(-100)).toBe(0) // -100 + 8 = -92, clamped to min 0
  })

  it('plain numbers still hit onInput even when onRelative is set', () => {
    const onRelative = vi.fn()
    const { onInput, input } = make({ onRelative })
    input.value = '42'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).toHaveBeenCalledWith(42)
    expect(onRelative).not.toHaveBeenCalled()
  })

  it('standalone expressions still hit onInput even when onRelative is set', () => {
    const onRelative = vi.fn()
    const { onInput, input } = make({ onRelative })
    input.value = '60+12'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).toHaveBeenCalledWith(72)
    expect(onRelative).not.toHaveBeenCalled()
  })

  it('bare negative number (leading-op caveat) routes to onRelative when set', () => {
    const onRelative = vi.fn()
    const { onInput, input } = make({ onRelative })
    input.value = '-8'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onInput).not.toHaveBeenCalled()
    expect(onRelative).toHaveBeenCalledTimes(1)
    const apply = onRelative.mock.calls[0][0] as (c: number) => number
    expect(apply(10)).toBe(2)
  })
})

describe('NumberField v3 — relative scrub', () => {
  it('onScrubStart fires on label mousedown before any move', () => {
    const onScrubStart = vi.fn()
    const { label } = make({ onScrubStart })
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    expect(onScrubStart).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new MouseEvent('mouseup', {}))
  })

  it('when onRelative is set, mousemove calls onRelative with a baseline-based closure instead of committing directly', () => {
    const onRelative = vi.fn()
    const { onInput, label } = make({ onRelative })
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 115 }))
    expect(onInput).not.toHaveBeenCalled()
    expect(onRelative).toHaveBeenCalledTimes(1)
    const apply = onRelative.mock.calls[0][0] as (baseline: number) => number
    expect(apply(50)).toBe(65) // baseline + delta(15)
    window.dispatchEvent(new MouseEvent('mouseup', {}))
  })

  it('each move replaces the previous closure effect against the caller baseline (idempotent per-move)', () => {
    const onRelative = vi.fn()
    const { label } = make({ onRelative })
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 110 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 130 }))
    const lastApply = onRelative.mock.calls[onRelative.mock.calls.length - 1][0] as (b: number) => number
    expect(lastApply(50)).toBe(80) // baseline + total delta (30), not cumulative from prior move
    window.dispatchEvent(new MouseEvent('mouseup', {}))
  })

  it('non-relative scrub (no onRelative) behaves exactly as before', () => {
    const { nf, onInput, label } = make({ min: 0 })
    nf.set(20)
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 115 }))
    expect(onInput).toHaveBeenLastCalledWith(35)
    window.dispatchEvent(new MouseEvent('mouseup', {}))
  })
})

describe('NumberField v3 — pill API', () => {
  it('bindToken() makes the input readOnly, sets its value to the label, and adds the nf-pill class', () => {
    const { nf, input } = make()
    nf.set(10)
    nf.bindToken('$spacing-lg')
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('$spacing-lg')
    expect(nf.root.classList.contains('nf-pill')).toBe(true)
    expect(nf.get()).toBe(10) // lastValid untouched
  })

  it('detach() removes readOnly + class and re-renders lastValid', () => {
    const { nf, input } = make()
    nf.set(10)
    nf.bindToken('$spacing-lg')
    nf.detach()
    expect(input.readOnly).toBe(false)
    expect(nf.root.classList.contains('nf-pill')).toBe(false)
    expect(input.value).toBe('10')
  })

  it('Backspace while pill-bound calls onDetach then detaches', () => {
    const onDetach = vi.fn()
    const { nf, input } = make({ onDetach })
    nf.set(10)
    nf.bindToken('$spacing-lg')
    const ev = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(onDetach).toHaveBeenCalledTimes(1)
    expect(input.readOnly).toBe(false)
    expect(nf.root.classList.contains('nf-pill')).toBe(false)
  })

  it('Delete while pill-bound calls onDetach then detaches', () => {
    const onDetach = vi.fn()
    const { nf, input } = make({ onDetach })
    nf.set(10)
    nf.bindToken('$spacing-lg')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    expect(onDetach).toHaveBeenCalledTimes(1)
    expect(nf.root.classList.contains('nf-pill')).toBe(false)
  })

  it('set() while pill-bound clears the pill', () => {
    const { nf, input } = make()
    nf.set(10)
    nf.bindToken('$spacing-lg')
    nf.set(42)
    expect(input.readOnly).toBe(false)
    expect(nf.root.classList.contains('nf-pill')).toBe(false)
    expect(input.value).toBe('42')
  })

  it('setMixed() while pill-bound clears the pill', () => {
    const { nf, input } = make()
    nf.bindToken('$spacing-lg')
    nf.setMixed()
    expect(input.readOnly).toBe(false)
    expect(nf.root.classList.contains('nf-pill')).toBe(false)
    expect(input.value).toBe('Mixed')
  })

  it('setAuto() while pill-bound clears the pill', () => {
    const { nf, input } = make({ allowAuto: true })
    nf.bindToken('$spacing-lg')
    nf.setAuto()
    expect(input.readOnly).toBe(false)
    expect(nf.root.classList.contains('nf-pill')).toBe(false)
    expect(input.value).toBe('auto')
  })

  it('bindToken() sets the input title to the token label (spec: long tokens never silently clip)', () => {
    const { nf, input } = make()
    nf.set(10)
    nf.bindToken('spacing-2.5')
    expect(input.title).toBe('spacing-2.5')
  })

  it('detach() clears the title', () => {
    const { nf, input } = make()
    nf.set(10)
    nf.bindToken('spacing-2.5')
    nf.detach()
    expect(input.title).toBe('')
  })

  it('set() while pill-bound clears the title', () => {
    const { nf, input } = make()
    nf.set(10)
    nf.bindToken('spacing-2.5')
    nf.set(42)
    expect(input.title).toBe('')
  })

  it('setMixed() while pill-bound clears the title', () => {
    const { nf, input } = make()
    nf.bindToken('spacing-2.5')
    nf.setMixed()
    expect(input.title).toBe('')
  })

  it('setAuto() while pill-bound clears the title', () => {
    const { nf, input } = make({ allowAuto: true })
    nf.bindToken('spacing-2.5')
    nf.setAuto()
    expect(input.title).toBe('')
  })
})

describe('NumberField — onTokenKey (`=` opens token picker)', () => {
  it('`=` keydown fires onTokenKey and prevents default when not pill-bound', () => {
    const onTokenKey = vi.fn()
    const { input } = make({ onTokenKey })
    const ev = new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(onTokenKey).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('`=` keydown while pill-bound does nothing (no onTokenKey call)', () => {
    const onTokenKey = vi.fn()
    const { nf, input } = make({ onTokenKey })
    nf.set(10)
    nf.bindToken('p-4')
    const ev = new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(onTokenKey).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('`=` keydown without onTokenKey wired is a harmless no-op', () => {
    const { input } = make()
    const ev = new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true })
    expect(() => input.dispatchEvent(ev)).not.toThrow()
  })
})
