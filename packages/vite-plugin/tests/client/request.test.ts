// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { DraftStore } from '../../src/client/drafts'
import { buildChangeRequest, buildChangeRequestWithElements, cssPath, renderMarkdown } from '../../src/client/request'
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

  it('suppresses and restores inline transitions during measurement', () => {
    const el = makeButton()
    el.style.setProperty('transition', 'opacity 0.3s')
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    buildChangeRequest(store, TW)
    expect(el.style.getPropertyValue('transition')).toBe('opacity 0.3s')
  })

  it('leaves no inline transition behind when none existed', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    buildChangeRequest(store, TW)
    expect(el.style.getPropertyValue('transition')).toBe('')
  })

  it('skips elements detached from the document (e.g. replaced by HMR)', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    el.remove()
    const req = buildChangeRequest(store, TW)
    expect(req.elements).toHaveLength(0)
  })

  it('requests carry id, createdAt, and per-element selector', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    const req = buildChangeRequest(store, TW)
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Date(req.createdAt).getTime()).toBeGreaterThan(0)
    expect(req.elements[0].selector).toContain('button')
  })

  it('each build produces a distinct id', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    const req1 = buildChangeRequest(store, TW)
    const req2 = buildChangeRequest(store, TW)
    expect(req1.id).not.toBe(req2.id)
  })
})

describe('buildChangeRequest — keyword drafts (M2b-1 Fix 1)', () => {
  it('a Hug width draft (auto) reports the measured before size and the literal "auto" after, not a re-measured px', () => {
    document.body.innerHTML = `
      <div data-dc-source="src/Parent.tsx:1:1" id="parent" style="display: flex; width: 400px;">
        <div data-dc-source="src/Child.tsx:2:2" id="child" style="width: 240px; height: 50px;"></div>
      </div>`
    const child = document.getElementById('child')! as HTMLElement
    const store = new DraftStore()
    store.apply(child, 'width', 'auto')
    const req = buildChangeRequest(store, TW)
    const c = req.elements[0].changes.find((x) => x.property === 'width')!
    expect(c.beforeCss).toBe('240px')
    expect(c.afterCss).toBe('auto')
    expect(c.afterUtility).toBe('w-auto')
  })

  it('full layout session in one request: parent flex drafts + child align-self/width/height drafts', () => {
    document.body.innerHTML = `
      <div data-dc-source="src/Parent.tsx:1:1" id="parent" style="display: flex; width: 400px; height: 300px;">
        <div data-dc-source="src/Child.tsx:2:2" id="child" style="width: 240px; height: 50px;"></div>
      </div>`
    const parent = document.getElementById('parent')! as HTMLElement
    const child = document.getElementById('child')! as HTMLElement
    const store = new DraftStore()

    // Parent: flex-direction: column, gap-auto (justify-content: space-between)
    store.apply(parent, 'flex-direction', 'column')
    store.apply(parent, 'justify-content', 'space-between')

    // Child: align-self Start, width Hug (auto), pinned height
    store.apply(child, 'align-self', 'flex-start')
    store.apply(child, 'width', 'auto')
    store.apply(child, 'height', '240px')

    const req = buildChangeRequest(store, TW)
    const md = renderMarkdown(req)

    expect(md).toMatch(/width: \d+(\.\d+)?px → auto — (change|add) `w-auto`/)
    expect(md).toMatch(/justify-content: .* → space-between/)
    expect(md).toMatch(/align-self: .* → flex-start/)
    // css-only lines (no utility mapping) must not emit backtick-undefined junk
    expect(md).not.toContain('undefined')
    expect(md).toContain('height: 50px → 240px')
    for (const line of md.split('\n')) {
      expect(line).not.toContain('undefined')
    }
  })
})

