// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Panel, normalizeJustify, normalizeAlign } from '../../src/client/panel'
import { DraftStore } from '../../src/client/drafts'
import { buildInspectorData } from '../../src/client/inspector'

function setup(html = `<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px; width: 200px;"></div>`) {
  document.body.innerHTML = html
  const el = document.getElementById('t')! as HTMLElement
  const drafts = new DraftStore()
  const onEdited = vi.fn()
  const panel = new Panel(drafts, onEdited)
  document.body.appendChild(panel.root)
  panel.show(el, buildInspectorData(el))
  return { el, drafts, panel, onEdited }
}

function fieldInput(panel: Panel, label: string): HTMLInputElement {
  const nf = [...panel.root.querySelectorAll('.nf')].find(
    (n) => n.querySelector('.nf-label')!.textContent === label
  )
  if (!nf) throw new Error(`no field labeled ${label}`)
  return nf.querySelector('input')!
}

function commit(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

// A couple of tests stub getComputedStyle to simulate flex-layout measurements jsdom can't
// produce itself; unstub unconditionally here so a failed assertion mid-test can't leak the
// stub into later tests.
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Panel', () => {
  it('shows header with source location and populates fields from computed styles', () => {
    const { panel } = setup()
    expect(panel.root.textContent).toContain('src/Card.tsx:4:7')
    expect(fieldInput(panel, 'W').value).toBe('200')
    expect(fieldInput(panel, 'PX').value).toBe('8')
    expect(fieldInput(panel, 'PY').value).toBe('8')
  })

  it('renders the header as two separate nodes: tag and source', () => {
    const { panel } = setup()
    const tagEl = panel.root.querySelector('.panel-head-tag') as HTMLElement
    const srcEl = panel.root.querySelector('.panel-head-src') as HTMLElement
    expect(tagEl).toBeTruthy()
    expect(srcEl).toBeTruthy()
    expect(tagEl.textContent).toBe('div')
    expect(srcEl.textContent).toBe('src/Card.tsx:4:7')
    expect(srcEl.getAttribute('title')).toBe('src/Card.tsx:4:7')
  })

  it('header shows only the tag node when there is no source', () => {
    document.body.innerHTML = `<div id="t" style="padding: 8px; width: 200px;"></div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))
    const tagEl = panel.root.querySelector('.panel-head-tag') as HTMLElement
    const srcEl = panel.root.querySelector('.panel-head-src') as HTMLElement
    expect(tagEl.textContent).toBe('div')
    expect(srcEl).toBeFalsy()
  })

  it('wraps Compare/Reset buttons in a .panel-actions container', () => {
    const { panel } = setup()
    const actions = panel.root.querySelector('.panel-actions') as HTMLElement
    expect(actions).toBeTruthy()
    expect(actions.contains(panel.compareButton)).toBe(true)
    expect(actions.contains(panel.resetButton)).toBe(true)
  })

  it('editing a linked padding field writes both longhands as drafts', () => {
    const { el, panel, drafts, onEdited } = setup()
    commit(fieldInput(panel, 'PX'), '16')
    expect(drafts.current(el, 'padding-left')).toBe('16px')
    expect(drafts.current(el, 'padding-right')).toBe('16px')
    expect(el.style.getPropertyValue('padding-left')).toBe('16px')
    expect(onEdited).toHaveBeenCalled()
  })

  it('shows mixed linked values via setMixed', () => {
    const { panel } = setup(
      `<div data-dc-source="src/a.tsx:1:1" id="t" style="padding-left: 4px; padding-right: 12px;"></div>`
    )
    expect(fieldInput(panel, 'PX').value).toBe('Mixed')
  })

  it('expanding padding reveals per-side fields that edit one longhand', () => {
    const { el, panel, drafts } = setup()
    ;(panel.root.querySelector('[data-expand="padding"]') as HTMLElement).click()
    commit(fieldInput(panel, 'PT'), '20')
    expect(drafts.current(el, 'padding-top')).toBe('20px')
    expect(drafts.current(el, 'padding-bottom')).toBeNull()
  })

  it('radius linked field writes all four corner longhands', () => {
    const { el, panel, drafts } = setup()
    commit(fieldInput(panel, 'R'), '10')
    for (const c of ['top-left', 'top-right', 'bottom-right', 'bottom-left']) {
      expect(drafts.current(el, `border-${c}-radius`)).toBe('10px')
    }
  })

  it('opacity field maps percent to 0-1 css', () => {
    const { el, panel, drafts } = setup()
    commit(fieldInput(panel, 'O'), '60')
    expect(drafts.current(el, 'opacity')).toBe('0.6')
  })

  it('per-element compare and reset buttons drive the store', () => {
    const { el, panel, drafts } = setup()
    commit(fieldInput(panel, 'W'), '300')
    panel.compareButton.click()
    expect(drafts.isComparing(el)).toBe(true)
    panel.compareButton.click()
    expect(drafts.isComparing(el)).toBe(false)
    panel.resetButton.click()
    expect(drafts.hasDrafts(el)).toBe(false)
    expect(fieldInput(panel, 'W').value).toBe('200') // refreshed back to computed
  })

  it('hide clears the panel', () => {
    const { panel } = setup()
    panel.hide()
    expect(panel.root.hidden).toBe(true)
  })

  it('fields show on-screen (original) values while comparing', () => {
    const { el, panel } = setup()
    commit(fieldInput(panel, 'W'), '300')
    panel.compareButton.click()
    expect(fieldInput(panel, 'W').value).toBe('200')
    panel.compareButton.click()
    expect(fieldInput(panel, 'W').value).toBe('300')
  })

  it('opacity 0 round-trips as 0, not 100', () => {
    const { panel } = setup()
    commit(fieldInput(panel, 'O'), '0')
    panel.refresh()
    expect(fieldInput(panel, 'O').value).toBe('0')
  })

  it('mixed detection still works while comparing', () => {
    const { panel, drafts, el } = setup(
      `<div data-dc-source="src/a.tsx:1:1" id="t" style="padding-left: 4px; padding-right: 12px;"></div>`
    )
    commit(fieldInput(panel, 'PX'), '16')
    drafts.compare(el, true)
    panel.refresh()
    expect(fieldInput(panel, 'PX').value).toBe('Mixed') // originals differ → mixed again
  })

  it('section order is Layout, Size, Padding, Margin, Appearance regardless of visibility', () => {
    const { panel } = setup()
    // Sections with an expand button now parent it inside the title row, so title row
    // textContent includes the '⋯' glyph for expandable sections — compare the leading
    // label text only (title row's first text-bearing segment) rather than exact equality.
    const titles = [...panel.root.querySelectorAll('.panel-section')].map(
      (n) => n.textContent?.replace('⋯', '').trim()
    )
    expect(titles).toEqual(['Layout', 'Size', 'Padding', 'Margin', 'Appearance'])
  })

  it('expand button is parented inside the section title row, not the rows wrap', () => {
    const { panel } = setup()
    const sections = [...panel.root.querySelectorAll('.panel-section')]
    const paddingTitle = sections.find((s) => s.textContent?.includes('Padding'))!
    const btn = paddingTitle.querySelector('[data-expand="padding"]')
    expect(btn).toBeTruthy()
    // must NOT be inside a .panel-rows wrap
    expect(paddingTitle.querySelector('.panel-rows [data-expand="padding"]')).toBeFalsy()
  })

  it('Layout section TITLE stays visible (but still first) for a non-flex element — empty state is title + add-auto-layout button, no floating headerless button', () => {
    const { panel } = setup()
    const sections = [...panel.root.querySelectorAll('.panel-section')]
    expect(sections[0].textContent).toBe('Layout')
    expect((sections[0] as HTMLElement).hidden).toBe(false)
    // the layout CONTROLS (direction/gap/align/wrap) are hidden — only the
    // add-auto-layout button is shown alongside the always-visible title
    const btn = panel.root.querySelector('[data-add-layout]') as HTMLElement
    expect(btn.hidden).toBe(false)
    const controlsWrap = panel.root.querySelector('.layout-controls') as HTMLElement
    expect(controlsWrap.hidden).toBe(true)
  })

  function flexSetup(styleExtra = '') {
    return setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="display: flex; width: 200px; height: 100px; ${styleExtra}"></div>`
    )
  }

  it('Layout section is visible for a flex element', () => {
    const { panel } = flexSetup()
    const sections = [...panel.root.querySelectorAll('.panel-section')]
    expect(sections[0].textContent).toBe('Layout')
    expect((sections[0] as HTMLElement).hidden).toBe(false)
  })

  it('layout controls compose a layout-grid with a matrix-tile and a layout-side column', () => {
    const { panel } = flexSetup()
    const controlsWrap = panel.root.querySelector('.layout-controls') as HTMLElement
    const grid = controlsWrap.querySelector('.layout-grid') as HTMLElement
    expect(grid).toBeTruthy()
    const tile = grid.querySelector('.matrix-tile') as HTMLElement
    const side = grid.querySelector('.layout-side') as HTMLElement
    expect(tile).toBeTruthy()
    expect(side).toBeTruthy()
    // matrix-tile wraps the align-matrix
    expect(tile.querySelector('.align-matrix')).toBeTruthy()
    // layout-side contains Gap (a .nf) then Wrap (a .seg-field), in that order
    const gapField = side.querySelector('.nf')
    const wrapField = [...side.querySelectorAll('.seg-field')].find(
      (n) => n.querySelector('.seg-field-label')?.textContent === 'Wrap'
    )
    expect(gapField).toBeTruthy()
    expect(wrapField).toBeTruthy()
    // Direction segment field renders as a full row OUTSIDE the grid (before it)
    const directionField = [...controlsWrap.querySelectorAll('.seg-field')].find(
      (n) => n.querySelector('.seg-field-label')?.textContent === 'Direction'
    )!
    expect(grid.contains(directionField)).toBe(false)
  })

  it('non-flex element shows only the add-auto-layout button in Layout section', () => {
    const { el, panel, drafts } = setup()
    const btn = panel.root.querySelector('[data-add-layout]') as HTMLElement
    expect(btn).toBeTruthy()
    btn.click()
    expect(drafts.current(el, 'display')).toBe('flex')
  })

  it('add-auto-layout button label is prefixed with "+ " per the empty-state plan', () => {
    const { panel } = setup()
    const btn = panel.root.querySelector('[data-add-layout]') as HTMLElement
    expect(btn.textContent).toBe('+ Add auto layout')
  })

  it('add-auto-layout reveals layout controls after refresh', () => {
    const { panel } = setup()
    ;(panel.root.querySelector('[data-add-layout]') as HTMLElement).click()
    const sections = [...panel.root.querySelectorAll('.panel-section')]
    expect((sections[0] as HTMLElement).hidden).toBe(false)
    expect((panel.root.querySelector('[data-add-layout]') as HTMLElement).hidden).toBe(true)
  })

  it('direction segment field drafts flex-direction', () => {
    const { el, panel, drafts } = flexSetup()
    const seg = [...panel.root.querySelectorAll('.seg-field')].find(
      (n) => n.querySelector('.seg-field-label')?.textContent === 'Direction'
    )!
    const buttons = [...seg.querySelectorAll('.seg')] as HTMLElement[]
    const column = buttons.find((b) => b.textContent === 'Column')!
    column.click()
    expect(drafts.current(el, 'flex-direction')).toBe('column')
  })

  it('gap field drafts gap:Npx on a number', () => {
    const { el, panel, drafts } = flexSetup()
    commit(fieldInput(panel, 'Gap'), '24')
    expect(drafts.current(el, 'gap')).toBe('24px')
  })

  it('gap field typed "auto" drafts justify-content:space-between and clears gap draft', () => {
    const { el, panel, drafts } = flexSetup()
    commit(fieldInput(panel, 'Gap'), '24')
    expect(drafts.current(el, 'gap')).toBe('24px')
    commit(fieldInput(panel, 'Gap'), 'auto')
    expect(drafts.current(el, 'justify-content')).toBe('space-between')
    expect(drafts.current(el, 'gap')).toBeNull()
  })

  it('gap field displays auto when computed justify-content is space-between', () => {
    const { panel } = flexSetup('justify-content: space-between;')
    expect(fieldInput(panel, 'Gap').value).toBe('auto')
  })

  it('gap auto restores a pre-existing inline gap instead of destroying it', () => {
    const { el, panel, drafts } = flexSetup('gap: 16px;')
    commit(fieldInput(panel, 'Gap'), '24')
    expect(drafts.current(el, 'gap')).toBe('24px')
    commit(fieldInput(panel, 'Gap'), 'auto')
    expect(drafts.current(el, 'justify-content')).toBe('space-between')
    expect(drafts.current(el, 'gap')).toBeNull()
    expect(el.style.getPropertyValue('gap')).toBe('16px')
  })

  it('default flex container (computed justify/align normal or empty) shows an active dot at flex-start/flex-start', () => {
    // flexSetup() sets only `display: flex` — no justify-content/align-items authored.
    // jsdom's getComputedStyle reports '' for these (real browsers report 'normal'); both
    // must normalize to flex-start so the matrix isn't stuck with zero active dots.
    const { panel } = flexSetup()
    const active = panel.root.querySelector('.am-dot.am-active') as HTMLElement
    expect(active).toBeTruthy()
    expect(active.dataset.j).toBe('flex-start')
    expect(active.dataset.a).toBe('flex-start')
  })

  it('space-between with no explicit align-items shows active dot in 3-dot space-between mode with flex-start align', () => {
    const { panel } = flexSetup('justify-content: space-between;')
    const dots = [...panel.root.querySelectorAll('.am-dot')] as HTMLElement[]
    expect(dots).toHaveLength(3)
    const active = panel.root.querySelector('.am-dot.am-active') as HTMLElement
    expect(active).toBeTruthy()
    expect(active.dataset.a).toBe('flex-start')
  })

  it('explicit align-items: stretch shows no active dot (stretch is represented via Fill, not a matrix position)', () => {
    const { panel } = flexSetup('align-items: stretch;')
    const active = panel.root.querySelector('.am-dot.am-active')
    expect(active).toBeNull()
  })

  it('align matrix click drafts justify-content and align-items', () => {
    const { el, panel, drafts } = flexSetup()
    const dot = panel.root.querySelector('.am-dot') as HTMLElement
    dot.click()
    expect(drafts.current(el, 'justify-content')).not.toBeNull()
    expect(drafts.current(el, 'align-items')).not.toBeNull()
  })

  it('align matrix re-maps when direction changes', () => {
    const { panel, el, drafts } = flexSetup()
    // click flex-end/flex-start dot in row mode
    const dot = [...panel.root.querySelectorAll('.am-dot')].find(
      (d) => (d as HTMLElement).dataset.j === 'flex-end' && (d as HTMLElement).dataset.a === 'flex-start'
    ) as HTMLElement
    dot.click()
    expect(drafts.current(el, 'justify-content')).toBe('flex-end')
    expect(drafts.current(el, 'align-items')).toBe('flex-start')

    const seg = [...panel.root.querySelectorAll('.seg-field')].find(
      (n) => n.querySelector('.seg-field-label')?.textContent === 'Direction'
    )!
    const columnBtn = [...seg.querySelectorAll('.seg')].find((b) => b.textContent === 'Column') as HTMLElement
    columnBtn.click()
    // after direction change, the matrix should have re-rendered with column mapping;
    // the physical dot that emitted (flex-end, flex-start) in row mode now emits
    // the transposed pair in column mode.
    const dotAfter = [...panel.root.querySelectorAll('.am-dot')].find(
      (d) => (d as HTMLElement).dataset.j === 'flex-start' && (d as HTMLElement).dataset.a === 'flex-end'
    ) as HTMLElement
    expect(dotAfter).toBeTruthy()
  })

  it('wrap segment field drafts flex-wrap', () => {
    const { el, panel, drafts } = flexSetup()
    const seg = [...panel.root.querySelectorAll('.seg-field')].find(
      (n) => n.querySelector('.seg-field-label')?.textContent === 'Wrap'
    )!
    const wrapBtn = [...seg.querySelectorAll('.seg')].find((b) => b.textContent === 'Wrap') as HTMLElement
    wrapBtn.click()
    expect(drafts.current(el, 'flex-wrap')).toBe('wrap')
  })

  it('flex-child controls are hidden when parent is not flex', () => {
    const { panel } = setup()
    const alignSelf = panel.root.querySelector('[data-align-self]') as HTMLElement
    expect(alignSelf.hidden).toBe(true)
    const modes = [...panel.root.querySelectorAll('.size-mode')] as HTMLElement[]
    expect(modes.length).toBeGreaterThan(0)
    expect(modes.every((m) => m.hidden)).toBe(true)
  })

  function childSetup() {
    document.body.innerHTML = `<div id="parent" style="display: flex; flex-direction: row;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="width: 50px; height: 50px;"></div>
    </div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const panel = new Panel(drafts, onEdited)
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))
    return { el, drafts, panel, onEdited }
  }

  it('flex-child controls appear when parent is flex', () => {
    const { panel } = childSetup()
    const alignSelf = panel.root.querySelector('[data-align-self]') as HTMLElement
    expect(alignSelf.hidden).toBe(false)
    const modes = [...panel.root.querySelectorAll('.size-mode')] as HTMLElement[]
    expect(modes.length).toBeGreaterThan(0)
    expect(modes.every((m) => !m.hidden)).toBe(true)
  })

  it('align-self segment field drafts align-self', () => {
    const { el, panel, drafts } = childSetup()
    const seg = panel.root.querySelector('[data-align-self]')!
    const stretchBtn = [...seg.querySelectorAll('.seg')].find((b) => b.textContent === 'Stretch') as HTMLElement
    stretchBtn.click()
    expect(drafts.current(el, 'align-self')).toBe('stretch')
  })

  it('W size-mode Fill on a row parent drafts flex-grow and flex-basis (main axis)', () => {
    const { el, panel, drafts } = childSetup()
    const wRow = fieldInput(panel, 'W').closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'flex-grow')).toBe('1')
    expect(drafts.current(el, 'flex-basis')).toBe('0%')
  })

  it('H size-mode Fill on a row parent drafts align-self:stretch (cross axis)', () => {
    const { el, panel, drafts } = childSetup()
    const hRow = fieldInput(panel, 'H').closest('.nf')!.parentElement!
    const select = hRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'align-self')).toBe('stretch')
  })

  it('H size-mode Hug drafts height:auto and the field shows auto', () => {
    const { el, panel, drafts } = childSetup()
    const hRow = fieldInput(panel, 'H').closest('.nf')!.parentElement!
    const select = hRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'hug'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'height')).toBe('auto')
    expect(fieldInput(panel, 'H').value).toBe('auto')
  })

  it('W size-mode Fill then Fixed pins width as a px draft and clears flex-grow/flex-basis', () => {
    const { el, panel, drafts } = childSetup()
    const wRow = fieldInput(panel, 'W').closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'flex-grow')).toBe('1')
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'width')).toMatch(/^\d+px$/)
    expect(drafts.current(el, 'flex-grow')).toBeNull()
    expect(drafts.current(el, 'flex-basis')).toBeNull()
  })

  it('W size-mode Fixed sticks on refresh after Fill then Fixed', () => {
    const { panel } = childSetup()
    const wRow = fieldInput(panel, 'W').closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    panel.refresh()
    expect(select.value).toBe('fixed')
  })

  it('H size-mode Hug then Fixed pins height as a px draft, not auto', () => {
    const { el, panel, drafts } = childSetup()
    const hRow = fieldInput(panel, 'H').closest('.nf')!.parentElement!
    const select = hRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'hug'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'height')).toBe('auto')
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'height')).toMatch(/^\d+px$/)
    expect(drafts.current(el, 'height')).not.toBe('auto')
  })

  it('cross-axis Fixed preserves a user-drafted align-self (only discards it when Fill wrote "stretch")', () => {
    const { el, panel, drafts } = childSetup()
    const seg = panel.root.querySelector('[data-align-self]')!
    const startBtn = [...seg.querySelectorAll('.seg')].find((b) => b.textContent === 'Start') as HTMLElement
    startBtn.click()
    expect(drafts.current(el, 'align-self')).toBe('flex-start')

    // Switch H (cross axis on a row parent) to Fixed — must NOT clobber the user's align-self.
    const hRow = fieldInput(panel, 'H').closest('.nf')!.parentElement!
    const select = hRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    expect(drafts.current(el, 'align-self')).toBe('flex-start')
  })

  it('Fixed pins the size the user SEES (computed before mode drafts are discarded)', () => {
    // Set up flex parent with filled child
    document.body.innerHTML = `<div id="parent" style="display: flex; flex-direction: row; width: 400px;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="width: 50px; height: 50px;"></div>
    </div>`
    const parent = document.getElementById('parent')! as HTMLElement
    const child = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const panel = new Panel(drafts, onEdited)
    document.body.appendChild(panel.root)
    panel.show(child, buildInspectorData(child))

    // Apply Fill mode to width (drafts flex-grow: 1, flex-basis: 0%)
    const wRow = fieldInput(panel, 'W').closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    // Stub getComputedStyle to simulate flex layout: while Fill is active, element is 200px;
    // once discarded, it would collapse to 50px
    const realGCS = window.getComputedStyle.bind(window)
    vi.stubGlobal('getComputedStyle', (el: Element) => {
      const cs = realGCS(el)
      if (el === child) {
        const filled = (el as HTMLElement).style.flexGrow === '1'
        return new Proxy(cs, {
          get(t, k) {
            if (k === 'getPropertyValue') {
              return (prop: string) =>
                prop === 'width' ? (filled ? '200px' : '50px') : cs.getPropertyValue(prop)
            }
            return Reflect.get(t, k)
          },
        })
      }
      return cs
    })

    // Switch mode to Fixed: should pin 200px (what user sees), not 50px (post-collapse)
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(child, 'width')).toBe('200px')
  })

  it('Fixed pin bails when the computed size is not finite (no NaN draft)', () => {
    document.body.innerHTML = `<div id="parent" style="display: flex; flex-direction: row; width: 400px;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="width: 50px; height: 50px;"></div>
    </div>`
    const child = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const panel = new Panel(drafts, onEdited)
    document.body.appendChild(panel.root)
    panel.show(child, buildInspectorData(child))

    const realGCS = window.getComputedStyle.bind(window)
    vi.stubGlobal('getComputedStyle', (el: Element) => {
      const cs = realGCS(el)
      if (el === child) {
        return new Proxy(cs, {
          get(t, k) {
            if (k === 'getPropertyValue') {
              return (prop: string) => (prop === 'width' ? 'not-a-size' : cs.getPropertyValue(prop))
            }
            return Reflect.get(t, k)
          },
        })
      }
      return cs
    })

    const wRow = fieldInput(panel, 'W').closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    // Pin bailed out entirely — no NaN draft was written (width draft stays whatever it was, i.e. null)
    expect(drafts.current(child, 'width')).toBeNull()
  })

  it('W/H shows the auto keyword when the element authored inline style="width: auto" (no draft)', () => {
    const { panel } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="width: auto; height: 100px;"></div>`
    )
    expect(fieldInput(panel, 'W').value).toBe('auto')
  })

})

