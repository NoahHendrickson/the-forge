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
    registry.add('q1', [{ el: btn, dcSource: btn.dataset.dcSource ?? null, changes: [{ property: 'padding-top', afterCss: '24px' }] }])
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
    registry.add('q2', [{ el: plain, dcSource: null, changes: [] }])
    const entry = registry.take('q2')!
    expect(entry.elements[0].dcSource).toBeNull()
  })
})
