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
