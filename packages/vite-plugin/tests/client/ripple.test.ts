// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { snapshotRects, diffRects } from '../../src/client/ripple'
import type { TaggedElement } from '../../src/client/source'

beforeEach(() => {
  document.body.innerHTML = ''
})

/** Stub getBoundingClientRect on an element to return a fixed rect (jsdom rects are always zero). */
function stubRect(el: Element, rect: { x: number; y: number; width: number; height: number }): void {
  el.getBoundingClientRect = () =>
    new DOMRect(rect.x, rect.y, rect.width, rect.height)
}

describe('snapshotRects', () => {
  it('excludes the selected element', () => {
    document.body.innerHTML = `
      <div data-dc-source="a.tsx:1:1" id="selected"></div>
      <div data-dc-source="b.tsx:2:2" id="sibling"></div>
    `
    const selected = document.getElementById('selected') as TaggedElement
    const sibling = document.getElementById('sibling') as TaggedElement
    stubRect(selected, { x: 0, y: 0, width: 10, height: 10 })
    stubRect(sibling, { x: 0, y: 0, width: 10, height: 10 })

    const snapshot = snapshotRects(selected)

    expect(snapshot.has(selected)).toBe(false)
    expect(snapshot.has(sibling)).toBe(true)
  })

  it('scopes to the nearest ancestor with data-dc-source, not the whole document', () => {
    document.body.innerHTML = `
      <div data-dc-source="scope.tsx:1:1" id="scope">
        <div data-dc-source="a.tsx:2:2" id="selected"></div>
        <div data-dc-source="b.tsx:3:3" id="in-scope"></div>
      </div>
      <div data-dc-source="c.tsx:4:4" id="out-of-scope"></div>
    `
    const selected = document.getElementById('selected') as TaggedElement
    const inScope = document.getElementById('in-scope') as TaggedElement
    const outOfScope = document.getElementById('out-of-scope') as TaggedElement
    for (const el of [selected, inScope, outOfScope]) stubRect(el, { x: 0, y: 0, width: 10, height: 10 })

    const snapshot = snapshotRects(selected)

    expect(snapshot.has(inScope)).toBe(true)
    expect(snapshot.has(outOfScope)).toBe(false)
  })

  it('falls back to document.body scope when no ancestor has data-dc-source', () => {
    document.body.innerHTML = `
      <div id="wrapper">
        <div data-dc-source="a.tsx:1:1" id="selected"></div>
        <div data-dc-source="b.tsx:2:2" id="sibling"></div>
      </div>
    `
    const selected = document.getElementById('selected') as TaggedElement
    const sibling = document.getElementById('sibling') as TaggedElement
    stubRect(selected, { x: 0, y: 0, width: 10, height: 10 })
    stubRect(sibling, { x: 0, y: 0, width: 10, height: 10 })

    const snapshot = snapshotRects(selected)

    expect(snapshot.has(sibling)).toBe(true)
  })

  it('caps the snapshot at 50 elements', () => {
    const parts: string[] = [`<div data-dc-source="sel.tsx:0:0" id="selected"></div>`]
    for (let i = 0; i < 60; i++) parts.push(`<div data-dc-source="el${i}.tsx:${i}:0" class="tagged"></div>`)
    document.body.innerHTML = parts.join('')
    const selected = document.getElementById('selected') as TaggedElement
    stubRect(selected, { x: 0, y: 0, width: 10, height: 10 })
    for (const el of document.querySelectorAll('.tagged')) stubRect(el, { x: 0, y: 0, width: 10, height: 10 })

    const snapshot = snapshotRects(selected)

    expect(snapshot.size).toBe(50)
  })

  it('accepts an explicit document (for testing / iframes)', () => {
    document.body.innerHTML = `
      <div data-dc-source="a.tsx:1:1" id="selected"></div>
      <div data-dc-source="b.tsx:2:2" id="sibling"></div>
    `
    const selected = document.getElementById('selected') as TaggedElement
    const sibling = document.getElementById('sibling') as TaggedElement
    stubRect(selected, { x: 0, y: 0, width: 10, height: 10 })
    stubRect(sibling, { x: 0, y: 0, width: 10, height: 10 })

    const snapshot = snapshotRects(selected, document)

    expect(snapshot.has(sibling)).toBe(true)
  })
})

describe('diffRects', () => {
  it('detects an element whose rect grew', () => {
    document.body.innerHTML = `<div data-dc-source="a.tsx:1:1" id="grower"></div>`
    const el = document.getElementById('grower') as TaggedElement
    stubRect(el, { x: 0, y: 0, width: 10, height: 10 })
    const before = new Map<TaggedElement, DOMRect>([[el, el.getBoundingClientRect()]])

    stubRect(el, { x: 0, y: 0, width: 50, height: 10 })

    const changed = diffRects(before)

    expect(changed).toEqual([el])
  })

  it('does not report elements whose rect is unchanged', () => {
    document.body.innerHTML = `<div data-dc-source="a.tsx:1:1" id="still"></div>`
    const el = document.getElementById('still') as TaggedElement
    stubRect(el, { x: 0, y: 0, width: 10, height: 10 })
    const before = new Map<TaggedElement, DOMRect>([[el, el.getBoundingClientRect()]])

    const changed = diffRects(before)

    expect(changed).toEqual([])
  })

  it('ignores sub-threshold jitter (<=0.5px)', () => {
    document.body.innerHTML = `<div data-dc-source="a.tsx:1:1" id="jitter"></div>`
    const el = document.getElementById('jitter') as TaggedElement
    stubRect(el, { x: 0, y: 0, width: 10, height: 10 })
    const before = new Map<TaggedElement, DOMRect>([[el, el.getBoundingClientRect()]])

    stubRect(el, { x: 0, y: 0, width: 10.4, height: 10 })

    const changed = diffRects(before)

    expect(changed).toEqual([])
  })

  it('skips elements no longer connected to the document', () => {
    document.body.innerHTML = `<div data-dc-source="a.tsx:1:1" id="removed"></div>`
    const el = document.getElementById('removed') as TaggedElement
    stubRect(el, { x: 0, y: 0, width: 10, height: 10 })
    const before = new Map<TaggedElement, DOMRect>([[el, el.getBoundingClientRect()]])

    el.remove()

    const changed = diffRects(before)

    expect(changed).toEqual([])
  })
})