describe('Panel expand-state persistence (B1 nit)', () => {
  // The expand button's title (.panel-section) is followed by TWO .panel-rows siblings:
  // the always-visible rowWrap, then the expandWrap the button toggles. Grab the second one.
  function expandWrapFor(panel: Panel): HTMLElement {
    const title = (panel.root.querySelector('[data-expand="padding"]') as HTMLElement).closest('.panel-section')!
    const rowsWraps = [] as HTMLElement[]
    let sib = title.nextElementSibling as HTMLElement | null
    while (sib && rowsWraps.length < 2) {
      rowsWraps.push(sib)
      sib = sib.nextElementSibling as HTMLElement | null
    }
    return rowsWraps[1]
  }

  it('keeps a section expanded across a second show() call for a different element', () => {
    document.body.innerHTML = `
      <div data-dc-source="src/a.tsx:1:1" id="a" style="padding: 8px;"></div>
      <div data-dc-source="src/b.tsx:1:1" id="b" style="padding: 4px;"></div>
    `
    const a = document.getElementById('a')! as HTMLElement
    const b = document.getElementById('b')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)

    panel.show(a, buildInspectorData(a))
    ;(panel.root.querySelector('[data-expand="padding"]') as HTMLElement).click()
    expect(expandWrapFor(panel).hidden).toBe(false)

    panel.show(b, buildInspectorData(b))
    expect(expandWrapFor(panel).hidden).toBe(false)
  })

  it('defaults to collapsed for a section that was never expanded', () => {
    const { panel } = setup()
    expect(expandWrapFor(panel).hidden).toBe(true)
  })
})

