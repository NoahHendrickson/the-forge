// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { FeedAnchor } from '../../src/client/feed-anchor'

// jsdom has no layout engine — clientHeight/offsetHeight/offsetTop are always 0 unless
// stubbed. These tests stub them explicitly wherever the sizing math is under test, and
// rely on the all-zero default elsewhere (mirrors session-feed.test.ts's own conventions).

function stub(el: HTMLElement, prop: 'clientHeight' | 'offsetHeight' | 'offsetTop', value: number): void {
  Object.defineProperty(el, prop, { value, configurable: true })
}

describe('FeedAnchor', () => {
  let list: HTMLElement

  beforeEach(() => {
    list = document.createElement('div')
    document.body.appendChild(list)
  })

  it('constructor appends the spacer as the list\'s last (and only) child', () => {
    const anchor = new FeedAnchor(list)
    expect(list.lastElementChild).toBe(anchor.spacer)
    expect(anchor.spacer.className).toBe('feed-tail-spacer')
    expect(list.children).toHaveLength(1)
  })

  it('spacer stays the list\'s last child after anchor() with rows present', () => {
    const anchor = new FeedAnchor(list)
    const row = document.createElement('div')
    list.insertBefore(row, anchor.spacer)
    anchor.anchor(row)
    expect(list.lastElementChild).toBe(anchor.spacer)
  })

  it('spacer stays the list\'s last child after update() with rows present', () => {
    const anchor = new FeedAnchor(list)
    const row = document.createElement('div')
    list.insertBefore(row, anchor.spacer)
    anchor.anchor(row)
    anchor.update()
    expect(list.lastElementChild).toBe(anchor.spacer)
  })

  it('anchor() sizes the spacer to list.clientHeight - row.offsetHeight', () => {
    const anchor = new FeedAnchor(list)
    stub(list, 'clientHeight', 500)
    const row = document.createElement('div')
    stub(row, 'offsetHeight', 120)
    list.insertBefore(row, anchor.spacer)
    anchor.anchor(row)
    expect(anchor.spacer.style.height).toBe('380px')
  })

  it('anchor() clamps the spacer height at 0 when the row is taller than the viewport', () => {
    const anchor = new FeedAnchor(list)
    stub(list, 'clientHeight', 100)
    const row = document.createElement('div')
    stub(row, 'offsetHeight', 400)
    list.insertBefore(row, anchor.spacer)
    anchor.anchor(row)
    expect(anchor.spacer.style.height).toBe('0px')
  })

  it('anchor() calls row.scrollIntoView({ block: "start" }) when present', () => {
    const anchor = new FeedAnchor(list)
    const row = document.createElement('div')
    const calls: ScrollIntoViewOptions[] = []
    row.scrollIntoView = (o?: ScrollIntoViewOptions) => calls.push(o ?? {})
    list.insertBefore(row, anchor.spacer)
    anchor.anchor(row)
    expect(calls).toEqual([{ block: 'start' }])
  })

  it('anchor() does not throw when row.scrollIntoView is undefined (jsdom default)', () => {
    const anchor = new FeedAnchor(list)
    const row = document.createElement('div')
    list.insertBefore(row, anchor.spacer)
    expect(() => anchor.anchor(row)).not.toThrow()
  })

  it('update() before any anchor() call is a no-op', () => {
    const anchor = new FeedAnchor(list)
    expect(() => anchor.update()).not.toThrow()
    expect(anchor.spacer.style.height).toBe('')
  })

  it('update() shrinks the spacer by the content that has accumulated below the anchor', () => {
    const anchor = new FeedAnchor(list)
    stub(list, 'clientHeight', 500)
    const row = document.createElement('div')
    stub(row, 'offsetHeight', 100)
    stub(row, 'offsetTop', 0)
    list.insertBefore(row, anchor.spacer)
    anchor.anchor(row) // spacer sized to 400px
    expect(anchor.spacer.style.height).toBe('400px')
    // 150px of real content now sits between the anchor row and the spacer
    stub(anchor.spacer, 'offsetTop', 150)
    anchor.update()
    expect(anchor.spacer.style.height).toBe('350px')
  })

  it('update() is a no-op once the spacer has drained to 0px (early-out)', () => {
    const anchor = new FeedAnchor(list)
    stub(list, 'clientHeight', 500)
    const row = document.createElement('div')
    list.insertBefore(row, anchor.spacer)
    anchor.anchor(row)
    anchor.spacer.style.height = '0px' // simulate a fully-drained spacer
    // If update() recomputed instead of early-outing, this stub would push it back up —
    // proving the early-out actually short-circuits before the measurement read.
    stub(anchor.spacer, 'offsetTop', 0)
    stub(row, 'offsetTop', -1000)
    anchor.update()
    expect(anchor.spacer.style.height).toBe('0px')
  })

  it('update() is a no-op once the anchor row has been detached from the DOM', () => {
    const anchor = new FeedAnchor(list)
    stub(list, 'clientHeight', 500)
    const row = document.createElement('div')
    stub(row, 'offsetHeight', 100)
    list.insertBefore(row, anchor.spacer)
    anchor.anchor(row)
    row.remove()
    const before = anchor.spacer.style.height
    anchor.update()
    expect(anchor.spacer.style.height).toBe(before)
  })

  it('onEvict(removed) clears the anchor and resets the spacer to 0px when the anchored row is evicted', () => {
    const anchor = new FeedAnchor(list)
    stub(list, 'clientHeight', 500)
    const row = document.createElement('div')
    stub(row, 'offsetHeight', 100)
    list.insertBefore(row, anchor.spacer)
    anchor.anchor(row) // spacer sized to 400px, non-zero
    expect(anchor.spacer.style.height).toBe('400px')
    anchor.onEvict([row])
    expect(anchor.spacer.style.height).toBe('0px')
    // A detached anchor must not "freeze the spacer at its last size forever" (class doc) —
    // update() after eviction should stay a no-op since anchorRow is now null.
    anchor.update()
    expect(anchor.spacer.style.height).toBe('0px')
  })

  it('onEvict(removed) leaves the anchor and spacer untouched when the anchored row is not in the evicted list', () => {
    const anchor = new FeedAnchor(list)
    stub(list, 'clientHeight', 500)
    const row = document.createElement('div')
    stub(row, 'offsetHeight', 100)
    const other = document.createElement('div')
    list.insertBefore(row, anchor.spacer)
    list.insertBefore(other, anchor.spacer)
    anchor.anchor(row)
    expect(anchor.spacer.style.height).toBe('400px')
    anchor.onEvict([other])
    expect(anchor.spacer.style.height).toBe('400px')
  })

  it('onEvict on an anchor that was never set is a no-op (no crash)', () => {
    const anchor = new FeedAnchor(list)
    const row = document.createElement('div')
    expect(() => anchor.onEvict([row])).not.toThrow()
    expect(anchor.spacer.style.height).toBe('')
  })
})
