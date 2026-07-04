// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Overlay } from '../../src/client/overlay'
import { DesignMode } from '../../src/client/index'
import { DraftStore } from '../../src/client/drafts'
import { Panel } from '../../src/client/panel'

beforeEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
})

function fullSetup() {
  document.body.innerHTML = `<button data-dc-source="src/Button.tsx:42:8" class="btn">go</button>`
  const overlay = new Overlay()
  overlay.mount()
  const drafts = new DraftStore()
  const panel = new Panel(drafts, () => {})
  overlay.attachPanel(panel.root)
  const mode = new DesignMode(overlay, panel, drafts)
  return { overlay, drafts, panel, mode }
}

describe('DesignMode listener lifecycle (spec §10: zero idle listeners)', () => {
  it('adds no document listeners until activated', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const overlay = new Overlay()
    overlay.mount()
    new DesignMode(overlay)
    expect(addSpy).not.toHaveBeenCalled()
  })

  it('adds capture-phase listeners on activate and removes them on deactivate', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const winAddSpy = vi.spyOn(window, 'addEventListener')
    const winRemoveSpy = vi.spyOn(window, 'removeEventListener')
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)

    mode.setActive(true)
    const added = [...addSpy.mock.calls.map((c) => c[0]), ...winAddSpy.mock.calls.map((c) => c[0])].sort()
    expect(added).toEqual(['click', 'keydown', 'mousemove', 'resize', 'scroll'])
    for (const call of addSpy.mock.calls) {
      if (call[0] === 'scroll') expect(call[2]).toEqual({ capture: true, passive: true })
      else expect(call[2]).toBe(true)
    }
    for (const call of winAddSpy.mock.calls) expect(call[2]).toEqual({ passive: true })

    mode.setActive(false)
    const removed = [...removeSpy.mock.calls.map((c) => c[0]), ...winRemoveSpy.mock.calls.map((c) => c[0])].sort()
    expect(removed).toEqual(['click', 'keydown', 'mousemove', 'resize', 'scroll'])
  })

  it('toggle button flips design mode', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    overlay.toggle.click()
    expect(mode.active).toBe(true)
    overlay.toggle.click()
    expect(mode.active).toBe(false)
  })

  it('Escape deactivates', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    mode.setActive(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(mode.active).toBe(false)
  })

  it('uses the latest mousemove target when events arrive between frames', () => {
    document.body.innerHTML = `<div data-dc-source="src/a.tsx:1:1" id="first"></div><div data-dc-source="src/b.tsx:2:2" id="second"></div>`
    let queued: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queued = cb
      return 1
    })
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    mode.setActive(true)

    const first = document.getElementById('first')!
    const second = document.getElementById('second')!
    const firstRect = vi.spyOn(first, 'getBoundingClientRect')
    const secondRect = vi.spyOn(second, 'getBoundingClientRect')

    first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    queued!(0)

    expect(secondRect).toHaveBeenCalled()
    expect(firstRect).not.toHaveBeenCalled()
  })
})

describe('DesignMode selection (M2)', () => {
  it('click selects: retained element, persistent outline, editable panel', () => {
    const { overlay, mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    const appHandler = vi.fn()
    btn.addEventListener('click', appHandler)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(appHandler).not.toHaveBeenCalled()
    expect(mode.selected).toBe(btn)
    const root = overlay.host.shadowRoot!
    expect((root.getElementById('select-outline') as HTMLElement).hidden).toBe(false)
    expect((root.getElementById('panel') as HTMLElement).hidden).toBe(false)
    expect(root.getElementById('panel')!.textContent).toContain('src/Button.tsx:42:8')
  })

  it('clicking an untagged area deselects', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(mode.selected).toBeNull()
  })

  it('Escape deselects first, exits on second press, and stops propagation', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const appEsc = vi.fn()
    document.body.addEventListener('keydown', appEsc)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mode.selected).toBeNull()
    expect(mode.active).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mode.active).toBe(false)
    expect(appEsc).not.toHaveBeenCalled()
  })

  it('drafts survive deactivation but chrome hides', () => {
    const { mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '20px')
    mode.setActive(false)
    expect(btn.style.getPropertyValue('padding-top')).toBe('20px')
  })

  it('draft changes drive the status strip and compare-all button', () => {
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'width', '100px')
    const status = overlay.host.shadowRoot!.getElementById('status') as HTMLElement
    expect(status.hidden).toBe(false)
    overlay.compareAllButton.click()
    expect(drafts.isComparingAll()).toBe(true)
    overlay.resetAllButton.click()
    expect(drafts.elementCount()).toBe(0)
    expect(status.hidden).toBe(true)
  })
})
