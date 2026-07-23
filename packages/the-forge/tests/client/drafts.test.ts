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

  it('commit removes inline styles without restoring originals and forgets the element', () => {
    const store = new DraftStore()
    const d = el()
    d.style.setProperty('padding-top', '4px')
    store.apply(d, 'padding-top', '12px')
    store.commit(d)
    expect(d.style.getPropertyValue('padding-top')).toBe('') // NOT 4px — code owns it now
    expect(store.hasDrafts(d)).toBe(false)
  })

  it('commit clears compare state and fires onChange', () => {
    const store = new DraftStore()
    const d = el()
    store.apply(d, 'width', '100px')
    store.compare(d, true)
    const spy = vi.fn()
    store.onChange = spy
    store.commit(d)
    expect(store.isComparing(d)).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('commit on an element with multiple drafted properties clears all of them', () => {
    const store = new DraftStore()
    const d = el()
    store.apply(d, 'width', '100px')
    store.apply(d, 'height', '50px')
    store.commit(d)
    expect(d.style.getPropertyValue('width')).toBe('')
    expect(d.style.getPropertyValue('height')).toBe('')
    expect(store.elementCount()).toBe(0)
  })

  it('commit on an element with no drafts is a no-op', () => {
    const store = new DraftStore()
    const d = el()
    const spy = vi.fn()
    store.onChange = spy
    store.commit(d)
    expect(spy).not.toHaveBeenCalled()
  })

  it('commit(el, props) removes only the given properties, leaving other drafts intact', () => {
    const store = new DraftStore()
    const d = el()
    store.apply(d, 'padding-top', '12px')
    store.apply(d, 'margin-top', '8px')
    store.commit(d, ['padding-top'])
    expect(d.style.getPropertyValue('padding-top')).toBe('')
    expect(d.style.getPropertyValue('margin-top')).toBe('8px') // inline still applied
    expect(store.current(d, 'margin-top')).toBe('8px') // draft still tracked
    expect(store.current(d, 'padding-top')).toBeNull()
    expect(store.hasDrafts(d)).toBe(true) // element not forgotten — margin-top draft remains
  })

  it('commit(el, props) forgets the element once its last targeted property empties the map', () => {
    const store = new DraftStore()
    const d = el()
    store.apply(d, 'padding-top', '12px')
    store.commit(d, ['padding-top'])
    expect(store.hasDrafts(d)).toBe(false)
    expect(store.elementCount()).toBe(0)
  })

  it('targeted discard restores originals and keeps other drafts', () => {
    const store = new DraftStore()
    const d = el()
    d.style.setProperty('gap', '16px')
    store.apply(d, 'gap', '24px')
    store.apply(d, 'padding-top', '8px')
    store.discard(d, ['gap'])
    expect(d.style.getPropertyValue('gap')).toBe('16px')
    expect(store.current(d, 'padding-top')).toBe('8px')
    expect(store.hasDrafts(d)).toBe(true)
  })

  it('targeted discard forgets the element once its last prop empties the map', () => {
    const store = new DraftStore()
    const d = el()
    store.apply(d, 'gap', '24px')
    store.discard(d, ['gap'])
    expect(store.hasDrafts(d)).toBe(false)
    expect(store.elementCount()).toBe(0)
  })

  it('sequential targeted commits across two requests compose correctly', () => {
    const store = new DraftStore()
    const d = el()
    store.apply(d, 'padding-top', '24px')
    store.apply(d, 'margin-top', '8px')
    // request 1 committed: only padding-top
    store.commit(d, ['padding-top'])
    expect(store.hasDrafts(d)).toBe(true)
    expect(store.current(d, 'margin-top')).toBe('8px')
    expect(d.style.getPropertyValue('padding-top')).toBe('')
    expect(d.style.getPropertyValue('margin-top')).toBe('8px')
    // request 2 committed: the rest
    store.commit(d, ['margin-top'])
    expect(store.hasDrafts(d)).toBe(false)
    expect(store.elementCount()).toBe(0)
    expect(d.style.getPropertyValue('margin-top')).toBe('')
  })

  describe('structural drafts (Figma pivot P1)', () => {
    it('applyText records the original once across edits and writes the value to the DOM', () => {
      const store = new DraftStore()
      const d = el()
      d.textContent = 'Sign up'
      store.applyText(d, 'Get started')
      store.applyText(d, 'Get started now')
      expect(d.textContent).toBe('Get started now')
      expect(store.structuralOf(d)).toEqual({ kind: 'text', original: 'Sign up', value: 'Get started now' })
      store.discard(d)
      expect(d.textContent).toBe('Sign up')
      expect(store.structuralOf(d)).toBeNull()
    })

    it('applyText with the unchanged original mints no draft', () => {
      const store = new DraftStore()
      const d = el()
      d.textContent = 'Same'
      store.applyText(d, 'Same')
      expect(store.structuralOf(d)).toBeNull()
      expect(store.hasDrafts(d)).toBe(false)
    })

    it('applyDelete previews as inline display:none without creating a css draft', () => {
      const store = new DraftStore()
      const d = el()
      store.applyDelete(d)
      expect(d.style.getPropertyValue('display')).toBe('none')
      expect(store.structuralOf(d)).toEqual({ kind: 'delete', priorInlineDisplay: '' })
      expect(store.current(d, 'display')).toBeNull() // NOT a css draft — must never render as a property delta
      expect(store.changeCount()).toBe(1)
    })

    it('applyDelete discards existing css drafts (restoring originals) and replaces a text draft', () => {
      const store = new DraftStore()
      const d = el()
      d.textContent = 'Hello'
      d.style.setProperty('padding-top', '4px')
      store.apply(d, 'padding-top', '12px')
      store.applyText(d, 'Goodbye')
      store.applyDelete(d)
      expect(d.style.getPropertyValue('padding-top')).toBe('4px') // css original restored
      expect(d.textContent).toBe('Hello') // text original restored under the tombstone
      expect(store.structuralOf(d)).toEqual({ kind: 'delete', priorInlineDisplay: '' })
      expect(store.changeCount()).toBe(1)
    })

    it('discard after delete restores the prior inline display exactly', () => {
      const store = new DraftStore()
      const d = el()
      d.style.setProperty('display', 'inline-flex')
      store.applyDelete(d)
      store.discard(d)
      expect(d.style.getPropertyValue('display')).toBe('inline-flex')
      const bare = el()
      store.applyDelete(bare)
      store.discard(bare)
      expect(bare.style.getPropertyValue('display')).toBe('') // empty prior restores to no inline value
    })

    it('applyText on a delete-drafted element is a no-op', () => {
      const store = new DraftStore()
      const d = el()
      d.textContent = 'Hi'
      store.applyDelete(d)
      store.applyText(d, 'changed')
      expect(store.structuralOf(d)!.kind).toBe('delete')
      expect(d.textContent).toBe('Hi')
    })

    it('changeCount and elementCount include structural drafts', () => {
      const store = new DraftStore()
      const a = el()
      const b = el()
      a.textContent = 'x'
      store.apply(a, 'width', '10px')
      store.applyText(a, 'y')
      store.applyDelete(b)
      expect(store.changeCount()).toBe(3) // width + text + delete
      expect(store.elementCount()).toBe(2)
      expect(store.hasDrafts(a)).toBe(true)
      expect(store.hasDrafts(b)).toBe(true)
    })

    it('targeted css discard and commit never touch structural drafts', () => {
      const store = new DraftStore()
      const d = el()
      d.textContent = 'Keep me'
      store.apply(d, 'gap', '24px')
      store.applyText(d, 'Edited')
      store.discard(d, ['gap'])
      expect(store.structuralOf(d)).toEqual({ kind: 'text', original: 'Keep me', value: 'Edited' })
      expect(store.hasDrafts(d)).toBe(true)
      store.apply(d, 'width', '10px')
      store.commit(d, ['width'])
      expect(store.structuralOf(d)).not.toBeNull()
      expect(store.hasDrafts(d)).toBe(true)
    })

    it('compare flips text and delete previews to the original side and back', () => {
      const store = new DraftStore()
      const t = el()
      t.textContent = 'Before'
      store.applyText(t, 'After')
      const gone = el()
      store.applyDelete(gone)
      store.compare(t, true)
      expect(t.textContent).toBe('Before')
      store.compare(t, false)
      expect(t.textContent).toBe('After')
      store.compare(gone, true)
      expect(gone.style.getPropertyValue('display')).toBe('')
      store.compare(gone, false)
      expect(gone.style.getPropertyValue('display')).toBe('none')
    })

    it('compareAll covers structural-only elements and isComparingAll counts them', () => {
      const store = new DraftStore()
      const a = el()
      const b = el()
      store.apply(a, 'width', '10px')
      store.applyDelete(b)
      store.compareAll(true)
      expect(b.style.getPropertyValue('display')).toBe('')
      expect(store.isComparingAll()).toBe(true)
      store.compareAll(false)
      expect(b.style.getPropertyValue('display')).toBe('none')
    })

    it('applyText while comparing auto-exits compare', () => {
      const store = new DraftStore()
      const d = el()
      d.textContent = 'Orig'
      store.applyText(d, 'Draft')
      store.compare(d, true)
      store.applyText(d, 'Draft 2')
      expect(store.isComparing(d)).toBe(false)
      expect(d.textContent).toBe('Draft 2')
    })

    it('commit forgets a text draft leaving the DOM as-is, and leaves a deleted element hidden', () => {
      const store = new DraftStore()
      const t = el()
      t.textContent = 'Old'
      store.applyText(t, 'New')
      store.commit(t)
      expect(t.textContent).toBe('New') // code owns it now
      expect(store.hasDrafts(t)).toBe(false)
      const gone = el()
      store.applyDelete(gone)
      store.commit(gone)
      expect(gone.style.getPropertyValue('display')).toBe('none') // stale node stays invisible
      expect(store.hasDrafts(gone)).toBe(false)
    })

    it('discardAll restores structural drafts too', () => {
      const store = new DraftStore()
      const t = el()
      t.textContent = 'Orig'
      store.applyText(t, 'Draft')
      const gone = el()
      gone.style.setProperty('display', 'flex')
      store.applyDelete(gone)
      store.discardAll()
      expect(t.textContent).toBe('Orig')
      expect(gone.style.getPropertyValue('display')).toBe('flex')
      expect(store.changeCount()).toBe(0)
      expect(store.elementCount()).toBe(0)
    })

    it('structuralEntries exposes the live map for the request builder', () => {
      const store = new DraftStore()
      const d = el()
      store.applyDelete(d)
      expect(store.structuralEntries().get(d)).toEqual({ kind: 'delete', priorInlineDisplay: '' })
    })

    it('a text draft edited back to its recorded original is dropped, not kept as a no-op (PR #44 review)', () => {
      const store = new DraftStore()
      const d = el()
      d.textContent = 'Old'
      store.applyText(d, 'New', 'Old')
      expect(store.changeCount()).toBe(1)
      store.applyText(d, 'Old', 'New') // second edit session types the original back
      expect(store.structuralOf(d)).toBeNull()
      expect(store.changeCount()).toBe(0)
      expect(d.textContent).toBe('Old')
    })

    it('css apply() is a no-op on a delete-drafted element (tombstone guard, PR #44 review)', () => {
      const store = new DraftStore()
      const d = el()
      store.applyDelete(d)
      store.apply(d, 'width', '100px') // reachable via Compare un-hiding the tombstone
      expect(store.entries().get(d)).toBeUndefined()
      expect(d.style.getPropertyValue('width')).toBe('')
    })

    it('applyDelete sweeps descendant drafts — no restyle ops ride a delete request (PR #44 review)', () => {
      const store = new DraftStore()
      const parent = el()
      const child = document.createElement('span')
      const childText = document.createElement('em')
      childText.textContent = 'Old'
      parent.append(child, childText)
      store.apply(child, 'padding-top', '24px')
      store.applyText(childText, 'New', 'Old')

      const emits = vi.fn()
      store.onChange = emits
      store.applyDelete(parent)

      expect(store.entries().get(child)).toBeUndefined()
      expect(child.style.getPropertyValue('padding-top')).toBe('') // original restored
      expect(store.structuralOf(childText)).toBeNull()
      expect(childText.textContent).toBe('Old') // text rolled back before the tombstone
      expect(store.structuralOf(parent)).toEqual({ kind: 'delete', priorInlineDisplay: '' })
      expect(store.changeCount()).toBe(1) // only the delete itself
      expect(emits).toHaveBeenCalledTimes(1) // the whole operation cascades onChange ONCE
    })

    it('healStructural re-binds a remounted node and prunes an unlocatable one (PR #44 review)', () => {
      const store = new DraftStore()
      const a = el()
      a.dataset.dcSource = 'src/App.tsx:5:5'
      a.textContent = 'Old'
      store.applyText(a, 'New', 'Old')
      const b = el()
      store.applyDelete(b) // untagged — unlocatable once disconnected

      // an unrelated HMR remount replaces both nodes
      a.remove()
      b.remove()
      const fresh = el()
      fresh.dataset.dcSource = 'src/App.tsx:5:5'
      fresh.textContent = 'Old' // the fresh node renders the source truth

      expect(store.changeCount()).toBe(2) // phantom counts before the heal
      store.healStructural()
      // the text draft re-bound onto the fresh node, preview re-applied
      expect(store.structuralOf(a)).toBeNull()
      expect(store.structuralOf(fresh)).toEqual({ kind: 'text', original: 'Old', value: 'New' })
      expect(fresh.textContent).toBe('New')
      // the unlocatable delete draft was pruned
      expect(store.structuralOf(b)).toBeNull()
      expect(store.changeCount()).toBe(1)
    })
  })

  it('changeCount() sums drafted properties across elements', () => {
    const store = new DraftStore()
    const a = el()
    const b = el()
    expect(store.changeCount()).toBe(0)
    store.apply(a, 'padding-top', '24px')
    store.apply(a, 'gap', '16px')
    store.apply(a, 'padding-top', '32px') // re-editing the same prop is still ONE change
    store.apply(b, 'background-color', 'rgb(255, 0, 0)')
    expect(store.changeCount()).toBe(3)
    store.discard(a, ['gap'])
    expect(store.changeCount()).toBe(2)
    store.commit(a)
    expect(store.changeCount()).toBe(1)
    store.discardAll()
    expect(store.changeCount()).toBe(0)
  })
})
