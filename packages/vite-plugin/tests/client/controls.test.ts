// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NumberField, evaluateExpression } from '../../src/client/controls'

beforeEach(() => {
  document.body.innerHTML = ''
})

function make(opts: Partial<{ min: number; max: number; allowAuto: boolean; onKeyword: (kw: 'auto') => void }> = {}) {
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
})
