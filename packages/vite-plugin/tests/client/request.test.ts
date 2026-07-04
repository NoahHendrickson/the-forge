// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { DraftStore } from '../../src/client/drafts'
import { buildChangeRequest, renderMarkdown } from '../../src/client/request'
import type { Theme } from '../../src/client/tokens'

const TW: Theme = { rootFontPx: 16, spacingBasePx: 4, radiusScale: { lg: 8, xl: 12 } }
const PLAIN: Theme = { rootFontPx: 16, spacingBasePx: null, radiusScale: {} }

function makeButton(): HTMLElement {
  document.body.innerHTML = `<button data-dc-source="src/App.tsx:7:9" class="mt-4 rounded-lg py-2.5 text-sm" style="padding-top: 10px; padding-bottom: 10px;">Add mod</button>`
  return document.querySelector('button')!
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('buildChangeRequest', () => {
  it('captures source, classes, text, and before/after css per change', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    store.apply(el, 'padding-bottom', '24px')
    const req = buildChangeRequest(store, TW)
    expect(req.tailwind).toBe(true)
    expect(req.elements).toHaveLength(1)
    const e = req.elements[0]
    expect(e.source).toEqual({ file: 'src/App.tsx', line: 7, col: 9 })
    expect(e.text).toBe('Add mod')
    expect(e.changes).toHaveLength(1) // collapsed to padding-block
    const c = e.changes[0]
    expect(c.property).toBe('padding-block')
    expect(c.beforeCss).toBe('10px')
    expect(c.afterCss).toBe('24px')
    expect(c.beforeUtility).toBe('py-2.5')
    expect(c.afterUtility).toBe('py-6')
    expect(c.tokenExact).toBe(true)
  })

  it('collapses four equal corner radii into border-radius', () => {
    const el = makeButton()
    const store = new DraftStore()
    for (const c of ['top-left', 'top-right', 'bottom-right', 'bottom-left']) {
      store.apply(el, `border-${c}-radius`, '12px')
    }
    const req = buildChangeRequest(store, TW)
    expect(req.elements[0].changes).toEqual([
      expect.objectContaining({ property: 'border-radius', afterCss: '12px', afterUtility: 'rounded-xl' }),
    ])
  })

  it('keeps unequal longhands separate', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    store.apply(el, 'padding-bottom', '8px')
    const req = buildChangeRequest(store, TW)
    const props = req.elements[0].changes.map((c) => c.property).sort()
    expect(props).toEqual(['padding-bottom', 'padding-top'])
  })

  it('leaves the element in its pre-build compare state', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    buildChangeRequest(store, TW)
    expect(el.style.getPropertyValue('padding-top')).toBe('24px') // drafts still applied
    store.compare(el, true)
    buildChangeRequest(store, TW)
    expect(store.isComparing(el)).toBe(true) // comparing state preserved
  })

  it('produces authored-null changes for non-Tailwind themes', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    const req = buildChangeRequest(store, PLAIN)
    expect(req.tailwind).toBe(false)
    const c = req.elements[0].changes.find((x) => x.property === 'padding-top')!
    expect(c.afterUtility).toBeNull()
    expect(c.beforeCss).toBe('10px')
    expect(c.afterCss).toBe('24px')
  })
})

describe('renderMarkdown', () => {
  it('renders location, authored delta, scope note, and verify instruction', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    store.apply(el, 'padding-bottom', '24px')
    const md = renderMarkdown(buildChangeRequest(store, TW))
    expect(md).toContain('src/App.tsx:7:9')
    expect(md).toContain('`py-2.5` → `py-6`')
    expect(md).toContain('padding-block: 10px → 24px')
    expect(md).toContain('this call site only')
    expect(md).toContain('EXACTLY')
    expect(md).toContain('verify')
  })

  it('renders css-only lines when not Tailwind', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    const md = renderMarkdown(buildChangeRequest(store, PLAIN))
    expect(md).toContain('padding-top: 10px → 24px')
    expect(md).not.toContain('→ `')
  })
})