describe('Panel onBeforeEdit pre-hook (M2b Task 4)', () => {
  function setupWithBeforeEdit(html?: string) {
    document.body.innerHTML =
      html ?? `<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px; width: 200px;"></div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const onBeforeEdit = vi.fn()
    const panel = new Panel(drafts, onEdited, onBeforeEdit)
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))
    return { el, drafts, panel, onEdited, onBeforeEdit }
  }

  it('is optional — omitting it does not throw on edit', () => {
    const { panel } = setup()
    expect(() => commit(fieldInput(panel, 'W'), '300')).not.toThrow()
  })

  it('a plain number-field edit calls onBeforeEdit with the element before onEdited', () => {
    const { el, panel, onBeforeEdit, onEdited } = setupWithBeforeEdit()
    commit(fieldInput(panel, 'PX'), '16')
    expect(onBeforeEdit).toHaveBeenCalledWith(el)
    expect(onBeforeEdit.mock.invocationCallOrder[0]).toBeLessThan(onEdited.mock.invocationCallOrder[0])
  })

  it('reset also calls onBeforeEdit before onEdited', () => {
    const { el, panel, onBeforeEdit, onEdited } = setupWithBeforeEdit()
    commit(fieldInput(panel, 'W'), '300')
    onBeforeEdit.mockClear()
    onEdited.mockClear()
    panel.resetButton.click()
    expect(onBeforeEdit).toHaveBeenCalledWith(el)
    expect(onBeforeEdit.mock.invocationCallOrder[0]).toBeLessThan(onEdited.mock.invocationCallOrder[0])
  })

  it('add-auto-layout calls onBeforeEdit before onEdited', () => {
    const { el, panel, onBeforeEdit, onEdited } = setupWithBeforeEdit()
    const btn = panel.root.querySelector('[data-add-layout]') as HTMLElement
    btn.click()
    expect(onBeforeEdit).toHaveBeenCalledWith(el)
    expect(onBeforeEdit.mock.invocationCallOrder[0]).toBeLessThan(onEdited.mock.invocationCallOrder[0])
  })

  it('size-mode select change calls onBeforeEdit before onEdited', () => {
    document.body.innerHTML = `<div id="parent" style="display: flex; flex-direction: row;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="width: 50px; height: 50px;"></div>
    </div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const onBeforeEdit = vi.fn()
    const panel = new Panel(drafts, onEdited, onBeforeEdit)
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))

    const wRow = fieldInput(panel, 'W').closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onBeforeEdit).toHaveBeenCalledWith(el)
    expect(onBeforeEdit.mock.invocationCallOrder[0]).toBeLessThan(onEdited.mock.invocationCallOrder[0])
  })
})