describe('buildChangeRequest — keyword allowlist (B0)', () => {
  it('a color draft ("red") is NOT passed through verbatim — it is measured via computed style', () => {
    document.body.innerHTML = `<div data-dc-source="src/Box.tsx:1:1" id="box" style="color: rgb(0, 0, 0);">hi</div>`
    const el = document.getElementById('box')! as HTMLElement
    const store = new DraftStore()
    store.apply(el, 'color', 'red')
    const req = buildChangeRequest(store, TW)
    const c = req.elements[0].changes.find((x) => x.property === 'color')!
    expect(c.afterCss).not.toBe('red')
    expect(c.afterCss).toBe('rgb(255, 0, 0)')
  })

  it('"blue" (another color keyword) is also measured, not passed through', () => {
    document.body.innerHTML = `<div data-dc-source="src/Box.tsx:1:1" id="box" style="color: rgb(0, 0, 0);">hi</div>`
    const el = document.getElementById('box')! as HTMLElement
    const store = new DraftStore()
    store.apply(el, 'color', 'blue')
    const req = buildChangeRequest(store, TW)
    const c = req.elements[0].changes.find((x) => x.property === 'color')!
    expect(c.afterCss).not.toBe('blue')
    expect(c.afterCss).toBe('rgb(0, 0, 255)')
  })

  it('"auto" (an allowlisted layout keyword) still passes through verbatim', () => {
    document.body.innerHTML = `
      <div data-dc-source="src/Parent.tsx:1:1" id="parent" style="display: flex; width: 400px;">
        <div data-dc-source="src/Child.tsx:2:2" id="child" style="width: 240px;"></div>
      </div>`
    const child = document.getElementById('child')! as HTMLElement
    const store = new DraftStore()
    store.apply(child, 'width', 'auto')
    const req = buildChangeRequest(store, TW)
    const c = req.elements[0].changes.find((x) => x.property === 'width')!
    expect(c.afterCss).toBe('auto')
  })

  it('is case-insensitive: "AUTO" still passes through verbatim', () => {
    document.body.innerHTML = `
      <div data-dc-source="src/Parent.tsx:1:1" id="parent" style="display: flex; width: 400px;">
        <div data-dc-source="src/Child.tsx:2:2" id="child" style="width: 240px;"></div>
      </div>`
    const child = document.getElementById('child')! as HTMLElement
    const store = new DraftStore()
    store.apply(child, 'width', 'AUTO')
    const req = buildChangeRequest(store, TW)
    const c = req.elements[0].changes.find((x) => x.property === 'width')!
    expect(c.afterCss).toBe('AUTO')
  })
})

describe('cssPath', () => {
  it('uses the id when present', () => {
    document.body.innerHTML = `<div><button id="save-btn">Save</button></div>`
    const el = document.querySelector('button')!
    expect(cssPath(el)).toBe('button#save-btn')
  })

  it('builds an nth-of-type chain up to 4 ancestors when there is no id', () => {
    document.body.innerHTML = `
      <div>
        <section>
          <article>
            <div>
              <button>go</button>
            </div>
          </article>
        </section>
      </div>`
    const el = document.querySelector('button')!
    const path = cssPath(el)
    expect(path).toContain('button')
    expect(path.split('>').length).toBeLessThanOrEqual(5)
  })
})

describe('buildChangeRequestWithElements', () => {
  it('returns the same request as buildChangeRequest plus a live element map', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    const { request, elements } = buildChangeRequestWithElements(store, TW)
    expect(request.elements).toHaveLength(1)
    expect(elements.size).toBe(1)
    expect(elements.get(el)).toBe(request.elements[0])
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

  it('sanitizes newlines and backticks out of element text', () => {
    document.body.innerHTML = `<button data-dc-source="src/A.tsx:1:1" style="padding-top: 4px;">line1
line2 \`code\`</button>`
    const el = document.querySelector('button')!
    const store = new DraftStore()
    store.apply(el, 'padding-top', '8px')
    const md = renderMarkdown(buildChangeRequest(store, PLAIN))
    const textLine = md.split('\n').find((l) => l.startsWith('Text:'))!
    expect(textLine).toBe('Text: "line1 line2 code"')
  })

  it('skips no-op change lines where beforeCss equals afterCss', () => {
    document.body.innerHTML = `
      <div data-dc-source="src/Parent.tsx:1:1" id="parent" style="display: flex;">
        <div data-dc-source="src/Child.tsx:2:2" id="child" style="width: 240px;"></div>
      </div>`
    const child = document.getElementById('child')! as HTMLElement
    const store = new DraftStore()
    // draft the SAME value the element already has — a genuine no-op
    store.apply(child, 'width', '240px')
    const md = renderMarkdown(buildChangeRequest(store, PLAIN))
    expect(md).not.toContain('width: 240px → 240px')
  })
})
