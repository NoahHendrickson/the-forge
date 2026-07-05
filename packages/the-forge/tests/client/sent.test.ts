// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { SentRegistry } from '../../src/client/sent'

function el(): HTMLElement {
  const d = document.createElement('div')
  document.body.appendChild(d)
  return d
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('SentRegistry', () => {
  it('add/pendingIds/take/size round-trip', () => {
    const registry = new SentRegistry()
    expect(registry.size()).toBe(0)
    const btn = el()
    btn.dataset.dcSource = 'src/App.tsx:7:9'
    registry.add('q1', [{ el: btn, dcSource: btn.dataset.dcSource ?? null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }])
    expect(registry.size()).toBe(1)
    expect(registry.pendingIds()).toEqual(['q1'])

    const entry = registry.take('q1')
    expect(entry).toBeDefined()
    expect(entry!.id).toBe('q1')
    expect(entry!.elements).toHaveLength(1)
    expect(entry!.elements[0].el).toBe(btn)
    expect(entry!.elements[0].dcSource).toBe('src/App.tsx:7:9')
    expect(entry!.elements[0].changes).toEqual([{ property: 'padding-top', afterCss: '24px' }])

    // take removes it
    expect(registry.size()).toBe(0)
    expect(registry.pendingIds()).toEqual([])
    expect(registry.take('q1')).toBeUndefined()
  })

  it('take on an unknown id returns undefined', () => {
    const registry = new SentRegistry()
    expect(registry.take('missing')).toBeUndefined()
  })

  it('tracks multiple pending ids independently', () => {
    const registry = new SentRegistry()
    registry.add('a', [])
    registry.add('b', [])
    expect(registry.size()).toBe(2)
    expect(registry.pendingIds().sort()).toEqual(['a', 'b'])
    registry.take('a')
    expect(registry.pendingIds()).toEqual(['b'])
  })

  it('records dcSource as null when the element has no data-dc-source', () => {
    const registry = new SentRegistry()
    const plain = el()
    registry.add('q2', [{ el: plain, dcSource: null, draftProps: [], changes: [] }])
    const entry = registry.take('q2')!
    expect(entry.elements[0].dcSource).toBeNull()
  })

  describe('isDuplicate (double-Send guard)', () => {
    const CHANGES = [{ property: 'padding-top', afterCss: '24px' }]

    function addInFlight(registry: SentRegistry, element: HTMLElement, changes = CHANGES): void {
      registry.add('q1', [{ el: element, dcSource: null, draftProps: ['padding-top'], changes }])
    }

    it('true for the same element with an identical change set', () => {
      const registry = new SentRegistry()
      const btn = el()
      addInFlight(registry, btn)
      expect(registry.isDuplicate(btn, [{ property: 'padding-top', afterCss: '24px' }])).toBe(true)
    })

    it('false once the entry has been taken (verified/failed) — a re-send is legitimate again', () => {
      const registry = new SentRegistry()
      const btn = el()
      addInFlight(registry, btn)
      registry.take('q1')
      expect(registry.isDuplicate(btn, CHANGES)).toBe(false)
    })

    it('false when the element was re-edited to a different value — that is a new request', () => {
      const registry = new SentRegistry()
      const btn = el()
      addInFlight(registry, btn)
      expect(registry.isDuplicate(btn, [{ property: 'padding-top', afterCss: '32px' }])).toBe(false)
    })

    it('false when the new change set has extra or fewer properties', () => {
      const registry = new SentRegistry()
      const btn = el()
      addInFlight(registry, btn)
      expect(
        registry.isDuplicate(btn, [
          { property: 'padding-top', afterCss: '24px' },
          { property: 'padding-bottom', afterCss: '24px' },
        ])
      ).toBe(false)
      expect(registry.isDuplicate(btn, [])).toBe(false)
    })

    it('false for a different element with the same change set', () => {
      const registry = new SentRegistry()
      const btn = el()
      const other = el()
      addInFlight(registry, btn)
      expect(registry.isDuplicate(other, CHANGES)).toBe(false)
    })

    it('true for a detached placeholder entry when the re-mounted real element shares its dcSource and change set', () => {
      const registry = new SentRegistry()
      const placeholder = document.createElement('div')
      placeholder.dataset.dcSource = 'a.tsx:1:1'
      // NOT appended to document.body — mirrors restoreLifecycle's detached placeholder.
      registry.add('q1', [
        { el: placeholder, dcSource: 'a.tsx:1:1', draftProps: ['padding-top'], changes: CHANGES },
      ])
      const real = el()
      real.dataset.dcSource = 'a.tsx:1:1'
      expect(registry.isDuplicate(real, CHANGES)).toBe(true)
    })

    it('false for a detached placeholder entry when the re-mounted real element has a different change set', () => {
      const registry = new SentRegistry()
      const placeholder = document.createElement('div')
      placeholder.dataset.dcSource = 'a.tsx:1:1'
      registry.add('q1', [
        { el: placeholder, dcSource: 'a.tsx:1:1', draftProps: ['padding-top'], changes: CHANGES },
      ])
      const real = el()
      real.dataset.dcSource = 'a.tsx:1:1'
      expect(registry.isDuplicate(real, [{ property: 'padding-top', afterCss: '32px' }])).toBe(false)
    })

    it('false when the registry element shares dcSource but IS connected (two live list items sharing a source)', () => {
      const registry = new SentRegistry()
      const first = el()
      first.dataset.dcSource = 'a.tsx:1:1'
      registry.add('q1', [
        { el: first, dcSource: 'a.tsx:1:1', draftProps: ['padding-top'], changes: CHANGES },
      ])
      const second = el()
      second.dataset.dcSource = 'a.tsx:1:1'
      expect(registry.isDuplicate(second, CHANGES)).toBe(false)
    })
  })

  describe('get', () => {
    it('returns the entry without removing it', () => {
      const reg = new SentRegistry()
      const el = document.createElement('div')
      reg.add('q1', [{ el, dcSource: 'a.tsx:1:1', draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }])
      expect(reg.get('q1')?.id).toBe('q1')
      expect(reg.size()).toBe(1)
      expect(reg.get('missing')).toBeUndefined()
    })
  })
})