describe('normalizeJustify', () => {
  it('maps normal, start, left, and the jsdom empty string to flex-start', () => {
    expect(normalizeJustify('normal')).toBe('flex-start')
    expect(normalizeJustify('start')).toBe('flex-start')
    expect(normalizeJustify('left')).toBe('flex-start')
    expect(normalizeJustify('')).toBe('flex-start')
  })

  it('maps end and right to flex-end', () => {
    expect(normalizeJustify('end')).toBe('flex-end')
    expect(normalizeJustify('right')).toBe('flex-end')
  })

  it('passes through center and space-between unchanged', () => {
    expect(normalizeJustify('center')).toBe('center')
    expect(normalizeJustify('space-between')).toBe('space-between')
  })
})

describe('normalizeAlign', () => {
  it('maps normal, start, and the jsdom empty string to flex-start', () => {
    expect(normalizeAlign('normal')).toBe('flex-start')
    expect(normalizeAlign('start')).toBe('flex-start')
    expect(normalizeAlign('')).toBe('flex-start')
  })

  it('maps end to flex-end', () => {
    expect(normalizeAlign('end')).toBe('flex-end')
  })

  it('passes through center unchanged', () => {
    expect(normalizeAlign('center')).toBe('center')
  })

  it('does NOT map stretch — it must match no dot in the align matrix', () => {
    const result = normalizeAlign('stretch')
    expect(result).toBe('stretch')
    expect(result).not.toBe('flex-start')
    expect(result).not.toBe('flex-end')
    expect(result).not.toBe('center')
  })
})
