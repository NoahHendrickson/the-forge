// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Panel } from '../../src/client/panel'
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

describe('Panel', () => {
  it('shows header with source location and populates fields from computed styles', () => {
    const { panel } = setup()
    expect(panel.root.textContent).toContain('src/Card.tsx:4:7')
    expect(fieldInput(panel, 'W').value).toBe('200')
    expect(fieldInput(panel, 'PX').value).toBe('8')
    expect(fieldInput(panel, 'PY').value).toBe('8')
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
    const titles = [...panel.root.querySelectorAll('.panel-section')].map((n) => n.textContent)
    expect(titles).toEqual(['Layout', 'Size', 'Padding', 'Margin', 'Appearance'])
  })

  it('Layout section is hidden (but still first) for a non-flex element', () => {
    const { panel } = setup()
    const sections = [...panel.root.querySelectorAll('.panel-section')]
    expect(sections[0].textContent).toBe('Layout')
    expect((sections[0] as HTMLElement).hidden).toBe(true)
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

  it('non-flex element shows only the add-auto-layout button in Layout section', () => {
    const { el, panel, drafts } = setup()
    const btn = panel.root.querySelector('[data-add-layout]') as HTMLElement
    expect(btn).toBeTruthy()
    btn.click()
    expect(drafts.current(el, 'display')).toBe('flex')
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

})
