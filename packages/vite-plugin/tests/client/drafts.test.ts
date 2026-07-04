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

  it('applying while comparing reapplies ALL drafted properties, not just the edited one', () => {
    const store = new DraftStore()
    const d = el()
    store.apply(d, 'width', '100px')
    store.apply(d, 'height', '50px')
    store.compare(d, true)
    expect(d.style.getPropertyValue('height')).toBe('')
    store.apply(d, 'width', '120px')
    expect(d.style.getPropertyValue('width')).toBe('120px')
    expect(d.style.getPropertyValue('height')).toBe('50px')
  })

  it('entries() exposes elements with per-prop original and value', () => {
    const store = new DraftStore()
    const d = el()
    d.style.setProperty('width', '50px')
    store.apply(d, 'width', '100px')
    const entries = store.entries()
    expect(entries.size).toBe(1)
    expect(entries.get(d)!.get('width')).toEqual({ original: '50px', value: '100px' })
  })
})
