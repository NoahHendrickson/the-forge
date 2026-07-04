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

  it('shows mixed linked values as empty field', () => {
    const { panel } = setup(
      `<div data-dc-source="src/a.tsx:1:1" id="t" style="padding-left: 4px; padding-right: 12px;"></div>`
    )
    expect(fieldInput(panel, 'PX').value).toBe('')
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
    expect(fieldInput(panel, 'PX').value).toBe('') // originals differ → mixed again
  })
})
